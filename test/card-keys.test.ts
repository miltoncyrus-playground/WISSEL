import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { cardKeyRefusal, validateNewTask, type NewTaskDeps } from "../src/services/task-input.ts";
import { editTask, setTaskPullRequest } from "../src/services/board-actions.ts";
import { carriedCardSettings } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { roundOf, type TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §3.3, phase 1 card 1: a card's short key, its
// round within the review lineage, and the pull request it became.

const SHA = "0123456789abcdef0123456789abcdef01234567";

async function deps(board: SqliteBoard): Promise<NewTaskDeps> {
  const registry = Registry.from([]);
  return { board, registry, router: new Router(registry), harnesses: HarnessPool.from([]), modelsCachePath: "/nonexistent", now: new Date() };
}

describe("storage", () => {
  test("key, round and pr round-trip, and a database from before them heals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-keys-"));
    try {
      const path = join(dir, "b.db");
      const old = new Database(path);
      old.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, labels TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, routedTo TEXT, dependsOn TEXT NOT NULL DEFAULT '[]')");
      old.close();
      const board = new SqliteBoard(path);
      const t = await board.create({ title: "x", body: "", labels: [], repo: "/r", key: "A4", round: 2, pr: { number: 7, url: "https://github.com/o/r/pull/7", head: SHA } });
      expect(await board.get(t.id)).toMatchObject({ key: "A4", round: 2, pr: { number: 7, head: SHA } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("roundOf reads the stored round, else one more than the pushback count", () => {
    expect(roundOf({ round: 3, pushbackCount: 0 })).toBe(3);
    expect(roundOf({ pushbackCount: 2 })).toBe(3);
    expect(roundOf({})).toBe(1);
  });

  test("an escalation retry or pushback carries the key", () => {
    expect(carriedCardSettings({ id: "a", status: "escalated", title: "t", body: "", labels: [], key: "A4" } as TaskCard)).toEqual({ key: "A4" });
  });
});

describe("a key is unique per project among live cards", () => {
  test("a bad key is refused, with what a good one looks like", async () => {
    const board = new SqliteBoard();
    for (const bad of ["", "-A4", "has space", "x".repeat(33), 4]) expect(await cardKeyRefusal(board, bad, "/r")).toContain("such as A4");
  });

  test("a second live card in the same project can't take it; another project, an archived or replaced card don't clash", async () => {
    const board = new SqliteBoard();
    const d = await deps(board);
    const first = await board.create({ title: "first", body: "", labels: [], repo: "/r", key: "A4" });
    const clash = await validateNewTask({ title: "second", body: "", labels: [], repo: "/r", key: "A4" }, d);
    expect(clash).toEqual({ ok: false, error: `key "A4" is already used by "first" (${first.id}) in this project` });
    expect((await validateNewTask({ title: "elsewhere", body: "", labels: [], repo: "/other", key: "A4" }, d)).ok).toBe(true);
    await board.move(first.id, "done");
    await board.archive(first.id);
    expect((await validateNewTask({ title: "again", body: "", labels: [], repo: "/r", key: "A4" }, d)).ok).toBe(true);
    const old = await board.create({ title: "old", body: "", labels: [], repo: "/s", key: "B1" });
    await board.setSupersededBy(old.id, "newer");
    expect((await validateNewTask({ title: "new", body: "", labels: [], repo: "/s", key: "B1" }, d)).ok).toBe(true);
  });

  test("a new card can't set its own round or pull request", async () => {
    const board = new SqliteBoard();
    const check = await validateNewTask({ title: "t", body: "", labels: [], repo: "/r", round: 9, pr: { number: 1, url: "https://x", head: SHA } }, await deps(board));
    expect(check.ok && [check.task.round, check.task.pr]).toEqual([undefined, undefined]);
  });

  test("PATCH sets, keeps and clears a queued card's key; its own lineage never clashes with itself", async () => {
    const board = new SqliteBoard();
    const d = await deps(board);
    const card = await board.create({ title: "t", body: "", labels: [], repo: "/r", key: "A4" });
    const review = await board.create({ title: "Review: t", body: "", labels: ["review"], repo: "/r", key: "A4", reviewLineageId: card.id, parentTaskId: card.id });
    expect(review.key).toBe("A4");
    const renamed = await editTask(board, card, { key: "A5" }, d);
    expect(renamed.ok && renamed.value.key).toBe("A5");
    const sameKey = await editTask(board, (await board.get(card.id))!, { key: "A4" }, d);
    expect(sameKey.ok).toBe(true);
    const cleared = await editTask(board, (await board.get(card.id))!, { key: null }, d);
    expect(cleared.ok && cleared.value.key).toBeUndefined();
    const other = await board.create({ title: "other", body: "", labels: [], repo: "/r" });
    const taken = await editTask(board, other, { key: "A4" }, d);
    expect(taken.ok).toBe(false);
  });
});

describe("POST /tasks/:id/pr", () => {
  test("records a PR with its full head sha, and clears it with null", async () => {
    const board = new SqliteBoard();
    const card = await board.create({ title: "t", body: "", labels: [], repo: "/r" });
    const set = await setTaskPullRequest(board, card, { pr: { number: 12, url: "https://github.com/o/r/pull/12", head: SHA } });
    expect(set.ok && set.value.pr).toEqual({ number: 12, url: "https://github.com/o/r/pull/12", head: SHA });
    expect((await board.get(card.id))!.pr?.number).toBe(12);
    const cleared = await setTaskPullRequest(board, card, { pr: null });
    expect(cleared.ok && cleared.value.pr).toBeUndefined();
  });

  test("refuses a short sha, a non-https url, a bad number or a missing body, saying which", async () => {
    const board = new SqliteBoard();
    const card = await board.create({ title: "t", body: "", labels: [], repo: "/r" });
    const pr = { number: 12, url: "https://github.com/o/r/pull/12", head: SHA };
    const cases: Array<[unknown, string]> = [
      [{ pr: { ...pr, head: SHA.slice(0, 7) } }, "full 40-character"],
      [{ pr: { ...pr, url: "http://x" } }, "https://"],
      [{ pr: { ...pr, number: 0 } }, "positive whole number"],
      [{}, "body needs pr"],
    ];
    for (const [body, words] of cases) {
      const r = await setTaskPullRequest(board, card, body);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain(words);
    }
  });
});
