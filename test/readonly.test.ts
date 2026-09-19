import { expect, test } from "bun:test";
import { ReadOnlyExecutor, type CommandResult } from "../src/executors/readonly.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "triager",
  name: "Triager",
  kind: "agent",
  tier: "readonly",
  description: "Turns raw input into a structured task card.",
  whenToUse: "Unstructured input with no labels yet.",
  tags: ["intake"],
  executor: "readonly",
  inputs: ["raw-text"],
  outputs: ["task-card"],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.03 },
};

const task: TaskCard = {
  id: "t1",
  title: "Triage this",
  body: "Some raw input.",
  labels: ["intake"],
  repo: "/tmp",
  status: "ready",
};

function stub(result: CommandResult) {
  return async () => result;
}

test("canHandle only accepts readonly-tier agents", () => {
  const executor = new ReadOnlyExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "write" })).toBe(false);
});

// Real bug found live: both ReadOnlyExecutor and ApiExecutor are
// tier: "readonly" territory, and a pool's executors.find() just
// returns the first match — without this exclusion, ReadOnlyExecutor
// (registered first, in server.ts) always won for an executor: api
// agent, and ApiExecutor never got a chance regardless of intent.
test("canHandle excludes executor: api — that's ApiExecutor's territory, not array order", () => {
  const executor = new ReadOnlyExecutor();
  expect(executor.canHandle({ ...agent, executor: "api" })).toBe(false);
});

test("runs claude in plan mode and parses a successful result", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "pong" }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result).toEqual({ taskId: "t1", agentId: "triager", ok: true, summary: "pong" });
});

test("passes cwd, plan mode, and the task/agent framing into the prompt", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  const executor = new ReadOnlyExecutor({
    runner: async (cmd, opts) => {
      seenCmd = cmd;
      seenCwd = opts.cwd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent);

  expect(seenCwd).toBe("/tmp");
  expect(seenCmd[0]).toBe("claude");
  expect(seenCmd).toContain("--permission-mode");
  expect(seenCmd[seenCmd.indexOf("--permission-mode") + 1]).toBe("plan");
  const prompt = seenCmd[seenCmd.indexOf("-p") + 1]!;
  expect(prompt).toContain(agent.description);
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
});

test("passes --model through when configured", async () => {
  let seenCmd: string[] = [];
  const executor = new ReadOnlyExecutor({
    model: "claude-haiku-4-5-20251001",
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent);
  expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
});

test("surfaces is_error from claude as ok: false", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toBe("boom");
});

test("appends permission denial count to the summary", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [{}] }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result.summary).toBe("done [1 permission denial(s)]");
});

test("a non-zero exit becomes a failed TaskResult, not a throw", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({ stdout: "", stderr: "command not found: claude", exitCode: 127 }),
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("exited 127");
  expect(result.summary).toContain("command not found");
});

test("malformed JSON becomes a failed TaskResult, not a throw", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({ stdout: "not json", stderr: "", exitCode: 0 }),
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("could not parse claude output");
});

test("a spawn failure (e.g. claude not on PATH) becomes a failed TaskResult, not a throw", async () => {
  const executor = new ReadOnlyExecutor({
    runner: async () => {
      throw new Error("ENOENT");
    },
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("failed to spawn claude");
});
