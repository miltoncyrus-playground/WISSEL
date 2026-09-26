import { expect, test } from "bun:test";
import { computeCost, runCodex, type CommandResult } from "../src/executors/codex-cli.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "implementer",
  name: "Implementer",
  kind: "agent",
  tier: "write",
  description: "Writes code for a card with clear acceptance criteria.",
  whenToUse: "Card has clear acceptance criteria and needs code written.",
  tags: ["code"],
  executor: "codex",
  inputs: ["task-card"],
  outputs: ["diff"],
  trustLevel: "high",
  toolAccess: ["read", "write", "bash"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.6 },
};

const task: TaskCard = {
  id: "t1",
  title: "Build the thing",
  body: "Implement the SDD.",
  labels: ["code"],
  repo: "/tmp",
  status: "dispatched",
};

function stub(result: CommandResult) {
  return async () => result;
}

// The three confirmed-live JSONL payloads from docs/SDD-codex-cli-harness.md
// §6.2 — a clean run, a failed run, and a sandbox-denied write.
const CLEAN_RUN_STDOUT = [
  '{"type":"thread.started","thread_id":"01a0c0a1-195b-7e72-aa97-ffa43a782a8e"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"spike ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":12523,"cached_input_tokens":0,"cache_write_input_tokens":12520,"output_tokens":7,"reasoning_output_tokens":0}}',
].join("\n");

const FAILED_TURN_STDOUT = [
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.1-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: ...)"}',
  '{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: The model `gpt-5.1-codex` does not exist or you do not have access to it., url: ..., cf-ray: ..., request id: ..."}}',
].join("\n");

const SANDBOX_DENIED_WRITE_STDOUT = [
  '{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-spike/ok.txt","kind":"add"}],"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-spike/ok.txt","kind":"add"}],"status":"failed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Couldn’t create `ok.txt`: the environment blocked file writes."}}',
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":20,"reasoning_output_tokens":0}}',
].join("\n");

test("builds `codex exec --json -s <sandbox> \"<prompt>\"`, with -m only when a model is given", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  const runner = async (cmd: string[], opts: { cwd: string }) => {
    seenCmd = cmd;
    seenCwd = opts.cwd;
    return { stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 };
  };

  await runCodex({ runner, task, agent, sandbox: "workspace-write" });

  expect(seenCwd).toBe("/tmp");
  expect(seenCmd[0]).toBe("codex");
  expect(seenCmd[1]).toBe("exec");
  expect(seenCmd).toContain("--json");
  expect(seenCmd).toContain("-s");
  expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("workspace-write");
  expect(seenCmd).not.toContain("-m");
  const prompt = seenCmd.at(-1)!;
  expect(prompt).toContain(agent.description);
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
});

test("pushes -m <model> only when a model is explicitly given — no default model id is ever hardcoded", async () => {
  let seenCmd: string[] = [];
  const runner = async (cmd: string[]) => {
    seenCmd = cmd;
    return { stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 };
  };

  await runCodex({ runner, task, agent, sandbox: "read-only", model: "some-model" });
  expect(seenCmd[seenCmd.indexOf("-m") + 1]).toBe("some-model");
});

test("uses -s read-only for the readonly sandbox and -s workspace-write for the write sandbox", async () => {
  for (const sandbox of ["read-only", "workspace-write"] as const) {
    let seenCmd: string[] = [];
    const runner = async (cmd: string[]) => {
      seenCmd = cmd;
      return { stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 };
    };
    await runCodex({ runner, task, agent, sandbox });
    expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe(sandbox);
  }
});

test("parses a clean run: summary is the last agent_message, ok is true", async () => {
  const result = await runCodex({ runner: stub({ stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 }), task, agent, sandbox: "read-only" });
  expect(result).toEqual({ taskId: "t1", agentId: "implementer", ok: true, summary: "spike ok", actualCost: undefined });
});

test("a failed turn (exit 1, turn.failed, no agent_message) becomes ok: false with the turn.failed error as summary", async () => {
  const result = await runCodex({ runner: stub({ stdout: FAILED_TURN_STDOUT, stderr: "", exitCode: 1 }), task, agent, sandbox: "read-only" });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("404 Not Found");
});

test("a sandbox-denied write leaves exit 0 with no turn.failed, but still reports ok: false via the failed file_change item", async () => {
  const result = await runCodex({
    runner: stub({ stdout: SANDBOX_DENIED_WRITE_STDOUT, stderr: "", exitCode: 0 }),
    task,
    agent,
    sandbox: "workspace-write",
  });
  expect(result.ok).toBe(false);
  // The agent_message that follows the failed item is still the best
  // summary available — the model's own explanation of what happened.
  expect(result.summary).toContain("blocked file writes");
});

test("tolerates a blank/unparseable line in the JSONL stream instead of failing the whole run", async () => {
  const stdoutWithGarbage = [CLEAN_RUN_STDOUT, "", "not json at all", ""].join("\n");
  const result = await runCodex({ runner: stub({ stdout: stdoutWithGarbage, stderr: "", exitCode: 0 }), task, agent, sandbox: "read-only" });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("spike ok");
});

test("a non-zero exit with no recognizable event falls back to stderr/stdout for the summary", async () => {
  const result = await runCodex({ runner: stub({ stdout: "", stderr: "command not found: codex", exitCode: 127 }), task, agent, sandbox: "read-only" });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("command not found");
});

test("a spawn failure (e.g. codex not on PATH) becomes a failed TaskResult, not a throw", async () => {
  const result = await runCodex({
    runner: async () => {
      throw new Error("ENOENT");
    },
    task,
    agent,
    sandbox: "read-only",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("failed to spawn codex");
});

test("computeCost prices all four usage fields, including cache_write_input_tokens", () => {
  const pricing = { "test-model": { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } };
  const usage = { input_tokens: 12523, cached_input_tokens: 0, cache_write_input_tokens: 12520, output_tokens: 7 };

  const cost = computeCost("test-model", usage, pricing);

  const expected = (12523 * 1 + 0 * 0.1 + 12520 * 1.25 + 7 * 5) / 1_000_000;
  expect(cost).toBeCloseTo(expected);
  // Sanity check that the cache-write field is actually load-bearing in
  // the arithmetic, not silently dropped.
  expect(computeCost("test-model", { ...usage, cache_write_input_tokens: 0 }, pricing)).toBeLessThan(cost!);
});

test("computeCost returns undefined for an unknown/unpriced model rather than guessing", () => {
  expect(computeCost("some-future-model", { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 })).toBeUndefined();
  expect(computeCost(undefined, { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 })).toBeUndefined();
  expect(computeCost("test-model", undefined, { "test-model": { input: 1, cachedInput: 1, cacheWrite: 1, output: 1 } })).toBeUndefined();
});

// --- Live task output streaming (docs/SDD-live-task-output.md §3.1) ------
// codex-cli.ts adds no new CLI flags for streaming (codex exec --json
// already emits JSONL natively) — just a read-strategy change, so these
// tests only need to cover onChunk firing correctly, not a command shape.

test("onChunk fires per parsed JSONL line, in order, as a streaming runner delivers them, without changing the final parsed TaskResult", async () => {
  const lines = CLEAN_RUN_STDOUT.split("\n").map((l) => JSON.parse(l));
  const seen: unknown[] = [];
  const streamingRunner = async (_cmd: string[], opts: { onChunk?: (line: unknown) => void }) => {
    for (const l of lines) {
      await Promise.resolve();
      opts.onChunk?.(l);
    }
    return { stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 };
  };

  const result = await runCodex({ runner: streamingRunner, task, agent, sandbox: "read-only", onChunk: (line) => seen.push(line) });

  expect(seen).toEqual(lines);
  expect(result).toEqual({ taskId: "t1", agentId: "implementer", ok: true, summary: "spike ok", actualCost: undefined });
});

test("onChunk omitted never calls the runner's onChunk-dependent path — identical to today's behavior", async () => {
  const result = await runCodex({ runner: stub({ stdout: CLEAN_RUN_STDOUT, stderr: "", exitCode: 0 }), task, agent, sandbox: "read-only" });
  expect(result.summary).toBe("spike ok");
});
