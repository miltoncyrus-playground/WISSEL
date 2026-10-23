import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { appendTaskOutput } from "../src/services/task-output.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSubagentRuns, settleSubagentRuns, summarizeSubagentRuns } from "../src/services/subagent-runs.ts";

// docs/SDD-subagent-board.md: sub-agents read back from the output JSONL.

const spawn = (id: string, input: Record<string, unknown>, name = "Agent") =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, isError = false) =>
  JSON.stringify({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text: "report" }] }] } });
const inner = (parent: string) =>
  JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: [{ type: "tool_use", id: `t-${Math.random()}`, name: "Read", input: {} }] } });

test("a spawned sub-agent is running until its result arrives, then done", () => {
  const lines = [spawn("a1", { subagent_type: "Explore", description: "List task files", prompt: "x" })];
  expect(parseSubagentRuns(lines)).toEqual([{ id: "a1", type: "Explore", description: "List task files", status: "running", background: false, toolCalls: 0 }]);
  expect(parseSubagentRuns([...lines, inner("a1"), inner("a1"), result("a1")])[0]).toMatchObject({ status: "done", toolCalls: 2 });
  expect(parseSubagentRuns([...lines, result("a1", true)])[0]!.status).toBe("failed");
});

test("two sub-agents in flight at once are both listed, in spawn order", () => {
  const runs = parseSubagentRuns([spawn("a1", { description: "one" }), spawn("a2", { subagent_type: "general-purpose", description: "two" }), result("a2")]);
  expect(runs.map((r) => [r.id, r.type, r.status])).toEqual([["a1", "agent", "running"], ["a2", "general-purpose", "done"]]);
  expect(summarizeSubagentRuns(runs)).toEqual({ total: 2, running: 1, failed: 0 });
});

test("a background spawn stays running past its tool result; the older Task name counts; long descriptions are clipped", () => {
  const runs = parseSubagentRuns([spawn("b1", { description: "bg", run_in_background: true }), result("b1"), spawn("t1", { prompt: "p".repeat(500) }, "Task")]);
  expect(runs[0]).toMatchObject({ background: true, status: "running" });
  expect(runs[1]!.description.length).toBeLessThanOrEqual(160);
});

test("noise is skipped: bad JSON, other tools, stream deltas, and a sub-agent's own nested spawn is not listed twice", () => {
  const runs = parseSubagentRuns([
    "not json",
    JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "z", name: "Agent" } } }),
    JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "r", name: "Read", input: {} }] } }),
    spawn("a1", { description: "real" }),
  ]);
  expect(runs.map((r) => r.id)).toEqual(["a1"]);
});

test("settleSubagentRuns closes whatever never reported back", () => {
  const runs = parseSubagentRuns([spawn("a1", { description: "x" }), spawn("b1", { description: "y", run_in_background: true })]);
  expect(settleSubagentRuns(runs, true).map((r) => r.status)).toEqual(["done", "done"]);
  expect(settleSubagentRuns(runs, false).map((r) => r.status)).toEqual(["failed", "failed"]);
});

test("GET /tasks/:id/subagents: live while running, settled after the result, 404 for an unknown card", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wissel-subagents-"));
  try {
    const board = new SqliteBoard();
    const app = createApp(board, await Registry.load(), undefined, { taskOutputDir: dir });
    const card = await board.create({ title: "t", body: "", labels: ["intake"], repo: "r" });
    await board.move(card.id, "running");
    await appendTaskOutput(card.id, JSON.parse(spawn("a1", { subagent_type: "Explore", description: "scan" })), dir);
    const live = (await (await app(new Request(`http://x/tasks/${card.id}/subagents`))).json()) as { total: number; running: number; runs: { status: string }[] };
    expect(live).toMatchObject({ total: 1, running: 1 });

    await board.recordResult({ taskId: card.id, agentId: "implementer", ok: true, summary: "ok" });
    await board.move(card.id, "pending-review");
    const settled = (await (await app(new Request(`http://x/tasks/${card.id}/subagents`))).json()) as { running: number; runs: { status: string }[] };
    expect(settled.running).toBe(0);
    expect(settled.runs[0]!.status).toBe("done");

    expect((await app(new Request("http://x/tasks/nope/subagents"))).status).toBe(404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
