import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDanglingMerges, resolveReposToCheck } from "../src/services/merge-health.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";

/** Runs real `git` synchronously for one-off test-fixture setup — same
 *  "real git, not a hand-faked fixture" discipline test/projects.test.ts
 *  and test/orchestrator-review-lifecycle.test.ts already hold. The
 *  function under test (`checkDanglingMerges`) itself always gets the
 *  real async `runViaBun` runner, never a scripted fake — this is the
 *  one git-touching area of the codebase where the real on-disk
 *  `.git/MERGE_HEAD` state is the entire point of the test. */
function git(args: string[], cwd: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `wissel-merge-health-${prefix}-`));
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "wissel-test@example.com"], dir);
  git(["config", "user.name", "wissel test"], dir);
}

/**
 * A real, deliberately-left-unresolved merge conflict: `main` and
 * `feature` both edit the same line of `file.txt` differently, then
 * `git merge feature` on `main` conflicts and is never resolved or
 * aborted — exactly the state docs/SDD-crash-recovery.md §3.2 is about
 * detecting (never auto-resolving).
 */
async function conflictedRepo(): Promise<string> {
  const dir = await tmp("conflict");
  initRepo(dir);
  await writeFile(join(dir, "file.txt"), "main line\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "seed"], dir);

  git(["checkout", "-q", "-b", "feature"], dir);
  await writeFile(join(dir, "file.txt"), "feature line\n");
  git(["commit", "-q", "-am", "feature change"], dir);

  git(["checkout", "-q", "main"], dir);
  await writeFile(join(dir, "file.txt"), "main line, changed\n");
  git(["commit", "-q", "-am", "main change"], dir);

  const merge = git(["merge", "feature"], dir);
  if (merge.exitCode === 0) throw new Error("test fixture bug: merge was expected to conflict but succeeded");

  return dir;
}

async function cleanRepo(): Promise<string> {
  const dir = await tmp("clean");
  initRepo(dir);
  git(["commit", "-q", "--allow-empty", "-m", "seed"], dir);
  return dir;
}

test("checkDanglingMerges detects a real, deliberately-unresolved merge conflict", async () => {
  const dir = await conflictedRepo();
  try {
    const result = await checkDanglingMerges([dir], runViaBun);
    expect(result).toEqual([{ repo: dir, branch: "feature" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkDanglingMerges reports nothing for a clean repo with no in-progress merge", async () => {
  const dir = await cleanRepo();
  try {
    const result = await checkDanglingMerges([dir], runViaBun);
    expect(result).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkDanglingMerges reports nothing for a path that isn't a real git working tree", async () => {
  const dir = await tmp("notgit");
  try {
    const result = await checkDanglingMerges([dir], runViaBun);
    expect(result).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A stale registered Project or a task whose repo directory was since
// deleted — `git rev-parse --is-inside-work-tree` run with a cwd that
// doesn't exist at all must fail the "is a real git working tree" check
// cleanly, not throw and take the whole check down with it.
test("checkDanglingMerges reports nothing for a repo path that doesn't exist on disk at all", async () => {
  const result = await checkDanglingMerges(["/tmp/wissel-merge-health-definitely-does-not-exist"], runViaBun);
  expect(result).toEqual([]);
});

// Regression: a nonexistent repo path used to throw synchronously
// (Bun.spawn with a missing cwd), which would silently abort every
// check *after* it in the same batch too — not just its own.
test("checkDanglingMerges keeps checking later repos after a nonexistent one in the same batch", async () => {
  const conflict = await conflictedRepo();
  try {
    const result = await checkDanglingMerges(["/tmp/wissel-merge-health-definitely-does-not-exist", conflict], runViaBun);
    expect(result).toEqual([{ repo: conflict, branch: "feature" }]);
  } finally {
    await rm(conflict, { recursive: true, force: true });
  }
});

test("checkDanglingMerges checks a duplicated repo path only once and still reports it", async () => {
  const dir = await conflictedRepo();
  try {
    const result = await checkDanglingMerges([dir, dir], runViaBun);
    expect(result).toEqual([{ repo: dir, branch: "feature" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkDanglingMerges across a mixed set reports only the dangling one", async () => {
  const conflict = await conflictedRepo();
  const clean = await cleanRepo();
  try {
    const result = await checkDanglingMerges([clean, conflict], runViaBun);
    expect(result).toEqual([{ repo: conflict, branch: "feature" }]);
  } finally {
    await rm(conflict, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});

function boardAndProjects(): { board: SqliteBoard; projects: SqliteProjectStore } {
  const board = new SqliteBoard();
  return { board, projects: new SqliteProjectStore(board.db) };
}

test("resolveReposToCheck unions registered project paths with distinct task repo values, deduped", async () => {
  const { board, projects } = boardAndProjects();
  const projectDir = await tmp("project");
  try {
    const stubRunner = async () => ({ stdout: "true", stderr: "", exitCode: 0 });
    const registered = await projects.addLocalProject(projectDir, {}, stubRunner);
    if ("error" in registered) throw new Error(`fixture setup failed: ${registered.error}`);

    // projectDir is registered AND carried by its own task — must appear
    // only once. "/repo-b" is only ever seen via a task, never
    // registered — still must be checked (the whole point of the union).
    await board.create({ title: "t1", body: "", labels: [], repo: projectDir });
    await board.create({ title: "t2", body: "", labels: [], repo: "/repo-b" });
    await board.create({ title: "t3 (no repo)", body: "", labels: [] });

    const repos = await resolveReposToCheck(board, projects);
    expect(new Set(repos)).toEqual(new Set([projectDir, "/repo-b"]));
  } finally {
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolveReposToCheck returns an empty list when there are no projects and no tasks", async () => {
  const { board, projects } = boardAndProjects();
  expect(await resolveReposToCheck(board, projects)).toEqual([]);
});
