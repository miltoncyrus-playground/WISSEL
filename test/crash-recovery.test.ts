import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { createApp } from "../src/api/server.ts";
import { reconcileOrphanedTasks } from "../src/core/crash-recovery.ts";
import type { TaskCard } from "../src/core/types.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

// --- reconcileOrphanedTasks: direct unit coverage against a real SqliteBoard ---

test("reconcileOrphanedTasks: a running task is reset to inbox with routedTo cleared", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(created.id, "running");
  // move() doesn't touch routedTo, so set it directly the way sweep() does.
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["implementer", created.id]);

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(1);

  const after = await board.get(created.id);
  expect(after?.status).toBe("inbox");
  expect(after?.routedTo).toBeUndefined();
});

test("reconcileOrphanedTasks: a dispatched task is completely untouched (regression)", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(created.id, "dispatched");
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["integrator", created.id]);

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(0);

  const after = await board.get(created.id);
  expect(after?.status).toBe("dispatched");
  expect(after?.routedTo).toBe("integrator");
});

test("reconcileOrphanedTasks: every other status is untouched — full board distribution, only running tasks reset", async () => {
  const board = new SqliteBoard();
  const statuses: TaskCard["status"][] = [
    "inbox",
    "ready",
    "running",
    "running",
    "dispatched",
    "review",
    "done",
    "failed",
    "escalated",
    "no-match",
    "pending-review",
  ];
  const ids: string[] = [];
  for (const status of statuses) {
    const created = await board.create({ title: status, body: "", labels: [], repo: "r" });
    await board.move(created.id, status);
    ids.push(created.id);
  }

  const before = await board.list();
  const beforeDistribution = before.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => a.id.localeCompare(b.id));

  const count = await reconcileOrphanedTasks(board);
  expect(count).toBe(2);

  const after = await board.list();
  const afterDistribution = after.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => a.id.localeCompare(b.id));

  const expectedDistribution = beforeDistribution.map((t) => (t.status === "running" ? { ...t, status: "inbox" as const } : t));
  expect(afterDistribution).toEqual(expectedDistribution);
});

// --- Integration: the real createApp/startup path, no server process needed ---

test("createApp startup path: a seeded running task is reset to inbox before any request is served", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const running = await board.create({ title: "orphaned", body: "", labels: [], repo: "r" });
  await board.move(running.id, "running");
  const db = (board as SqliteBoard).db;
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["implementer", running.id]);

  const dispatched = await board.create({ title: "handed-off", body: "", labels: [], repo: "r" });
  await board.move(dispatched.id, "dispatched");
  db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", ["integrator", dispatched.id]);

  const app = createApp(board, registry);
  const res = await app(req("/tasks"));
  expect(res.status).toBe(200);
  const tasks = (await res.json()) as TaskCard[];

  const reconciled = tasks.find((t) => t.id === running.id);
  expect(reconciled?.status).toBe("inbox");
  expect(reconciled?.routedTo).toBeUndefined();

  const untouched = tasks.find((t) => t.id === dispatched.id);
  expect(untouched?.status).toBe("dispatched");
  expect(untouched?.routedTo).toBe("integrator");
});
