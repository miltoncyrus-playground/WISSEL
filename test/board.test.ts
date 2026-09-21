import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import type { RoutingDecision, TaskResult } from "../src/core/types.ts";

test("create then get round-trips a task", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "b", labels: ["x"], repo: "r" });
  expect(created.status).toBe("inbox");
  expect(created.dependsOn).toEqual([]);

  const fetched = await board.get(created.id);
  expect(fetched).toEqual(created);
});

test("create preserves an explicit dependsOn", async () => {
  const board = new SqliteBoard();
  const a = await board.create({ title: "a", body: "", labels: [], repo: "r" });
  const b = await board.create({ title: "b", body: "", labels: [], repo: "r", dependsOn: [a.id] });
  expect(b.dependsOn).toEqual([a.id]);
  expect((await board.get(b.id))!.dependsOn).toEqual([a.id]);
});

test("create round-trips parentTaskId, and leaves it undefined when omitted", async () => {
  const board = new SqliteBoard();
  const parent = await board.create({ title: "p", body: "", labels: [], repo: "r" });
  const child = await board.create({ title: "c", body: "", labels: [], repo: "r", parentTaskId: parent.id });
  expect(child.parentTaskId).toBe(parent.id);
  expect((await board.get(child.id))!.parentTaskId).toBe(parent.id);
  expect((await board.get(parent.id))!.parentTaskId).toBeUndefined();
});

// Reproduces a real bug found live against a real pre-existing
// ~/.wissel/board.sqlite: `parentTaskId` was added to the tasks table
// in CREATE TABLE IF NOT EXISTS, which only ever applies to a brand
// new database — an on-disk DB created before that column existed had
// no migration guard for it (unlike `harness`, which did), so every
// create() against it failed with "table tasks has no column named
// parentTaskId". Every column added after the original schema needs
// its own ALTER TABLE guard, or exactly this happens again for the
// next one.
test("opens and heals a real pre-existing on-disk DB from before parentTaskId existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        routedTo TEXT,
        dependsOn TEXT NOT NULL DEFAULT '[]'
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
    expect(task.parentTaskId).toBeUndefined();
    expect((await board.get(task.id))!.id).toBe(task.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Same class of bug as above, found immediately after fixing it: a
// pre-existing routing_decisions table from before `confident` existed
// broke recordDecision() the same way — "table routing_decisions has
// no column named confident" — the moment a real board actually tried
// to route a task.
test("opens and heals a real pre-existing on-disk DB from before routing_decisions.confident existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE routing_decisions (
        taskId TEXT NOT NULL,
        matchedTags TEXT NOT NULL,
        candidates TEXT NOT NULL,
        selected TEXT,
        reason TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decidedAt TEXT NOT NULL
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
    const decision: RoutingDecision = {
      taskId: task.id,
      matchedTags: [],
      candidates: [],
      selected: "a",
      confident: true,
      reason: "test",
      strategy: "rule",
      decidedAt: new Date().toISOString(),
    };
    await board.recordDecision(decision);
    expect(await board.getDecision(task.id)).toEqual(decision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setDependencies updates dependsOn, rejects unknown ids, emits an event", async () => {
  const board = new SqliteBoard();
  const events: string[] = [];
  const a = await board.create({ title: "a", body: "", labels: [], repo: "r" });
  const b = await board.create({ title: "b", body: "", labels: [], repo: "r" });
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const updated = await board.setDependencies(b.id, [a.id]);
  expect(updated.dependsOn).toEqual([a.id]);
  expect((await board.get(b.id))!.dependsOn).toEqual([a.id]);
  expect(events).toEqual(["task.dependencies"]);

  await expect(board.setDependencies("nope", [])).rejects.toThrow("task not found");
});

test("setHarness stamps harness on the task, rejects unknown ids, emits an event", async () => {
  const board = new SqliteBoard();
  const events: string[] = [];
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect(task.harness).toBeUndefined();
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const updated = await board.setHarness(task.id, "claude-personal");
  expect(updated.harness).toBe("claude-personal");
  expect((await board.get(task.id))!.harness).toBe("claude-personal");
  expect(events).toEqual(["task.harness"]);

  await expect(board.setHarness("nope", "claude-personal")).rejects.toThrow("task not found");
});

test("list filters by status and repo", async () => {
  const board = new SqliteBoard();
  const a = await board.create({ title: "a", body: "", labels: [], repo: "repo-a" });
  await board.create({ title: "b", body: "", labels: [], repo: "repo-b" });
  await board.move(a.id, "running");

  expect((await board.list({ repo: "repo-a" })).map((t) => t.id)).toEqual([a.id]);
  expect((await board.list({ status: "running" })).map((t) => t.id)).toEqual([a.id]);
  expect((await board.list({ status: "inbox" })).map((t) => t.title)).toEqual(["b"]);
});

test("move updates status and rejects unknown ids", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  const moved = await board.move(task.id, "done");
  expect(moved.status).toBe("done");
  expect((await board.get(task.id))!.status).toBe("done");

  await expect(board.move("nope", "done")).rejects.toThrow("task not found");
});

test("recordDecision stamps routedTo on the task", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  const decision: RoutingDecision = {
    taskId: task.id,
    matchedTags: ["x"],
    candidates: [{ agentId: "a", score: 1, reason: "tag match" }],
    selected: "a",
    confident: true,
    reason: "best score",
    strategy: "rule",
    decidedAt: new Date().toISOString(),
  };
  await board.recordDecision(decision);
  expect((await board.get(task.id))!.routedTo).toBe("a");
});

test("getDecision returns the most recent decision, and undefined for a task with none", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  expect(await board.getDecision(task.id)).toBeUndefined();

  const first: RoutingDecision = {
    taskId: task.id, matchedTags: ["x"], candidates: [{ agentId: "a", score: 0.5, reason: "first pass" }],
    selected: null, confident: false, reason: "no confident match", strategy: "rule", decidedAt: new Date().toISOString(),
  };
  await board.recordDecision(first);

  const second: RoutingDecision = {
    taskId: task.id, matchedTags: ["x", "y"], candidates: [{ agentId: "a", score: 1, reason: "second pass" }],
    selected: "a", confident: true, reason: "best score", strategy: "rule", decidedAt: new Date().toISOString(),
  };
  await board.recordDecision(second);

  const latest = await board.getDecision(task.id);
  expect(latest).toEqual(second);
});

test("recordResult and recordOverride do not throw and emit events", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const result: TaskResult = { taskId: task.id, agentId: "a", ok: true, summary: "done" };
  await board.recordResult(result);
  await board.recordOverride(task.id, "a", "b");

  expect(events).toEqual(["task.result", "task.override"]);
});

test("getResult returns the most recent result, and undefined for a task with none", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  expect(await board.getResult(task.id)).toBeUndefined();

  await board.recordResult({ taskId: task.id, agentId: "a", ok: false, summary: "first attempt failed" });
  await board.recordResult({ taskId: task.id, agentId: "a", ok: true, summary: "retry worked", artifacts: ["board.html"] });

  expect(await board.getResult(task.id)).toEqual({
    taskId: task.id, agentId: "a", ok: true, summary: "retry worked", artifacts: ["board.html"],
  });
});

test("getResult round-trips worktree info, set by a write-tier run inside an isolated worktree", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  await board.recordResult({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "done",
    worktree: { path: "/home/x/.wissel/worktrees/" + task.id, branch: "wissel/" + task.id },
  });

  expect(await board.getResult(task.id)).toEqual({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "done",
    worktree: { path: "/home/x/.wissel/worktrees/" + task.id, branch: "wissel/" + task.id },
  });
});

// Found while adding the worktree column above: actualCost/harnessId had
// shipped on TaskResult well before task_results learned to store either
// one, so GET /tasks/:id/result silently dropped both — telemetry's own
// log was the only place they ever actually persisted. Fixed alongside
// worktree, not a coincidence this test sits right next to that one.
test("getResult round-trips actualCost and harnessId, not just the fields the table originally shipped with", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  await board.recordResult({ taskId: task.id, agentId: "a", ok: true, summary: "done", actualCost: 0.0347, harnessId: "claude-personal" });

  expect(await board.getResult(task.id)).toEqual({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "done",
    actualCost: 0.0347,
    harnessId: "claude-personal",
  });
});

test("getResult round-trips subagents (docs/SDD-subagent-visibility.md)", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  await board.recordResult({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "done",
    subagents: { count: 2, failed: 1, byType: { "general-purpose": 1, Explore: 1 } },
  });

  expect(await board.getResult(task.id)).toEqual({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "done",
    subagents: { count: 2, failed: 1, byType: { "general-purpose": 1, Explore: 1 } },
  });
});

test("delete removes a task and its decision/result/override, rejects unknown ids, emits an event", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordResult({ taskId: task.id, agentId: "a", ok: true, summary: "done" });
  await board.recordOverride(task.id, "a", "b");

  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  await board.delete(task.id);

  expect(await board.get(task.id)).toBeUndefined();
  expect(await board.getResult(task.id)).toBeUndefined();
  expect(events).toEqual(["task.deleted"]);

  await expect(board.delete("nope")).rejects.toThrow("task not found");
});

test("create and move emit events", async () => {
  const board = new SqliteBoard();
  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(task.id, "ready");

  expect(events).toEqual(["task.created", "task.moved"]);
});
