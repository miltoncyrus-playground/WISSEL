import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { cardChangedPaths, stageCardChanges } from "../src/services/worktree.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function repoWith(setup: (dir: string) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-explicit-staging-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.invalid");
  await git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "gone.txt"), "to be deleted\n");
  writeFileSync(join(dir, "src", "old.ts"), "export const old = 1;\n");
  writeFileSync(join(dir, ".gitconfig"), ""); // tracked AND empty: a card's change to it counts
  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
  setup(dir);
  return dir;
}

async function staged(dir: string): Promise<string[]> {
  return (await git(dir, "diff", "--cached", "--name-status", "-M", "HEAD")).trim().split("\n").filter(Boolean).sort();
}

test("cardChangedPaths lists modified, added, deleted and renamed files, not stubs, ignored files or foreign symlinks", async () => {
  const outside = await mkdtemp(join(tmpdir(), "wissel-explicit-staging-nm-"));
  const dir = await repoWith((d) => {
    writeFileSync(join(d, "a.txt"), "changed\n"); // modified
    writeFileSync(join(d, "src", "new.ts"), "export const x = 1;\n"); // added
    rmSync(join(d, "gone.txt")); // deleted
    renameSync(join(d, "src", "old.ts"), join(d, "src", "renamed.ts")); // renamed on disk
    // Untracked junk: what the bwrap sandbox leaves after an interrupted run.
    for (const f of [".bashrc", ".mcp.json"]) writeFileSync(join(d, f), "");
    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(join(d, ".claude", "settings.local.json"), "");
    writeFileSync(join(d, ".zshrc"), "export REAL=1\n"); // stub name, but the card wrote content
    // Untracked junk: the node_modules link a worktree gets when the repo doesn't ignore it.
    symlinkSync(outside, join(d, "node_modules"), "dir");
    // Gitignored: never a change.
    mkdirSync(join(d, "ignored"), { recursive: true });
    writeFileSync(join(d, "ignored", "cache.bin"), "x");
  });
  try {
    const paths = await cardChangedPaths(runViaBun, dir);
    expect(paths).toEqual([".zshrc", "a.txt", "gone.txt", "src/new.ts", "src/old.ts", "src/renamed.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stageCardChanges stages exactly those paths: a rename and a deletion land, stubs and junk stay out of the index", async () => {
  const outside = await mkdtemp(join(tmpdir(), "wissel-explicit-staging-nm-"));
  const dir = await repoWith((d) => {
    writeFileSync(join(d, "a.txt"), "changed\n");
    writeFileSync(join(d, "src", "new.ts"), "export const x = 1;\n");
    rmSync(join(d, "gone.txt"));
    renameSync(join(d, "src", "old.ts"), join(d, "src", "renamed.ts"));
    writeFileSync(join(d, ".bashrc"), "");
    mkdirSync(join(d, ".claude"), { recursive: true });
    writeFileSync(join(d, ".claude", "settings.local.json"), "");
    symlinkSync(outside, join(d, "node_modules"), "dir");
  });
  try {
    const result = await stageCardChanges(runViaBun, dir);
    expect(result).toEqual({ ok: true, paths: ["a.txt", "gone.txt", "src/new.ts", "src/old.ts", "src/renamed.ts"] });
    expect(await staged(dir)).toEqual(["A\tsrc/new.ts", "D\tgone.txt", "M\ta.txt", "R100\tsrc/old.ts\tsrc/renamed.ts"]);
    // The stubs are still on disk, untouched, and still unstaged.
    expect(existsSync(join(dir, ".bashrc"))).toBe(true);
    const untracked = (await git(dir, "ls-files", "--others", "--exclude-standard")).trim().split("\n").sort();
    expect(untracked).toEqual([".bashrc", ".claude/settings.local.json", "node_modules"]);
    await git(dir, "commit", "-q", "-m", "card");
    expect((await git(dir, "show", "--name-status", "--format=", "-M", "HEAD")).trim().split("\n").sort()).toEqual(["A\tsrc/new.ts", "D\tgone.txt", "M\ta.txt", "R100\tsrc/old.ts\tsrc/renamed.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stageCardChanges handles a rename git already knows about and a tracked stub-named file the card changed", async () => {
  const dir = await repoWith(() => {});
  try {
    await git(dir, "mv", "a.txt", "b.txt"); // already staged: a.txt is now neither on disk nor in the index
    writeFileSync(join(dir, ".gitconfig"), "[user]\n"); // tracked, so a real change even at a stub path
    expect(await cardChangedPaths(runViaBun, dir)).toEqual([".gitconfig", "a.txt", "b.txt"]);
    const result = await stageCardChanges(runViaBun, dir);
    expect(result).toEqual({ ok: true, paths: [".gitconfig", "a.txt", "b.txt"] });
    expect(await staged(dir)).toEqual(["M\t.gitconfig", "R100\ta.txt\tb.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stageCardChanges on a clean tree stages nothing and says so; a path that is not a repo is an error, not a throw", async () => {
  const dir = await repoWith((d) => {
    writeFileSync(join(d, ".bashrc"), ""); // only junk
  });
  try {
    expect(await stageCardChanges(runViaBun, dir)).toEqual({ ok: true, paths: [] });
    expect((await git(dir, "diff", "--cached", "--name-only")).trim()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const notRepo = await mkdtemp(join(tmpdir(), "wissel-explicit-staging-norepo-"));
  try {
    writeFileSync(join(notRepo, "x.txt"), "x");
    const result = await stageCardChanges(runViaBun, notRepo);
    expect(result.ok).toBe(false);
  } finally {
    await rm(notRepo, { recursive: true, force: true });
  }
});
