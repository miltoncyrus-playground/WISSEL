import { expect, test } from "bun:test";
import { WriteExecutor } from "../src/executors/write.ts";
import type { CommandResult } from "../src/executors/claude-cli.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "implementer",
  name: "Implementer",
  kind: "agent",
  tier: "write",
  description: "Writes code for a card with clear acceptance criteria.",
  whenToUse: "Card has clear acceptance criteria and needs code written.",
  tags: ["code"],
  executor: "handoff",
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

test("canHandle only accepts write-tier agents", () => {
  const executor = new WriteExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
});

// Added alongside CodexWriteExecutor — that's its territory now, not
// array order in whatever pool they're both registered in.
test("canHandle excludes executor: codex — that's CodexWriteExecutor's territory, not array order", () => {
  const executor = new WriteExecutor();
  expect(executor.canHandle({ ...agent, executor: "codex" })).toBe(false);
});

test("runs claude in acceptEdits mode and parses a successful result", async () => {
  const executor = new WriteExecutor({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }),
      stderr: "",
      exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result).toEqual({ taskId: "t1", agentId: "implementer", ok: true, summary: "shipped" });
});

test("passes cwd, acceptEdits mode, and the task/agent framing into the prompt", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  const executor = new WriteExecutor({
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
  expect(seenCmd[seenCmd.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  const prompt = seenCmd[seenCmd.indexOf("-p") + 1]!;
  expect(prompt).toContain(agent.description);
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
});

test("defaults --model to the routed agent's own costProfile.model", async () => {
  let seenCmd: string[] = [];
  const executor = new WriteExecutor({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent);
  expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe(agent.costProfile.model);
});

test("an explicit constructor model overrides the agent's own costProfile.model", async () => {
  let seenCmd: string[] = [];
  const executor = new WriteExecutor({
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
  const executor = new WriteExecutor({
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

test("appends permission denial count to the summary — e.g. a Bash call acceptEdits doesn't cover", async () => {
  const executor = new WriteExecutor({
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
  const executor = new WriteExecutor({
    runner: stub({ stdout: "", stderr: "command not found: claude", exitCode: 127 }),
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("exited 127");
});

test("a spawn failure (e.g. claude not on PATH) becomes a failed TaskResult, not a throw", async () => {
  const executor = new WriteExecutor({
    runner: async () => {
      throw new Error("ENOENT");
    },
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("failed to spawn claude");
});
