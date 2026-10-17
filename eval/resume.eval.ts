#!/usr/bin/env bun
/**
 * Live check that a card a usage limit cut off really resumes its own
 * conversation (docs/proposal-agent-run-efficiency.md item 2): three
 * real `claude -p` calls through runClaude and runViaBun, on the private
 * `claude` harness, in a scratch directory.
 *
 *   1. A fresh run of a task whose answer is a code word only its prompt
 *      contains. Must succeed and hand back a session id.
 *   2. The same card with `resumeSessionId` set. The prompt is now only
 *      RESUME_PROMPT, which doesn't contain the word, so the answer can
 *      only come from the resumed conversation. Must be marked resumed,
 *      keep the session id, and answer with the word.
 *   3. A session id claude doesn't have. Must fall back to a fresh run
 *      (not marked resumed) and still answer with the word.
 *
 * A real 429 can't be produced on demand; the 429 side (session id kept
 * from real captured stdout) is eval:claude-cli-429-replay. Uses Haiku:
 * this measures the resume plumbing, not answer quality. About $0.18
 * (measured 2026-10-11; mostly Claude Code's own system prompt).
 * Exits 2 without spending when the `claude` harness is off.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalHarnessPool } from "./eval-harness.ts";
import type { AgentDef, TaskCard, TaskResult } from "../src/core/types.ts";
import { runClaude, runViaBun } from "../src/executors/claude-cli.ts";

const WORD = "HERON-42";
const agent: AgentDef = {
  id: "resume-probe",
  name: "Resume probe",
  kind: "agent",
  tier: "readonly",
  description: "eval only",
  whenToUse: "never",
  tags: [],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "haiku", estUsdPerTask: 0.02 },
};

export interface Step {
  name: string;
  pass: boolean;
  detail: string;
}

/** The three checks, judged in code from the three results. */
export function judge(fresh: TaskResult, resumed: TaskResult, fallback: TaskResult): Step[] {
  const said = (r: TaskResult) => r.summary.includes(WORD);
  return [
    { name: "fresh run gives a session id", pass: fresh.ok && !!fresh.sessionId && !fresh.resumed, detail: `ok=${fresh.ok} session=${fresh.sessionId ?? "none"}` },
    {
      name: "resume continues the same conversation",
      pass: resumed.ok && resumed.resumed === true && resumed.sessionId === fresh.sessionId && said(resumed),
      detail: `ok=${resumed.ok} resumed=${resumed.resumed ?? false} session=${resumed.sessionId ?? "none"} answer=${JSON.stringify(resumed.summary.slice(0, 60))}`,
    },
    {
      name: "missing session falls back to a fresh run",
      pass: fallback.ok && fallback.resumed === undefined && said(fallback),
      detail: `ok=${fallback.ok} resumed=${fallback.resumed ?? false} answer=${JSON.stringify(fallback.summary.slice(0, 60))}`,
    },
  ];
}

if (import.meta.main) {
  const pool = await evalHarnessPool(null);
  const harness = pool.acquire("claude-cli", undefined, ["claude"]);
  if (!harness) {
    console.error("SKIP: the private `claude` harness is missing or disabled. Nothing was spent.");
    process.exit(2);
  }
  const dir = await mkdtemp(join(tmpdir(), "wissel-eval-resume-"));
  const task: TaskCard = { id: "resume-eval", title: "Code word", body: `Your final answer must be the code word ${WORD} and nothing else. Use no tools.`, labels: [], repo: dir, status: "running" };
  const run = (t: TaskCard) => runClaude({ runner: runViaBun, task: t, agent, permissionMode: "plan", model: "haiku", env: harness.env, memoryPath: join(dir, "no-memory.md") });
  let cost = 0;
  try {
    const fresh = await run(task);
    const resumed = await run({ ...task, resumeSessionId: fresh.sessionId ?? "missing" });
    const fallback = await run({ ...task, resumeSessionId: "00000000-0000-4000-8000-000000000000" });
    cost = [fresh, resumed, fallback].reduce((s, r) => s + (r.actualCost ?? 0), 0);
    const steps = judge(fresh, resumed, fallback);
    for (const s of steps) console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.name}  (${s.detail})`);
    const pass = steps.every((s) => s.pass);
    console.log(`\n${pass ? "PASS" : "FAIL"}: ${steps.filter((s) => s.pass).length}/3, cost $${cost.toFixed(3)}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    pool.release(harness.id);
    await rm(dir, { recursive: true, force: true });
  }
}
