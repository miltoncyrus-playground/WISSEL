import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

function store(): SqliteProjectStore {
  // Shares SqliteBoard's own connection — same reasoning as
  // test/pipelines.test.ts's own `store()` helper: two separate
  // `new Database(":memory:")` instances would be two unrelated,
  // independent in-memory databases, not the same one.
  return new SqliteProjectStore(new SqliteBoard().db);
}

/** Runs real `git` synchronously for one-off test-fixture setup (init a
 *  repo, init a bare repo) — distinct from the `runViaBun` runner passed
 *  into the store methods under test, which is the real async
 *  CommandRunner production code actually uses. */
function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `wissel-projects-${prefix}-`));
}

test("addLocalProject succeeds for a real tmp dir that's already a git repo", async () => {
  const dir = await tmp("local-ok");
  try {
    git(["init", "-q"], dir);
    const projects = store();
    const result = await projects.addLocalProject(dir, {}, runViaBun);
    if ("error" in result) throw new Error(`expected success, got: ${result.error}`);

    expect(result.project.source).toBe("local");
    expect(result.project.path).toBe(dir);
    expect(result.project.sourceUrl).toBeUndefined();
    expect(await projects.list()).toEqual([result.project]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addLocalProject fails when the dir isn't a git repo and initGit is omitted", async () => {
  const dir = await tmp("local-notgit");
  try {
    const projects = store();
    const result = await projects.addLocalProject(dir, {}, runViaBun);

    expect("error" in result).toBe(true);
    expect(await projects.list()).toHaveLength(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addLocalProject with initGit:true runs a real git init and succeeds", async () => {
  const dir = await tmp("local-initgit");
  try {
    const projects = store();
    const result = await projects.addLocalProject(dir, { initGit: true }, runViaBun);
    if ("error" in result) throw new Error(`expected success, got: ${result.error}`);
    expect(result.project.source).toBe("local");

    // Confirm with a second, independent real git call that the dir is
    // now actually a repo — not just that addLocalProject claims it is.
    const check = await runViaBun(["git", "rev-parse", "--is-inside-work-tree"], { cwd: dir });
    expect(check.exitCode).toBe(0);
    expect(check.stdout.trim()).toBe("true");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addLocalProject fails for a path that doesn't exist", async () => {
  const projects = store();
  const result = await projects.addLocalProject(join(tmpdir(), "wissel-projects-does-not-exist"), {}, runViaBun);

  expect("error" in result).toBe(true);
  expect(await projects.list()).toHaveLength(0);
});

test("addGithubProject clones a real local bare repo end-to-end via a file:// URL, zero network", async () => {
  const bareDir = await tmp("bare");
  const home = await tmp("clone-home");
  try {
    git(["init", "-q", "--bare"], bareDir);
    const projects = store();
    const url = `file://${bareDir}`;
    const result = await projects.addGithubProject(url, {}, runViaBun, home);
    if ("error" in result) throw new Error(`expected success, got: ${result.error}`);

    expect(result.project.source).toBe("github");
    expect(result.project.sourceUrl).toBe(url);
    expect(result.project.path).toBe(join(home, ".wissel", "projects", result.project.id));
    expect(existsSync(join(result.project.path, ".git"))).toBe(true);
    expect(result.alreadyExists).toBeUndefined();
  } finally {
    await rm(bareDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("addGithubProject surfaces a bad-URL error from git's real stderr text, without inserting a row", async () => {
  const home = await tmp("badurl-home");
  try {
    const projects = store();
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "fatal: repository 'nope' not found", exitCode: 128 });

    const result = await projects.addGithubProject("org/does-not-exist", {}, runner, home);

    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("repository 'nope' not found");
    expect(await projects.list()).toHaveLength(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("addGithubProject surfaces an auth-failure error from git's real stderr text", async () => {
  const home = await tmp("auth-home");
  try {
    const projects = store();
    const runner: CommandRunner = async () => ({
      stdout: "",
      stderr: "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      exitCode: 128,
    });

    const result = await projects.addGithubProject("git@github.com:org/private-repo.git", {}, runner, home);

    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("Permission denied (publickey)");
    expect(await projects.list()).toHaveLength(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("addGithubProject is idempotent by normalized sourceUrl — a repeat call skips the clone entirely", async () => {
  const home = await tmp("dedup-home");
  try {
    const projects = store();
    let cloneCalls = 0;
    const runner: CommandRunner = async (cmd) => {
      if (cmd[0] === "git" && cmd[1] === "clone") cloneCalls++;
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const first = await projects.addGithubProject("org/repo", {}, runner, home);
    if ("error" in first) throw new Error(`expected success, got: ${first.error}`);
    expect(first.alreadyExists).toBeUndefined();

    const second = await projects.addGithubProject("org/repo", {}, runner, home);
    if ("error" in second) throw new Error(`expected success, got: ${second.error}`);
    expect(second.alreadyExists).toBe(true);
    expect(second.project.id).toBe(first.project.id);
    expect(second.project.sourceUrl).toBe("https://github.com/org/repo.git");

    expect(cloneCalls).toBe(1);
    expect(await projects.list()).toHaveLength(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("list shows every added project; delete removes only that row and never touches its directory", async () => {
  const dirA = await tmp("round-a");
  const dirB = await tmp("round-b");
  try {
    git(["init", "-q"], dirA);
    git(["init", "-q"], dirB);
    const projects = store();
    const a = await projects.addLocalProject(dirA, {}, runViaBun);
    const b = await projects.addLocalProject(dirB, {}, runViaBun);
    if ("error" in a) throw new Error(`expected success, got: ${a.error}`);
    if ("error" in b) throw new Error(`expected success, got: ${b.error}`);

    expect(
      (await projects.list())
        .map((p) => p.id)
        .sort(),
    ).toEqual([a.project.id, b.project.id].sort());

    await projects.delete(a.project.id);

    const remaining = await projects.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(b.project.id);
    // The permanent design decision: delete() never touches the filesystem.
    expect(existsSync(dirA)).toBe(true);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});
