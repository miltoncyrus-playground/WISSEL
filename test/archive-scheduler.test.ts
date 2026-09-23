import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import {
  AUTO_ARCHIVE_AFTER_HOURS,
  findArchivableRoots,
  runAutoArchiveTick,
  startArchiveScheduler,
} from "../src/core/archive-scheduler.ts";
import type { TaskCard } from "../src/core/types.ts";

function card(overrides: Partial<TaskCard> & Pick<TaskCard, "id">): TaskCard {
  return { title: "t", body: "", labels: [], repo: "r", status: "inbox", ...overrides };
}

/** Backdates a task's doneAt straight in SQLite — move() always stamps
 *  "now", and these tests need a real N-hours-old timestamp to actually
 *  cross the 24h threshold. Opens a second connection onto the same
 *  on-disk file rather than reaching into SqliteBoard's private `db`
 *  field, so this stays a realistic "another writer touched the same
 *  database" scenario, not a test-only backdoor. */
function backdateDoneAt(dbPath: string, taskId: string, isoTimestamp: string): void {
  const db = new Database(dbPath);
  db.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [isoTimestamp, taskId]);
  db.close();
}

// --- findArchivableRoots: pure due-ness check ---

test("findArchivableRoots: a done root exactly at the 24h boundary is included", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const doneAt = new Date(now.getTime() - AUTO_ARCHIVE_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const root = card({ id: "root", status: "done", doneAt });
  expect(findArchivableRoots([root], now)).toEqual([root]);
});

test("findArchivableRoots: one hour short of 24h is excluded", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const doneAt = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
  const root = card({ id: "root", status: "done", doneAt });
  expect(findArchivableRoots([root], now)).toEqual([]);
});

test("findArchivableRoots: a non-root done task is never included regardless of age", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const veryOldDoneAt = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30).toISOString();
  const nonRoot = card({ id: "child", status: "done", doneAt: veryOldDoneAt, parentTaskId: "root" });
  expect(findArchivableRoots([nonRoot], now)).toEqual([]);
});

test("findArchivableRoots: an already-archived root is never included", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const doneAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const root = card({ id: "root", status: "done", doneAt, archivedAt: doneAt });
  expect(findArchivableRoots([root], now)).toEqual([]);
});

test("findArchivableRoots: a done root with no doneAt (never actually stamped) is never included", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const root = card({ id: "root", status: "done" });
  expect(findArchivableRoots([root], now)).toEqual([]);
});

test("findArchivableRoots: a root that isn't done yet is never included, however old", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const root = card({ id: "root", status: "review" });
  expect(findArchivableRoots([root], now)).toEqual([]);
});

// --- runAutoArchiveTick: the full list -> find -> cascade cycle ---

test("runAutoArchiveTick: a real done root + a 2-card subtree, doneAt 25h in the past, archives all 3 rows in one tick", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-archive-scheduler-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    const childA = await board.create({ title: "child a", body: "", labels: [], repo: "r", parentTaskId: root.id });
    const childB = await board.create({ title: "child b", body: "", labels: [], repo: "r", parentTaskId: childA.id });
    await board.move(root.id, "done");
    backdateDoneAt(dbPath, root.id, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());

    const archived = await runAutoArchiveTick(board);
    expect(archived.map((t) => t.id).sort()).toEqual([root.id, childA.id, childB.id].sort());

    for (const id of [root.id, childA.id, childB.id]) {
      expect((await board.get(id))!.archivedAt).toBeDefined();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runAutoArchiveTick: no eligible roots does nothing — empty result, nothing archived", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(task.id, "done"); // doneAt is "now" — not yet 24h old

  const archived = await runAutoArchiveTick(board);
  expect(archived).toEqual([]);
  expect((await board.get(task.id))!.archivedAt).toBeUndefined();
});

// --- startArchiveScheduler: off by default, matching every other opt-in flag ---

test("startArchiveScheduler: ticks immediately and archives an eligible root without waiting for the interval", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-archive-scheduler-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    await board.move(root.id, "done");
    backdateDoneAt(dbPath, root.id, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());

    // checkIntervalHours defaults to 1 — irrelevant here, since
    // startArchiveScheduler ticks immediately regardless of interval
    // (see its own doc comment); this test only waits on that first tick.
    const scheduler = startArchiveScheduler({ board });
    try {
      const deadline = Date.now() + 1000;
      let archivedAt: string | undefined;
      while (Date.now() < deadline) {
        archivedAt = (await board.get(root.id))!.archivedAt;
        if (archivedAt) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(archivedAt).toBeDefined();
    } finally {
      scheduler.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
