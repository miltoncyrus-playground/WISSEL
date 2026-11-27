import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { dropSandboxStubs, isSandboxStubPath } from "../src/services/worktree.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

async function repoWith(setup: (dir: string) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-stubs-test-"));
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "t@example.invalid");
  await git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
  writeFileSync(join(dir, ".gitconfig"), ""); // tracked AND empty: never touched
  writeFileSync(join(dir, "a.txt"), "a\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "init");
  setup(dir);
  return dir;
}

test("isSandboxStubPath matches the sandbox's mount points and nothing else", () => {
  for (const p of [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc", ".mcp.json", ".claude/settings.local.json", ".claude/launch.json", ".claude/loop.md", ".claude/scheduled_tasks.json", ".claude/agents/x", ".claude/skills/a/b.md", ".vscode/settings.json", ".idea/workspace.xml"]) {
    expect(isSandboxStubPath(p)).toBe(true);
  }
  for (const p of ["src/.bashrc", "bashrc", ".bashrc.bak", ".claude/settings.json", ".claude/agentsx", "a.txt", ".github/workflows/ci.yml", "docs/.mcp.json"]) {
    expect(isSandboxStubPath(p)).toBe(false);
  }
});

test("dropSandboxStubs removes only untracked, empty sandbox stubs before a merge stages the worktree", async () => {
  const dir = await repoWith((d) => {
    // What the bwrap sandbox leaves behind after an interrupted run: empty mount points.
    for (const f of [".bashrc", ".bash_profile", ".mcp.json", ".gitmodules"]) writeFileSync(join(d, f), "");
    mkdirSync(join(d, ".claude", "agents"), { recursive: true });
    writeFileSync(join(d, ".claude", "settings.local.json"), "");
    mkdirSync(join(d, ".vscode"), { recursive: true });
    writeFileSync(join(d, ".vscode", "settings.json"), "");
    // Real work the agent did, which must survive and be staged.
    writeFileSync(join(d, ".zshrc"), "export REAL=1\n"); // a stub name, but it has content
    mkdirSync(join(d, "src"), { recursive: true });
    writeFileSync(join(d, "src", "new.ts"), "export const x = 1;\n");
    writeFileSync(join(d, "a.txt"), "changed\n");
  });
  try {
    const removed = await dropSandboxStubs(runViaBun, dir);
    expect(removed.sort()).toEqual([".bash_profile", ".bashrc", ".claude/settings.local.json", ".gitmodules", ".mcp.json", ".vscode/settings.json"]);
    for (const f of removed) expect(existsSync(join(dir, f))).toBe(false);
    expect(existsSync(join(dir, ".zshrc"))).toBe(true);
    expect(existsSync(join(dir, ".gitconfig"))).toBe(true);

    await git(dir, "add", "-A");
    const staged = (await git(dir, "diff", "--cached", "--name-only")).trim().split("\n").sort();
    expect(staged).toEqual([".zshrc", "a.txt", "src/new.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("dropSandboxStubs is a no-op on a clean worktree and on a path that is not a repo", async () => {
  const dir = await repoWith(() => {});
  try {
    expect(await dropSandboxStubs(runViaBun, dir)).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const notRepo = await mkdtemp(join(tmpdir(), "wissel-stubs-norepo-"));
  try {
    writeFileSync(join(notRepo, ".bashrc"), "");
    expect(await dropSandboxStubs(runViaBun, notRepo)).toEqual([]);
    expect(existsSync(join(notRepo, ".bashrc"))).toBe(true);
  } finally {
    await rm(notRepo, { recursive: true, force: true });
  }
});
