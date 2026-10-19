import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTaskWorktree,
  landingCommitMessage,
  linkNodeModules,
  mergeTaskWorktree,
  parseOverwrittenFiles,
  parsePorcelainZ,
  removeTaskWorktree,
} from "../src/services/worktree.ts";
import { parseMergeSubject } from "../src/services/wissel-digest.ts";
import type { TaskCard } from "../src/core/types.ts";

const task: TaskCard = { id: "t1", title: "Build the thing", body: "", labels: [], repo: "/repo", status: "dispatched" };

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

// node_modules symlinking (docs/SDD-pipeline-automation.md follow-up):
// avoids every implementer/reviewer/integrator pass on the same
// subtask paying for its own `bun install` — confirmed live in this
// project's own reviewer output, repeatedly, before this fix.
test("createTaskWorktree symlinks the repo's node_modules into a freshly created worktree", async () => {
  const home = await fakeHome();
  const repo = await mkdtemp(join(tmpdir(), "wissel-worktree-repo-"));
  try {
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "real deps");

    const runner = async (cmd: string[]) => {
      if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd[1] === "worktree" && cmd[2] === "add") {
        // Mimics what a real `git worktree add` does — creates the directory.
        mkdirSync(cmd[5]!, { recursive: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await createTaskWorktree(repo, "t1", { runner, homeDir: home });
    expect("error" in result).toBe(false);
    const worktreePath = (result as { path: string }).path;

    const linkPath = join(worktreePath, "node_modules");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linkPath, "marker.txt"), "utf8")).toBe("real deps");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("createTaskWorktree skips the symlink silently when the repo has no node_modules of its own", async () => {
  const home = await fakeHome();
  const repo = await mkdtemp(join(tmpdir(), "wissel-worktree-repo-"));
  try {
    const runner = async (cmd: string[]) => {
      if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd[1] === "worktree" && cmd[2] === "add") {
        mkdirSync(cmd[5]!, { recursive: true });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const result = await createTaskWorktree(repo, "t1", { runner, homeDir: home });
    expect("error" in result).toBe(false);
    const worktreePath = (result as { path: string }).path;

    expect(existsSync(join(worktreePath, "node_modules"))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});

test("createTaskWorktree never clobbers an existing node_modules already in the worktree (idempotent-reuse case)", async () => {
  const home = await fakeHome();
  const repo = await mkdtemp(join(tmpdir(), "wissel-worktree-repo-"));
  try {
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "marker.txt"), "repo's real deps");

    const path = join(home, ".wissel", "worktrees", "t1");
    // Simulates a worktree that already ran its own `bun install` —
    // a real directory, not a symlink, with its own distinct content.
    mkdirSync(join(path, "node_modules"), { recursive: true });
    writeFileSync(join(path, "node_modules", "marker.txt"), "worktree's own deps");

    const runner = async (cmd: string[]) => {
      if (cmd[1] === "worktree" && cmd[2] === "list") {
        return { stdout: `worktree ${path}\nHEAD abc\nbranch refs/heads/wissel/t1\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await createTaskWorktree(repo, "t1", { runner, homeDir: home });

    expect(lstatSync(join(path, "node_modules")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(path, "node_modules", "marker.txt"), "utf8")).toBe("worktree's own deps");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
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

// The merge path itself (gate, ff-only landing, the lock, the recorded
// sha, every refusal) runs against real git in test/merge-path.test.ts.
// What's left here needs no repo at all.

test("mergeTaskWorktree reports a commit failure instead of merging a half-committed worktree", async () => {
  const runner = async (cmd: string[]) => {
    const key = cmd.join(" ");
    if (key === "git rev-parse -q --verify MERGE_HEAD") return { stdout: "", stderr: "", exitCode: 1 };
    if (key === "git status --porcelain") return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
    if (cmd[0] === "git" && cmd[1] === "add") return { stdout: "", stderr: "", exitCode: 0 };
    if (cmd[1] === "commit") return { stdout: "", stderr: "commit failed: hook rejected", exitCode: 1 };
    throw new Error(`unexpected command reached after commit failure: ${key}`);
  };

  const wt = await fakeHome();
  try {
    const result = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, runner);
    expect(result).toMatchObject({ ok: false, outcome: "error", message: expect.stringContaining("commit failed: hook rejected") });
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test("mergeTaskWorktree answers, never throws, for a worktree that's already gone (a second Merge behind the one that landed it)", async () => {
  const runner = async (cmd: string[]) => {
    throw new Error(`no git should run: ${cmd.join(" ")}`);
  };
  const result = await mergeTaskWorktree("/repo", { path: "/no/such/worktree", branch: "wissel/t1" }, task, runner);
  expect(result).toMatchObject({ ok: false, outcome: "error" });
  expect(result.message).toContain("already merged or discarded");
});

test("mergeTaskWorktree turns a throwing runner into an error outcome, still recording telemetry", async () => {
  const wt = await fakeHome();
  const events: unknown[] = [];
  try {
    const result = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, {
      runner: async () => {
        throw new Error("ENOENT: repo is gone");
      },
      telemetry: { record: async (e) => void events.push(e) },
    });
    expect(result).toMatchObject({ ok: false, outcome: "error", message: "merge failed: ENOENT: repo is gone" });
    expect(events).toEqual([expect.objectContaining({ type: "merge", outcome: "error" })]);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

/** A runner for a worktree mid-merge: MERGE_HEAD present, `f.txt`
 *  unmerged and changed. Reads answer; any write throws. */
function midMergeRunner(seen: string[]) {
  return async (cmd: string[]) => {
    const line = cmd.join(" ");
    seen.push(line);
    if (line === "git rev-parse -q --verify MERGE_HEAD") return { stdout: "abc\n", stderr: "", exitCode: 0 };
    if (line === "git ls-files -u -z") return { stdout: ["100644 aaa 1\tf.txt", "100644 bbb 2\tf.txt", "100644 ccc 3\tf.txt", ""].join("\0"), stderr: "", exitCode: 0 };
    if (line === "git diff --name-only --no-renames -z HEAD") return { stdout: "f.txt\0", stderr: "", exitCode: 0 };
    throw new Error(`unexpected command while refusing an unfinished merge: ${line}`);
  };
}

test("mergeTaskWorktree refuses a worktree with an unfinished merge whose file still has conflict markers, naming the file and lines, and never runs git add/commit", async () => {
  const seen: string[] = [];
  const wt = await fakeHome();
  try {
    writeFileSync(join(wt, "f.txt"), "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> abc\nz\n");
    const result = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, { runner: midMergeRunner(seen), conflictIntegrator: async () => ({ finished: true, cardId: "int-1" }) });
    // conflictHead is the worktree's MERGE_HEAD: the HEAD this conflict was against.
    expect(result).toMatchObject({ ok: false, outcome: "conflict", conflictHead: "abc" });
    expect(result.message).toContain(`${wt} has an unfinished merge of /repo's HEAD (abc) into wissel/t1: conflict markers are still in f.txt:2,4,6`);
    expect(seen).toEqual(["git rev-parse -q --verify MERGE_HEAD", "git ls-files -u -z", "git diff --name-only --no-renames -z HEAD"]);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test("mergeTaskWorktree refuses a resolved but unfinished merge when the integrator hasn't finished, or when there's no board to ask", async () => {
  const wt = await fakeHome();
  try {
    writeFileSync(join(wt, "f.txt"), "a\nours\ntheirs\nz\n");
    const seenNotFinished: string[] = [];
    const asked: [string, string][] = [];
    const notFinished = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, {
      runner: midMergeRunner(seenNotFinished),
      conflictIntegrator: async (t, head) => (asked.push([t.id, head]), { finished: false, reason: "the conflict integrator card int-1 is running, not finished (review or done)" }),
    });
    // The board is asked about this conflict: the card and MERGE_HEAD.
    expect(asked).toEqual([[task.id, "abc"]]);
    expect(notFinished).toMatchObject({ ok: false, outcome: "conflict", conflictHead: "abc" });
    expect(notFinished.message).toContain("the conflict integrator card int-1 is running, not finished (review or done)");
    expect(notFinished.message).toContain("git add -A && git commit --no-edit");
    expect(seenNotFinished.some((c) => c.startsWith("git add") || c.startsWith("git commit"))).toBe(false);

    const seenBare: string[] = [];
    const bare = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, midMergeRunner(seenBare));
    expect(bare).toMatchObject({ ok: false, outcome: "conflict" });
    expect(bare.message).toContain("no board to check the conflict integrator against");
    expect(seenBare.some((c) => c.startsWith("git add") || c.startsWith("git commit"))).toBe(false);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test("mergeTaskWorktree finishes a resolved merge with a finished integrator: git add -A, then commit --no-edit --cleanup=strip, then the normal path", async () => {
  const seen: string[] = [];
  const runner = async (cmd: string[]) => {
    const line = cmd.join(" ");
    seen.push(line);
    if (line === "git rev-parse -q --verify MERGE_HEAD") return { stdout: "abc\n", stderr: "", exitCode: 0 };
    if (line === "git ls-files -u -z") return { stdout: "100644 aaa 2\tf.txt\0", stderr: "", exitCode: 0 };
    if (line === "git diff --name-only --no-renames -z HEAD") return { stdout: "f.txt\0", stderr: "", exitCode: 0 };
    if (line === "git add -A") return { stdout: "", stderr: "", exitCode: 0 };
    if (line === "git commit --no-edit --cleanup=strip") return { stdout: "", stderr: "", exitCode: 0 };
    if (line === "git status --porcelain") return { stdout: "", stderr: "", exitCode: 0 };
    // The branch is gone from this fake repo: the normal path stops here
    // with an error, after the finishing commit, which is what's under test.
    return { stdout: "", stderr: "fatal: not a repo", exitCode: 128 };
  };
  const wt = await fakeHome();
  try {
    writeFileSync(join(wt, "f.txt"), "a\nours\ntheirs\nz\n");
    const result = await mergeTaskWorktree("/repo", { path: wt, branch: "wissel/t1" }, task, { runner, conflictIntegrator: async () => ({ finished: true, cardId: "int-1" }) });
    expect(result.outcome).toBe("error");
    expect(seen.slice(0, 6)).toEqual([
      "git rev-parse -q --verify MERGE_HEAD",
      "git ls-files -u -z",
      "git diff --name-only --no-renames -z HEAD",
      "git add -A",
      "git commit --no-edit --cleanup=strip",
      "git status --porcelain",
    ]);
  } finally {
    await rm(wt, { recursive: true, force: true });
  }
});

test("parsePorcelainZ: every path, including both sides of a rename", () => {
  expect(parsePorcelainZ(" M a.txt\0?? new dir/b.txt\0R  new.txt\0old.txt\0 D gone.txt\0")).toEqual(["a.txt", "new dir/b.txt", "new.txt", "old.txt", "gone.txt"]);
  expect(parsePorcelainZ("")).toEqual([]);
});

test("parseOverwrittenFiles: tracked and untracked lists from a refused merge", () => {
  const text = [
    "error: Your local changes to the following files would be overwritten by merge:",
    "\tshared.txt",
    "\tsrc/a.ts",
    "Please commit your changes or stash them before you merge.",
    "error: The following untracked working tree files would be overwritten by merge:",
    "\tnew.txt",
    "Please move or remove them before you merge.",
    "Aborting",
  ].join("\n");
  expect(parseOverwrittenFiles(text)).toEqual(["new.txt", "shared.txt", "src/a.ts"]);
  expect(parseOverwrittenFiles("fatal: Not possible to fast-forward, aborting.")).toEqual([]);
});

test("landingCommitMessage is the exact subject the digest counts by", () => {
  const subject = landingCommitMessage({ path: "/wt/t1", branch: "wissel/t1" }, task);
  expect(subject).toBe("Merge wissel/t1: Build the thing");
  expect(parseMergeSubject(subject)).toEqual({ key: "t1", title: "Build the thing" });
});

test("linkNodeModules links nested packages' node_modules too, never clobbering one already there", async () => {
  const repo = await mkdtemp(join(tmpdir(), "wissel-worktree-repo-"));
  const wt = await mkdtemp(join(tmpdir(), "wissel-worktree-wt-"));
  try {
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    mkdirSync(join(repo, "app", "node_modules", "react"), { recursive: true });
    mkdirSync(join(repo, "editor", "node_modules"), { recursive: true });
    mkdirSync(join(repo, "not-checked-out", "node_modules"), { recursive: true });
    mkdirSync(join(wt, "app"), { recursive: true });
    mkdirSync(join(wt, "editor", "node_modules"), { recursive: true }); // its own install

    linkNodeModules(repo, wt);

    expect(lstatSync(join(wt, "node_modules")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(wt, "app", "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, "app", "node_modules", "react"))).toBe(true);
    expect(lstatSync(join(wt, "editor", "node_modules")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(wt, "not-checked-out"))).toBe(false);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(wt, { recursive: true, force: true });
  }
});
