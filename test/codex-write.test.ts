import { expect, test } from "bun:test";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
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

test("canHandle only accepts write-tier agents with executor: codex", () => {
  const executor = new CodexWriteExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "handoff" })).toBe(false);
});

test("runs codex with the workspace-write sandbox and parses a successful result", async () => {
  let seenCmd: string[] = [];
  const executor = new CodexWriteExecutor({
    runner: async (cmd) => {
      seenCmd = cmd;
      return {
        stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"shipped"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const result = await executor.run(task, agent);

  expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("workspace-write");
  expect(result).toEqual({ taskId: "t1", agentId: "implementer", ok: true, summary: "shipped" });
});

// Real risk this executor's ok computation exists to catch (SDD §6.1/§7.2):
// a sandbox-denied write can leave exit 0 with no turn.failed, visible only
// as a failed file_change item — confirmed live, not hypothetical.
test("a sandbox-denied write is reported as ok: false even though codex itself exits 0", async () => {
  const executor = new CodexWriteExecutor({
    runner: async () => ({
      stdout: [
        '{"type":"item.completed","item":{"id":"item_1","type":"file_change","status":"failed"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"blocked"}}',
        '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
});
