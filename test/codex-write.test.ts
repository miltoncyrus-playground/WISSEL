import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-codex-write-test-"));
}

test("canHandle only accepts write-tier agents with executor: codex", () => {
  const executor = new CodexWriteExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "handoff" })).toBe(false);
});

test("runs codex with the workspace-write sandbox inside an isolated worktree and parses a successful result", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    let seenCwd = "";
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        seenCwd = opts.cwd;
        return {
          stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"shipped"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await executor.run(task, agent);

    expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("workspace-write");
    expect(seenCwd).toBe(join(home, ".wissel", "worktrees", "t1"));
    expect(seenCwd).not.toBe(task.repo);
    expect(result).toEqual({
      taskId: "t1",
      agentId: "implementer",
      ok: true,
      summary: "shipped",
      actualCost: undefined,
      worktree: { path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Real risk this executor's ok computation exists to catch (SDD §6.1/§7.2):
// a sandbox-denied write can leave exit 0 with no turn.failed, visible only
// as a failed file_change item — confirmed live, not hypothetical.
test("a sandbox-denied write is reported as ok: false even though codex itself exits 0", async () => {
  const home = await fakeHome();
  try {
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        return {
          stdout: [
            '{"type":"item.completed","item":{"id":"item_1","type":"file_change","status":"failed"}}',
            '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"blocked"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a worktree creation failure becomes a failed TaskResult without ever calling codex", async () => {
  const home = await fakeHome();
  try {
    let codexCalled = false;
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd[0] === "git") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
        codexCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to create worktree");
    expect(codexCalled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
