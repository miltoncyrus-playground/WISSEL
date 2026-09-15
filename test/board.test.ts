import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import type { RoutingDecision, TaskResult } from "../src/core/types.ts";

test("create then get round-trips a task", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "b", labels: ["x"], repo: "r" });
  expect(created.status).toBe("inbox");

  const fetched = await board.get(created.id);
  expect(fetched).toEqual(created);
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
    reason: "best score",
    strategy: "rule",
    decidedAt: new Date().toISOString(),
  };
  await board.recordDecision(decision);
  expect((await board.get(task.id))!.routedTo).toBe("a");
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

test("create and move emit events", async () => {
  const board = new SqliteBoard();
  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.move(task.id, "ready");

  expect(events).toEqual(["task.created", "task.moved"]);
});
