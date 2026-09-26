#!/usr/bin/env bun
/**
 * Live smoke test for the whole live-task-output pipeline
 * (docs/SDD-live-task-output.md), end to end: a real `claude -p
 * --output-format stream-json --include-partial-messages --verbose`
 * call, its streamed stdout landing in the durable task-output store
 * (src/services/task-output.ts) via ReadOnlyExecutor's real onChunk
 * wiring (exactly the same construction src/api/server.ts uses — see
 * createApp's autoExecutors/manualExecutors), a real HTTP server
 * (Bun.serve, not createApp called directly) so `GET
 * /tasks/:id/output/stream` is exercised as real SSE over a real
 * socket, and the pure render function (renderTaskOutputRows) turning
 * what actually streamed in into human-readable rows.
 *
 * Real cost, real `claude` process — same disclosed-not-executed
 * precedent as eval/readonly.eval.ts and eval/pipeline-review-handoff.eval.ts
 * (see eval/README.md). Not run by `bun test` (gate lane); not run by
 * this implementer session either (real spend requires explicit
 * authorization) — invoke with `bun run eval:live-task-output` before
 * ship / nightly (wired into package.json's scripts alongside the other
 * eval: entries).
 *
 * Pass bar, deliberately content-light (a wording-level "did it say the
 * right thing" check would be flaky — see eval/readonly.eval.ts's own
 * rationale for the same choice):
 *   1. At least one JSONL line was recorded in the durable store before
 *      the run finished — proves streaming actually happened
 *      incrementally, not just a single buffered write after exit.
 *   2. The SSE endpoint delivered at least one line live, over a real
 *      HTTP connection, and closed with `event: done` when the task's
 *      TaskResult landed — proves the whole store -> emitter -> SSE
 *      chain works against a real subprocess's real timing, not just
 *      the synthetic ticked fakes test/api.test.ts uses.
 *   3. The rendered rows (renderTaskOutputRows over the snapshot
 *      endpoint's lines) include exactly one "result" row, ok: true,
 *      whose text contains "pong" — the same trivial, unambiguous
 *      instruction eval/readonly.eval.ts's own first case uses, chosen
 *      here for the same reason: cheap and not gameable by a wording
 *      variation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { getTaskOutput } from "../src/services/task-output.ts";
import { renderTaskOutputRows } from "../src/api/public/render-task-output.js";
import type { TaskCard } from "../src/core/types.ts";

const PORT = 8791;
const PASS_THRESHOLD = 1.0;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<Check[]> {
  const taskOutputDir = await mkdtemp(join(tmpdir(), "wissel-eval-live-output-"));
  const repoDir = await mkdtemp(join(tmpdir(), "wissel-eval-live-output-repo-"));
  const checks: Check[] = [];

  const board = new SqliteBoard();
  const registry = await Registry.load();
  const app = createApp(board, registry, undefined, { taskOutputDir });
  const server = Bun.serve({ port: PORT, fetch: app });

  try {
    const createRes = await fetch(`http://localhost:${PORT}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Reply with exactly the single word: pong", body: "", labels: ["intake"], repo: repoDir }),
    });
    const task = (await createRes.json()) as TaskCard;

    // Opened before the run is triggered, so it's guaranteed to be
    // subscribed before the first chunk can possibly land.
    const sseRes = await fetch(`http://localhost:${PORT}/tasks/${task.id}/output/stream`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let sawLiveChunk = false;
    let sawDone = false;

    const drainSSE = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        // Any `data: ` line other than the leading `: connected` comment
        // is a real streamed JSONL chunk — the `event: done` frame's own
        // `data: {}` line doesn't count (checked separately below via
        // the dedicated "event: done" marker, and its payload is always
        // the literal empty object, never a JSONL agent line).
        if (/\ndata: (?!\{\}\n)/.test(sseBuffer)) sawLiveChunk = true;
        if (sseBuffer.includes("event: done")) {
          sawDone = true;
          break;
        }
      }
    })();

    const runRes = await fetch(`http://localhost:${PORT}/tasks/${task.id}/run`, { method: "POST" });
    checks.push({ name: "POST /tasks/:id/run accepted (202)", pass: runRes.status === 202, detail: `status=${runRes.status}` });

    // Real claude call is in flight now — wait for the SSE stream's own
    // `event: done`, which only fires once finishResult's board.recordResult
    // lands (see taskOutputStream in src/api/server.ts). No polling loop:
    // the SSE connection itself is the completion signal.
    await Promise.race([drainSSE, new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for the real claude run to finish")), 120_000))]);

    checks.push({ name: "SSE delivered at least one live line before closing", pass: sawLiveChunk, detail: `sawLiveChunk=${sawLiveChunk}` });
    checks.push({ name: "SSE closed with event: done when the TaskResult landed", pass: sawDone, detail: `sawDone=${sawDone}` });

    const storedLines = await getTaskOutput(task.id, taskOutputDir);
    checks.push({ name: "at least one JSONL line was durably recorded", pass: storedLines.length > 0, detail: `lines=${storedLines.length}` });

    const snapshotRes = await fetch(`http://localhost:${PORT}/tasks/${task.id}/output`);
    const snapshot = (await snapshotRes.json()) as { taskId: string; lines: string[] };
    const rows = renderTaskOutputRows(snapshot.lines);
    const resultRows = rows.filter((r) => r.kind === "result");
    const pongResult = resultRows.find((r) => r.ok === true && r.text.toLowerCase().includes("pong"));
    checks.push({
      name: 'rendered rows include exactly one ok result row containing "pong"',
      pass: resultRows.length === 1 && !!pongResult,
      detail: `resultRows=${JSON.stringify(resultRows)}`,
    });

    return checks;
  } finally {
    server.stop(true);
    await rm(taskOutputDir, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  }
}

const results = await main();
let passed = 0;
for (const c of results) {
  console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  if (c.pass) passed++;
}
const score = passed / results.length;
console.log(`\n${passed}/${results.length} passed (${(score * 100).toFixed(0)}%), threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
if (score < PASS_THRESHOLD) process.exit(1);
