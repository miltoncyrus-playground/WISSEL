import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteExecutor } from "../src/executors/write.ts";
import type { CommandResult, CommandRunner } from "../src/executors/claude-cli.ts";
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

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-write-executor-test-"));
}

/** Every test here needs the worktree machinery to succeed before it
 *  ever reaches the claude call — this fakes `git worktree add`
 *  (and the idempotency check before it) as always-clean, and routes
 *  every other command to the given claude-result stub. Mirrors the
 *  runner-injection pattern every other executor test already uses;
 *  the worktree step is real plumbing now, not something to bypass. */
function fakeRunner(claudeResult: CommandResult): CommandRunner {
  return async (cmd: string[]) => {
    if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
    return claudeResult;
  };
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

test("runs claude in acceptEdits mode inside an isolated worktree and parses a successful result", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result).toEqual({
      taskId: "t1",
      agentId: "implementer",
      ok: true,
      summary: "shipped",
      worktree: { path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runs claude inside the worktree, not task.repo directly — the whole point of this executor", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    let seenCwd = "";
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        seenCwd = opts.cwd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);

    expect(seenCwd).toBe(join(home, ".wissel", "worktrees", "t1"));
    expect(seenCwd).not.toBe(task.repo);
    expect(seenCmd[0]).toBe("claude");
    expect(seenCmd).toContain("--permission-mode");
    expect(seenCmd[seenCmd.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // The prompt still describes the task itself, not the worktree path
    // it happens to run in — buildAgentPrompt never reads task.repo.
    const prompt = seenCmd[seenCmd.indexOf("-p") + 1]!;
    expect(prompt).toContain(agent.description);
    expect(prompt).toContain(task.title);
    expect(prompt).toContain(task.body);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("defaults --model to the routed agent's own costProfile.model", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe(agent.costProfile.model);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an explicit constructor model overrides the agent's own costProfile.model", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      model: "claude-haiku-4-5-20251001",
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("surfaces is_error from claude as ok: false", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("boom");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("appends permission denial count to the summary — e.g. a Bash call acceptEdits doesn't cover", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [{}] }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result.summary).toBe("done [1 permission denial(s)]");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a non-zero exit from claude becomes a failed TaskResult, not a throw", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({ stdout: "", stderr: "command not found: claude", exitCode: 127 }),
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("exited 127");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a spawn failure (e.g. claude not on PATH) becomes a failed TaskResult, not a throw", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("ENOENT");
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to spawn claude");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a worktree creation failure becomes a failed TaskResult without ever calling claude", async () => {
  const home = await fakeHome();
  try {
    let claudeCalled = false;
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd[0] === "git") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
        claudeCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to create worktree");
    expect(claudeCalled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
