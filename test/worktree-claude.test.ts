import { expect, test } from "bun:test";
import { WorktreeClaudeExecutor, type CommandResult } from "../src/executors/worktree-claude.ts";
import type { WorktreeHandle, WorktreeService } from "../src/services/worktree.ts";
import type { SessionSupervisor, SessionHandle } from "../src/services/session.ts";
import type { Provisioner, ProvisionOptions } from "../src/services/provisioner.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "implementer",
  name: "Implementer",
  tier: "write",
  description: "Writes code in an isolated worktree.",
  whenToUse: "Card has clear acceptance criteria and needs code written.",
  tags: ["code"],
  executor: "worktree-claude",
};

const task: TaskCard = {
  id: "t1",
  title: "Implement the thing",
  body: "Do it.",
  labels: ["code"],
  repo: "/repo",
  status: "ready",
};

const handle: WorktreeHandle = { id: "t1", path: "/worktrees/t1", originRepo: "/repo", branch: "wissel/t1" };

function fakeWorktrees(overrides: Partial<WorktreeService> = {}): WorktreeService {
  return {
    create: async () => handle,
    destroy: async () => {},
    gc: async () => [],
    ...overrides,
  } as WorktreeService;
}

function fakeSessions(): SessionSupervisor {
  return {
    spawn: async (): Promise<SessionHandle> => ({ id: "s1", kind: "tmux", cwd: "/worktrees/t1" }),
    healthy: async () => true,
    kill: async () => {},
  };
}

function fakeProvisioner(overrides: Partial<Provisioner> = {}): Provisioner {
  return { provision: async (_opts: ProvisionOptions) => {}, ...overrides } as Provisioner;
}

function claudeResult(result: CommandResult) {
  return async () => result;
}

test("canHandle only accepts write-tier agents", () => {
  const executor = new WorktreeClaudeExecutor(fakeWorktrees(), fakeSessions(), fakeProvisioner());
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
});

test("creates a worktree, provisions it, runs claude with full permissions, no plan mode", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  let provisioned: unknown;
  const runner = async (cmd: string[], opts: { cwd: string }) => {
    if (cmd[0] === "git" && cmd[1] === "status") return { stdout: "", stderr: "", exitCode: 0 };
    seenCmd = cmd;
    seenCwd = opts.cwd;
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 };
  };
  const executor = new WorktreeClaudeExecutor(
    fakeWorktrees(),
    fakeSessions(),
    fakeProvisioner({ provision: async (opts) => { provisioned = opts; } }),
    { runner },
  );

  const result = await executor.run(task, agent);

  expect(seenCwd).toBe("/worktrees/t1");
  expect(seenCmd).toContain("--dangerously-skip-permissions");
  expect(seenCmd).not.toContain("--permission-mode");
  expect(provisioned).toEqual({ cwd: "/worktrees/t1", originRepo: "/repo", owned: true });
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("done");
  expect(result.artifacts).toEqual(["/worktrees/t1"]);
});

test("commits when claude leaves the worktree dirty", async () => {
  const calls: string[][] = [];
  const runner = async (cmd: string[]) => {
    calls.push(cmd);
    if (cmd[0] === "git" && cmd[1] === "status") return { stdout: " M file.ts\n", stderr: "", exitCode: 0 };
    if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 };
  };
  const executor = new WorktreeClaudeExecutor(fakeWorktrees(), fakeSessions(), fakeProvisioner(), { runner });

  const result = await executor.run(task, agent);

  expect(result.summary).toContain("committed on wissel/t1");
  expect(calls.some((c) => c[0] === "git" && c[1] === "add")).toBe(true);
  expect(calls.some((c) => c[0] === "git" && c[1] === "commit")).toBe(true);
});

test("does not commit when the worktree is clean", async () => {
  const runner = async (cmd: string[]) => {
    if (cmd[0] === "git" && cmd[1] === "status") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 };
  };
  const executor = new WorktreeClaudeExecutor(fakeWorktrees(), fakeSessions(), fakeProvisioner(), { runner });

  const result = await executor.run(task, agent);
  expect(result.summary).toContain("no changes committed on wissel/t1");
});

test("a worktree creation failure becomes a failed TaskResult, not a throw", async () => {
  const executor = new WorktreeClaudeExecutor(
    fakeWorktrees({ create: async () => { throw new Error("not a git repo"); } }),
    fakeSessions(),
    fakeProvisioner(),
  );
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("failed to create worktree");
});

test("a provisioning failure becomes a failed TaskResult, not a throw", async () => {
  const executor = new WorktreeClaudeExecutor(
    fakeWorktrees(),
    fakeSessions(),
    fakeProvisioner({ provision: async () => { throw new Error("bad settings file"); } }),
  );
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("failed to provision worktree");
});

test("a non-zero claude exit becomes a failed TaskResult, not a throw", async () => {
  const executor = new WorktreeClaudeExecutor(fakeWorktrees(), fakeSessions(), fakeProvisioner(), {
    runner: claudeResult({ stdout: "", stderr: "boom", exitCode: 1 }),
  });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("exited 1");
});

test("surfaces is_error from claude as ok: false", async () => {
  const runner = async (cmd: string[]) => {
    if (cmd[0] === "git" && cmd[1] === "status") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }), stderr: "", exitCode: 0 };
  };
  const executor = new WorktreeClaudeExecutor(fakeWorktrees(), fakeSessions(), fakeProvisioner(), { runner });
  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("boom");
});
