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

// Same mutual-exclusion contract, added alongside CodexReadOnlyExecutor.
test("canHandle excludes executor: codex — that's CodexReadOnlyExecutor's territory, not array order", () => {
  const executor = new ReadOnlyExecutor();
  expect(executor.canHandle({ ...agent, executor: "codex" })).toBe(false);
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

// Confirmed live (docs/SDD-subagent-visibility.md §2) — subagent_stats
// is already on the same --output-format json object runClaude has
// always parsed, no format switch needed.
test("surfaces spawned subagents from subagent_stats", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: "done",
        subagent_stats: { spawned: 2, failed: 0, by_type: { "general-purpose": 1, Explore: 1 } },
      }),
      stderr: "", exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result.subagents).toEqual({ count: 2, failed: 0, byType: { "general-purpose": 1, Explore: 1 } });
});

test("omits subagents entirely when spawned is 0 — absence always means nothing to show", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: "done",
        subagent_stats: { spawned: 0, failed: 0, by_type: {} },
      }),
      stderr: "", exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result.subagents).toBeUndefined();
});

test("omits subagents when the response has no subagent_stats field at all (older claude-cli builds)", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 }),
  });
  const result = await executor.run(task, agent);
  expect(result.subagents).toBeUndefined();
});

test("carries a failed subagent count through even when some spawned successfully", async () => {
  const executor = new ReadOnlyExecutor({
    runner: stub({
      stdout: JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: "done",
        subagent_stats: { spawned: 3, failed: 1, by_type: { "general-purpose": 3 } },
      }),
      stderr: "", exitCode: 0,
    }),
  });
  const result = await executor.run(task, agent);
  expect(result.subagents).toEqual({ count: 3, failed: 1, byType: { "general-purpose": 3 } });
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

// Real bug found live: a claude-cli harness's real execution never
// scrubbed ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN the way the
// harness-discovery auth-status probe already did — an ambient
// ANTHROPIC_API_KEY (set for the separate anthropic-api harness) broke
// every real claude-cli run on a machine that also has one configured.
test("always forces ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN empty, with no harness env at all", async () => {
  let seenEnv: Record<string, string> | undefined;
  const executor = new ReadOnlyExecutor({
    runner: async (_cmd, opts) => {
      seenEnv = opts.env;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent);
  expect(seenEnv).toEqual({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" });
});

test("forces the same two vars empty on top of a harness's own env, without dropping the rest of it", async () => {
  let seenEnv: Record<string, string> | undefined;
  const executor = new ReadOnlyExecutor({
    runner: async (_cmd, opts) => {
      seenEnv = opts.env;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent, { id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true, env: { CLAUDE_CONFIG_DIR: "/x" } });
  expect(seenEnv).toEqual({ CLAUDE_CONFIG_DIR: "/x", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" });
});

test("defaults --model to the routed agent's own costProfile.model", async () => {
  let seenCmd: string[] = [];
  const executor = new ReadOnlyExecutor({
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
