import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { dropSandboxStubs, parseStatusPathsZ, stageWorktreeChanges } from "../src/services/worktree.ts";

// docs/SDD-coordinator.md §4.5 step 2, phase 1 card 3: a merge stages a
// card's changes by explicit path, never `git add -A`.

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wissel-staging-"));
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(join(dir, ".gitignore"), "build/\n");
  writeFileSync(join(dir, "keep.txt"), "keep\n");
  writeFileSync(join(dir, "edit.txt"), "before\n");
  writeFileSync(join(dir, "gone.txt"), "bye\n");
  writeFileSync(join(dir, "old-name.txt"), "moved\n");
  git(["add", "--", ".gitignore", "keep.txt", "edit.txt", "gone.txt", "old-name.txt"], dir);
  git(["commit", "-q", "-m", "base"], dir);
  return dir;
}

test("parseStatusPathsZ: each path once, with renames as two entries under --no-renames", () => {
  expect(parseStatusPathsZ(" M a.txt\0D  b.txt\0?? dir/c.txt\0UU d.txt\0 M a.txt\0")).toEqual(["a.txt", "b.txt", "dir/c.txt", "d.txt"]);
  expect(parseStatusPathsZ("")).toEqual([]);
});

test("stages an edit, a deletion, a rename, a new file and a glob-named file by name; leaves ignored files out", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, "edit.txt"), "after\n");
    unlinkSync(join(dir, "gone.txt"));
    renameSync(join(dir, "old-name.txt"), join(dir, "new-name.txt"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "fresh.ts"), "export {};\n");
    writeFileSync(join(dir, "*.txt"), "a file literally named star\n");
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "out.js"), "ignored\n");

    const staged = await stageWorktreeChanges(runViaBun, dir);
    expect(staged.ok).toBe(true);
    expect(staged.ok && [...staged.staged].sort()).toEqual(["*.txt", "edit.txt", "gone.txt", "new-name.txt", "old-name.txt", "src/fresh.ts"]);

    // Everything changed is in the index, nothing else is, and the tree
    // has nothing left unstaged except the ignored build output.
    expect(git(["diff", "--cached", "--name-status", "--no-renames"], dir).trim().split("\n").sort()).toEqual(["A\t*.txt", "A\tnew-name.txt", "A\tsrc/fresh.ts", "D\tgone.txt", "D\told-name.txt", "M\tedit.txt"]);
    expect(git(["diff", "--name-only"], dir).trim()).toBe("");
    expect(git(["ls-files", "--others", "--exclude-standard"], dir).trim()).toBe("");
    expect(git(["ls-files", "--", "build"], dir).trim()).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty sandbox stub dropped first is never staged; a clean tree stages nothing", async () => {
  const dir = repo();
  try {
    writeFileSync(join(dir, ".mcp.json"), "");
    writeFileSync(join(dir, "edit.txt"), "after\n");
    expect(await dropSandboxStubs(runViaBun, dir)).toEqual([".mcp.json"]);
    const staged = await stageWorktreeChanges(runViaBun, dir);
    expect(staged.ok && staged.staged).toEqual(["edit.txt"]);
    git(["commit", "-q", "-m", "x"], dir);
    const none = await stageWorktreeChanges(runViaBun, dir);
    expect(none.ok && none.staged).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change of more than one batch of paths is staged in full", async () => {
  const dir = repo();
  try {
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 450; i++) writeFileSync(join(dir, "many", `f${i}.txt`), `${i}\n`);
    const staged = await stageWorktreeChanges(runViaBun, dir);
    expect(staged.ok && staged.staged.length).toBe(450);
    expect(git(["diff", "--cached", "--name-only"], dir).trim().split("\n")).toHaveLength(450);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
