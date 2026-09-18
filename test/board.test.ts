import { expect, test } from "bun:test";
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

test("create and move emit events", async () => {
  const board = new SqliteBoard();
  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(task.id, "ready");

  expect(events).toEqual(["task.created", "task.moved"]);
});
