import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskWorktree, mergeTaskWorktree, validateMergeTarget } from "../src/services/worktree.ts";
import { autoMergeAllowed, autoMergeSwitchOn, carriedCardSettings } from "../src/core/orchestrator.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { TaskCard } from "../src/core/types.ts";

// A real git runner: these tests land real commits in throwaway repos,
// because the point is where a merge puts the branch, not what we say to git.
const runner: CommandRunner = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runner(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

async function makeRepo(): Promise<{ repo: string; home: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "wissel-merge-target-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  await git(root, "init", "-q", "-b", "main", repo);
  // Wissel's own `git commit` in the worktree uses the repo's config.
  await git(repo, "config", "user.name", "t");
  await git(repo, "config", "user.email", "t@example.com");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "first");
  return { repo, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function card(over: Partial<TaskCard> = {}): TaskCard {
  return { id: "t1", title: "Spec for ABC-940", body: "", labels: [], repo: "/repo", status: "dispatched", ...over };
}

test("validateMergeTarget: none, a good branch, and what must be refused", () => {
  expect(validateMergeTarget(undefined)).toEqual({ ok: true });
  expect(validateMergeTarget("")).toEqual({ ok: true });
  expect(validateMergeTarget("  ")).toEqual({ ok: true });
  expect(validateMergeTarget("spec/ABC-940-spec")).toEqual({ ok: true, target: "spec/ABC-940-spec" });
  for (const bad of ["-rf", "a..b", "a b", "a//b", "a/", "x.lock", "HEAD", "refs/heads/x", "a@{1}", "$(id)", "a;b", "/abs", ".hidden/x"]) {
    expect(validateMergeTarget(bad).ok).toBe(false);
  }
  expect(validateMergeTarget(5).ok).toBe(false);
  expect(validateMergeTarget("x".repeat(101)).ok).toBe(false);
});

test("createTaskWorktree without a baseRef still branches off HEAD, byte for byte as before", async () => {
  const seen: string[][] = [];
  const fake: CommandRunner = async (cmd) => {
    seen.push(cmd);
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const home = await mkdtemp(join(tmpdir(), "wissel-merge-target-home-"));
  try {
    await createTaskWorktree("/repo", "t1", { runner: fake, homeDir: home });
    expect(seen.at(-1)).toEqual(["git", "worktree", "add", "-b", "wissel/t1", join(home, ".wissel", "worktrees", "t1"), "HEAD"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a card with a mergeTarget builds on that branch (made from main) and lands there, leaving the checked-out branch alone", async () => {
  const { repo, home, cleanup } = await makeRepo();
  try {
    // The repo sits on some other branch with its own commit: this is the
    // case that used to send the work to the wrong place.
    await git(repo, "checkout", "-q", "-b", "other");
    await writeFile(join(repo, "other.txt"), "x\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "other work");
    const otherTip = await git(repo, "rev-parse", "HEAD");
    const mainTip = await git(repo, "rev-parse", "main");

    const wt = await createTaskWorktree(repo, "t1", { runner, homeDir: home, baseRef: "spec/x" });
    expect("error" in wt).toBe(false);
    if ("error" in wt) return;
    // The target was created from main, not from the checked-out `other`.
    expect(await git(repo, "rev-parse", "spec/x")).toBe(mainTip);
    expect(existsSync(join(wt.path, "other.txt"))).toBe(false);

    await writeFile(join(wt.path, "spec.md"), "the spec\n");
    const landed: string[] = [];
    const res = await mergeTaskWorktree(repo, wt, card({ mergeTarget: "spec/x" }), runner, async (sha) => {
      landed.push(sha);
    });

    expect(res.ok).toBe(true);
    expect(res.outcome).toBe("landed");
    expect(res.message).toContain("spec/x");
    // The target moved to the landing commit and contains the work.
    expect(await git(repo, "rev-parse", "spec/x")).toBe(res.mergedSha!);
    expect(landed).toEqual([res.mergedSha!]);
    expect(await git(repo, "show", "spec/x:spec.md")).toBe("the spec");
    // The checked-out branch, its commit and its working tree are untouched.
    expect(await git(repo, "branch", "--show-current")).toBe("other");
    expect(await git(repo, "rev-parse", "HEAD")).toBe(otherTip);
    expect(existsSync(join(repo, "spec.md"))).toBe(false);
    expect(await git(repo, "status", "--porcelain")).toBe("");
  } finally {
    await cleanup();
  }
});

test("a mergeTarget that is the checked-out branch takes the normal fast-forward and updates the working tree", async () => {
  const { repo, home, cleanup } = await makeRepo();
  try {
    await git(repo, "checkout", "-q", "-b", "spec/y");
    const wt = await createTaskWorktree(repo, "t2", { runner, homeDir: home, baseRef: "spec/y" });
    if ("error" in wt) throw new Error(wt.error);
    await writeFile(join(wt.path, "b.txt"), "two\n");
    const res = await mergeTaskWorktree(repo, wt, card({ id: "t2", mergeTarget: "spec/y" }), runner);
    expect(res.ok).toBe(true);
    expect(await git(repo, "rev-parse", "spec/y")).toBe(res.mergedSha!);
    expect(await git(repo, "rev-parse", "HEAD")).toBe(res.mergedSha!);
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    // main never moved.
    expect(await git(repo, "log", "--format=%s", "main")).toBe("first");
  } finally {
    await cleanup();
  }
});

test("a card without a mergeTarget still lands on the checked-out branch, as before", async () => {
  const { repo, home, cleanup } = await makeRepo();
  try {
    const wt = await createTaskWorktree(repo, "t3", { runner, homeDir: home });
    if ("error" in wt) throw new Error(wt.error);
    await writeFile(join(wt.path, "c.txt"), "three\n");
    const res = await mergeTaskWorktree(repo, wt, card({ id: "t3" }), runner);
    expect(res.ok).toBe(true);
    expect(await git(repo, "rev-parse", "main")).toBe(res.mergedSha!);
    expect(res.message).not.toContain("branch ");
  } finally {
    await cleanup();
  }
});

test("a target branch that moved after the worktree was cut still lands (a new landing commit is built on the new tip)", async () => {
  const { repo, home, cleanup } = await makeRepo();
  try {
    await git(repo, "checkout", "-q", "-b", "other");
    const wt = await createTaskWorktree(repo, "t4", { runner, homeDir: home, baseRef: "spec/z" });
    if ("error" in wt) throw new Error(wt.error);
    // Someone else lands a different file on the target in the meantime.
    const other = join(home, "other-wt");
    await git(repo, "worktree", "add", "-q", other, "spec/z");
    await writeFile(join(other, "side.txt"), "side\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-q", "-m", "side work");
    await git(repo, "worktree", "remove", "--force", other);
    await writeFile(join(wt.path, "mine.txt"), "mine\n");
    const res = await mergeTaskWorktree(repo, wt, card({ id: "t4", mergeTarget: "spec/z" }), runner);
    expect(res.ok).toBe(true);
    expect(await git(repo, "show", "spec/z:side.txt")).toBe("side");
    expect(await git(repo, "show", "spec/z:mine.txt")).toBe("mine");
  } finally {
    await cleanup();
  }
});

test("a missing target branch at merge time is a clear error, not a merge into HEAD", async () => {
  const { repo, home, cleanup } = await makeRepo();
  try {
    const wt = await createTaskWorktree(repo, "t5", { runner, homeDir: home });
    if ("error" in wt) throw new Error(wt.error);
    await writeFile(join(wt.path, "d.txt"), "four\n");
    const res = await mergeTaskWorktree(repo, wt, card({ id: "t5", mergeTarget: "never/created" }), runner);
    expect(res.ok).toBe(false);
    expect(res.outcome).toBe("error");
    expect(res.message).toContain("never/created");
    expect(await git(repo, "log", "--format=%s", "main")).toBe("first");
  } finally {
    await cleanup();
  }
});

test("carriedCardSettings keeps the mergeTarget across a pushback or retry", () => {
  expect(carriedCardSettings(card({ mergeTarget: "spec/x" }))).toMatchObject({ mergeTarget: "spec/x" });
  expect("mergeTarget" in carriedCardSettings(card())).toBe(false);
});

test("WISSEL_AUTO_MERGE=0 turns the reviewer's auto-merge off; unset keeps it", () => {
  const trusted = { autoMerge: true, trustLevel: "high" as const };
  expect(autoMergeSwitchOn({})).toBe(true);
  expect(autoMergeAllowed(trusted, {})).toBe(true);
  for (const off of ["0", "off", "false", "no", " OFF "]) {
    expect(autoMergeSwitchOn({ WISSEL_AUTO_MERGE: off })).toBe(false);
    expect(autoMergeAllowed(trusted, { WISSEL_AUTO_MERGE: off })).toBe(false);
  }
  expect(autoMergeAllowed(trusted, { WISSEL_AUTO_MERGE: "1" })).toBe(true);
  // Never allowed without the agent's own opt-in and high trust.
  expect(autoMergeAllowed({ autoMerge: true, trustLevel: "low" }, {})).toBe(false);
  expect(autoMergeAllowed({ autoMerge: false, trustLevel: "high" }, {})).toBe(false);
  expect(autoMergeAllowed(undefined, {})).toBe(false);
});
