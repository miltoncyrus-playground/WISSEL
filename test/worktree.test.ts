import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskWorktree, mergeTaskWorktree, removeTaskWorktree } from "../src/services/worktree.ts";
import type { CommandResult } from "../src/executors/claude-cli.ts";
import type { TaskCard } from "../src/core/types.ts";

const task: TaskCard = { id: "t1", title: "Build the thing", body: "", labels: [], repo: "/repo", status: "dispatched" };

function fakeGit(responses: Record<string, CommandResult>) {
  return async (cmd: string[], _opts?: { cwd: string; env?: Record<string, string> }) => {
    const key = cmd.join(" ");
    const hit = responses[key];
    if (!hit) throw new Error(`unexpected command: ${key}`);
    return hit;
  };
}

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-worktree-test-"));
}

test("createTaskWorktree creates a worktree on a wissel/<taskId> branch off HEAD", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const runner = async (cmd: string[]) => {
      seenCmd = cmd;
      if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await createTaskWorktree("/repo", "t1", { runner, homeDir: home });

    expect(result).toEqual({ path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" });
    expect(seenCmd).toEqual(["git", "worktree", "add", "-b", "wissel/t1", join(home, ".wissel", "worktrees", "t1"), "HEAD"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("createTaskWorktree is idempotent — reuses an existing worktree instead of erroring on retry", async () => {
  const home = await fakeHome();
  try {
    const path = join(home, ".wissel", "worktrees", "t1");
    let addCalled = false;
    const runner = async (cmd: string[]) => {
      if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/wissel/t1\n`, stderr: "", exitCode: 0 };
      if (cmd[1] === "worktree" && cmd[2] === "add") {
        addCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await createTaskWorktree("/repo", "t1", { runner, homeDir: home });

    expect(result).toEqual({ path, branch: "wissel/t1" });
    expect(addCalled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("createTaskWorktree reports a clear error instead of throwing when git worktree add fails", async () => {
  const home = await fakeHome();
  try {
    const runner = async (cmd: string[]) => {
      if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
    };

    const result = await createTaskWorktree("/repo", "t1", { runner, homeDir: home });

    expect(result).toEqual({ error: expect.stringContaining("fatal: not a git repository") });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("removeTaskWorktree removes the worktree and deletes its branch", async () => {
  const seenCmds: string[][] = [];
  const runner = async (cmd: string[]) => {
    seenCmds.push(cmd);
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  await removeTaskWorktree("/repo", { path: "/wt/t1", branch: "wissel/t1" }, runner);

  expect(seenCmds).toEqual([
    ["git", "worktree", "remove", "--force", "/wt/t1"],
    ["git", "branch", "-D", "wissel/t1"],
  ]);
});

test("mergeTaskWorktree commits uncommitted changes, merges, then removes the worktree", async () => {
  const seenCmds: string[][] = [];
  const runner = fakeGit({
    "git status --porcelain": { stdout: " M file.txt\n", stderr: "", exitCode: 0 },
    "git add -A": { stdout: "", stderr: "", exitCode: 0 },
    "git commit -m Build the thing\n\ntask: t1": { stdout: "", stderr: "", exitCode: 0 },
    "git merge --no-ff wissel/t1 -m Merge wissel/t1: Build the thing": { stdout: "", stderr: "", exitCode: 0 },
    "git worktree remove --force /wt/t1": { stdout: "", stderr: "", exitCode: 0 },
    "git branch -D wissel/t1": { stdout: "", stderr: "", exitCode: 0 },
  });
  const wrapped = async (cmd: string[], opts: { cwd: string }) => {
    seenCmds.push(cmd);
    return runner(cmd, opts);
  };

  const result = await mergeTaskWorktree("/repo", { path: "/wt/t1", branch: "wissel/t1" }, task, wrapped);

  expect(result).toEqual({ ok: true, message: "merged wissel/t1 into /repo" });
  expect(seenCmds).toEqual([
    ["git", "status", "--porcelain"],
    ["git", "add", "-A"],
    ["git", "commit", "-m", "Build the thing\n\ntask: t1"],
    ["git", "merge", "--no-ff", "wissel/t1", "-m", "Merge wissel/t1: Build the thing"],
    ["git", "worktree", "remove", "--force", "/wt/t1"],
    ["git", "branch", "-D", "wissel/t1"],
  ]);
});

test("mergeTaskWorktree skips committing when the worktree is already clean", async () => {
  const seenCmds: string[][] = [];
  const runner = async (cmd: string[]) => {
    seenCmds.push(cmd);
    if (cmd.join(" ") === "git status --porcelain") return { stdout: "", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const result = await mergeTaskWorktree("/repo", { path: "/wt/t1", branch: "wissel/t1" }, task, runner);

  expect(result.ok).toBe(true);
  expect(seenCmds.some((c) => c[0] === "git" && c[1] === "commit")).toBe(false);
});

test("mergeTaskWorktree reports a merge conflict instead of throwing, and never removes the worktree on failure", async () => {
  const seenCmds: string[][] = [];
  const runner = async (cmd: string[]) => {
    seenCmds.push(cmd);
    const key = cmd.join(" ");
    if (key === "git status --porcelain") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd[1] === "merge") return { stdout: "", stderr: "CONFLICT (content): Merge conflict in file.txt", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };

  const result = await mergeTaskWorktree("/repo", { path: "/wt/t1", branch: "wissel/t1" }, task, runner);

  expect(result).toEqual({ ok: false, message: "CONFLICT (content): Merge conflict in file.txt" });
  expect(seenCmds.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(false);
});

test("mergeTaskWorktree reports a commit failure instead of merging a half-committed worktree", async () => {
  const runner = async (cmd: string[]) => {
    const key = cmd.join(" ");
    if (key === "git status --porcelain") return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
    if (cmd[0] === "git" && cmd[1] === "add") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd[1] === "commit") return { stdout: "", stderr: "commit failed: hook rejected", exitCode: 1 };
    throw new Error(`unexpected command reached after commit failure: ${key}`);
  };

  const result = await mergeTaskWorktree("/repo", { path: "/wt/t1", branch: "wissel/t1" }, task, runner);

  expect(result).toEqual({ ok: false, message: expect.stringContaining("commit failed: hook rejected") });
});
