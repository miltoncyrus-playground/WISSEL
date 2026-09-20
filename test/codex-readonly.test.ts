import { expect, test } from "bun:test";
import { CodexReadOnlyExecutor } from "../src/executors/codex-readonly.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "triager",
  name: "Triager",
  kind: "agent",
  tier: "readonly",
  description: "Turns raw input into a structured task card.",
  whenToUse: "Unstructured input with no labels yet.",
  tags: ["intake"],
  executor: "codex",
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

test("canHandle only accepts readonly-tier agents with executor: codex", () => {
  const executor = new CodexReadOnlyExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "write" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "api" })).toBe(false);
});

test("runs codex with the read-only sandbox and parses a successful result", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  const executor = new CodexReadOnlyExecutor({
    runner: async (cmd, opts) => {
      seenCmd = cmd;
      seenCwd = opts.cwd;
      return {
        stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"triaged"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const result = await executor.run(task, agent);

  expect(seenCwd).toBe("/tmp");
  expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("read-only");
  expect(result).toEqual({ taskId: "t1", agentId: "triager", ok: true, summary: "triaged" });
});

test("reports harnessId on the result when a harness was picked", async () => {
  const executor = new CodexReadOnlyExecutor({
    runner: async () => ({
      stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await executor.run(task, agent, { id: "codex-personal", tool: "codex-cli", label: "Codex — personal", enabled: true });
  expect(result.harnessId).toBe("codex-personal");
});
