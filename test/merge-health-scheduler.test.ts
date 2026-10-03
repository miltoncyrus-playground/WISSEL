import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { startMergeHealthScheduler, DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS } from "../src/core/merge-health-scheduler.ts";
import { DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS } from "../src/core/archive-scheduler.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";

function git(args: string[], cwd: string): { exitCode: number } {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode };
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `wissel-merge-health-scheduler-${prefix}-`));
}

/** Same real, deliberately-unresolved-conflict fixture as
 *  test/merge-health.test.ts — the scheduler test needs real on-disk
 *  git state too, since it's exercising the exact same detection through
 *  one more layer (repo resolution + the setInterval wiring), not a
 *  reason to fall back to a scripted fake. */
async function conflictedRepo(): Promise<string> {
  const dir = await tmp("conflict");
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "wissel-test@example.com"], dir);
  git(["config", "user.name", "wissel test"], dir);
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

async function pollUntil<T>(fn: () => T, predicate: (v: T) => boolean, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = fn();
  while (Date.now() < deadline) {
    last = fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 10));
  }
  return last;
}

test("DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS matches archive-scheduler's own default, by reference not by coincidence", () => {
  expect(DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS).toBe(DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS);
});

test("startMergeHealthScheduler ticks immediately at startup and caches the detected set for getLast()", async () => {
  const repo = await conflictedRepo();
  try {
    const board = new SqliteBoard();
    const projects = new SqliteProjectStore(board.db);
    await board.create({ title: "t1", body: "", labels: [], repo });

    const scheduler = startMergeHealthScheduler({ board, projects, runner: runViaBun, checkIntervalHours: 24 });
    try {
      const last = await pollUntil(() => scheduler.getLast(), (v) => v.length > 0);
      expect(last).toEqual([{ repo, branch: "feature" }]);
    } finally {
      scheduler.stop();
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("startMergeHealthScheduler's getLast() reports [] when nothing's registered to check", async () => {
  const board = new SqliteBoard();
  const projects = new SqliteProjectStore(board.db);

  const scheduler = startMergeHealthScheduler({ board, projects, runner: runViaBun, checkIntervalHours: 24 });
  try {
    // No repos to check at all — give the immediate tick a moment to
    // resolve, then confirm it settled on [] rather than never settling.
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.getLast()).toEqual([]);
  } finally {
    scheduler.stop();
  }
});

test("stop() clears the interval — no further ticks run after calling it", async () => {
  const board = new SqliteBoard();
  const projects = new SqliteProjectStore(board.db);
  const scheduler = startMergeHealthScheduler({ board, projects, runner: runViaBun, checkIntervalHours: 24 });
  await new Promise((r) => setTimeout(r, 20));
  scheduler.stop();

  const repo = await conflictedRepo();
  try {
    await board.create({ title: "t1", body: "", labels: [], repo });
    // A real tick would now find the dangling merge; since the
    // scheduler is stopped, getLast() must stay frozen at its
    // pre-stop value ([]), never re-running on its own.
    await new Promise((r) => setTimeout(r, 50));
    expect(scheduler.getLast()).toEqual([]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
