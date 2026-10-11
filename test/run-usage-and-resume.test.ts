import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishResult, Orchestrator } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";
import { RESUME_PROMPT, runClaude, runUsageFrom, type CommandResult, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";

// docs/proposal-agent-run-efficiency.md items 1 (token use per run) and
// 2 (resume a session a usage limit cut off instead of starting over).

const agent: AgentDef = {
  id: "plain",
  name: "Plain",
  kind: "agent",
  tier: "readonly",
  description: "d",
  whenToUse: "w",
  tags: [],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-opus-5-5", estUsdPerTask: 0.1 },
};
const task: TaskCard = { id: "t1", title: "Do it", body: "Do the thing.", labels: [], repo: "/tmp", status: "ready" };

// The usage block as claude 2.1.290 prints it (captured live), trimmed.
const USAGE = { input_tokens: 9, cache_creation_input_tokens: 10312, cache_read_input_tokens: 12420, output_tokens: 86, service_tier: "standard" };
const SESSION = "52c4be02-4779-417a-bce6-a19a201fe70a";
const ok = (extra: Record<string, unknown> = {}): CommandResult => ({
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.5, session_id: SESSION, num_turns: 12, usage: USAGE, ...extra }),
  stderr: "",
  exitCode: 0,
});
const limit = (): CommandResult => ({
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 3:10pm (UTC)", total_cost_usd: 2.37, api_error_status: 429, session_id: SESSION, num_turns: 40, usage: USAGE }),
  stderr: "",
  exitCode: 1,
});

/** Answers each call with the next scripted result; records argv and stdin. */
function scripted(results: CommandResult[]) {
  const calls: { cmd: string[]; stdin?: string }[] = [];
  const runner: CommandRunner = async (cmd, opts) => {
    calls.push({ cmd, stdin: opts.stdin });
    const r = results.shift();
    if (!r) throw new Error("runner called more times than scripted");
    return r;
  };
  return { runner, calls };
}

test("runUsageFrom maps claude's usage block and num_turns; absent or junk reads as undefined or 0", () => {
  expect(runUsageFrom({ usage: USAGE, num_turns: 12 })).toEqual({ inputTokens: 9, cacheReadTokens: 12420, cacheWriteTokens: 10312, outputTokens: 86, turns: 12 });
  expect(runUsageFrom({ usage: { output_tokens: 5 } })).toEqual({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 });
  expect(runUsageFrom({})).toBeUndefined();
  expect(runUsageFrom(undefined)).toBeUndefined();
  expect(runUsageFrom({ usage: { input_tokens: "lots" as unknown as number } })!.inputTokens).toBe(0);
});

test("a run's result carries its usage and session id, and is not marked resumed", async () => {
  const { runner, calls } = scripted([ok()]);
  const r = await runClaude({ runner, task, agent, permissionMode: "plan" });
  expect(r.ok).toBe(true);
  expect(r.usage).toEqual({ inputTokens: 9, cacheReadTokens: 12420, cacheWriteTokens: 10312, outputTokens: 86, turns: 12 });
  expect(r.sessionId).toBe(SESSION);
  expect(r.resumed).toBeUndefined();
  expect(calls[0]!.cmd).not.toContain("--resume");
});

test("a 429 result carries the session id to resume and the usage spent so far", async () => {
  const { runner } = scripted([limit()]);
  const r = await runClaude({ runner, task, agent, permissionMode: "plan" });
  expect(r.retryAfter).toBeDefined();
  expect(r.sessionId).toBe(SESSION);
  expect(r.usage!.turns).toBe(40);
  expect(r.actualCost).toBe(2.37);
});

test("a card with resumeSessionId runs claude --resume with the short resume prompt", async () => {
  const { runner, calls } = scripted([ok()]);
  const r = await runClaude({ runner, task: { ...task, resumeSessionId: SESSION }, agent, permissionMode: "plan" });
  expect(calls).toHaveLength(1);
  const cmd = calls[0]!.cmd;
  expect(cmd.slice(cmd.indexOf("--resume"), cmd.indexOf("--resume") + 2)).toEqual(["--resume", SESSION]);
  expect(calls[0]!.stdin).toBe(RESUME_PROMPT);
  expect(r.ok).toBe(true);
  expect(r.resumed).toBe(true);
});

test("a session claude can't find falls back to a fresh run with the full prompt", async () => {
  // claude 2.1.290's real answer to an unknown session id (captured live).
  const missing: CommandResult = { stdout: "", stderr: `No conversation found with session ID: ${SESSION}\n`, exitCode: 1 };
  const { runner, calls } = scripted([missing, ok()]);
  const r = await runClaude({ runner, task: { ...task, resumeSessionId: SESSION }, agent, permissionMode: "plan" });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.cmd).not.toContain("--resume");
  expect(calls[1]!.stdin).toContain("Do the thing.");
  expect(r.ok).toBe(true);
  expect(r.resumed).toBeUndefined();
});

test("a resumed run that fails for another reason is not retried fresh", async () => {
  const { runner, calls } = scripted([{ stdout: "", stderr: "boom", exitCode: 1 }]);
  const r = await runClaude({ runner, task: { ...task, resumeSessionId: SESSION }, agent, permissionMode: "plan" });
  expect(calls).toHaveLength(1);
  expect(r.ok).toBe(false);
  expect(r.summary).toContain("boom");
});

test("finishResult on a 429 stores the session on the card; the next finished run clears it", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([agent]);
  const dir = await mkdtemp(join(tmpdir(), "wissel-usage-test-"));
  try {
    const telemetry = new TelemetryLog(join(dir, "t.jsonl"));
    const card = await board.create({ title: "x", body: "", labels: [] });
    const cut = await runClaude({ runner: scripted([limit()]).runner, task: card, agent, permissionMode: "plan" });
    await finishResult(board, registry, cut, telemetry);
    const waiting = (await board.get(card.id))!;
    expect(waiting.status).toBe("inbox");
    expect(waiting.resumeSessionId).toBe(SESSION);

    const resumed = await runClaude({ runner: scripted([ok()]).runner, task: waiting, agent, permissionMode: "plan" });
    await finishResult(board, registry, resumed, telemetry);
    expect((await board.get(card.id))!.resumeSessionId).toBeUndefined();

    const events = (await readFile(join(dir, "t.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0].usage.turns).toBe(40);
    expect(events[0].retryAfter).toBeDefined();
    expect(events[0].resumed).toBeUndefined();
    expect(events[1].usage.turns).toBe(12);
    expect(events[1].resumed).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a 429 with no session id reschedules without one, so the retry runs fresh", async () => {
  const board = new SqliteBoard();
  const card = await board.create({ title: "x", body: "", labels: [] });
  await finishResult(board, Registry.from([agent]), { taskId: card.id, agentId: agent.id, ok: false, summary: "limit", retryAfter: new Date(Date.now() + 60_000).toISOString() });
  const after = (await board.get(card.id))!;
  expect(after.status).toBe("inbox");
  expect(after.resumeSessionId).toBeUndefined();
});

test("the orchestrator hands the retried card, session and all, to the executor", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const seen: (string | undefined)[] = [];
  const executor: Executor = {
    id: "fake",
    canHandle: (a) => a.tier === "readonly",
    run: async (t, a) => {
      seen.push(t.resumeSessionId);
      return { taskId: t.id, agentId: a.id, ok: true, summary: "x" };
    },
  };
  const card = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await board.scheduleRetry(card.id, new Date(Date.now() - 1000).toISOString(), SESSION);
  await new Orchestrator(board, registry, new Router(registry), [executor]).sweep();
  expect(seen).toEqual([SESSION]);
  expect((await board.get(card.id))!.resumeSessionId).toBeUndefined();
});
