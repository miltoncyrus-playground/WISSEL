import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import type { BoardEvent } from "../src/services/board.ts";
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

test("create round-trips model and harnessOverride, and leaves them undefined when omitted", async () => {
  const board = new SqliteBoard();
  const withOverrides = await board.create({ title: "t", body: "", labels: [], repo: "r", model: "claude-opus-5-5", harnessOverride: "codex-personal" });
  expect(withOverrides.model).toBe("claude-opus-5-5");
  expect(withOverrides.harnessOverride).toBe("codex-personal");
  expect((await board.get(withOverrides.id))!.model).toBe("claude-opus-5-5");
  expect((await board.get(withOverrides.id))!.harnessOverride).toBe("codex-personal");

  const bare = await board.create({ title: "b", body: "", labels: [], repo: "r" });
  expect(bare.model).toBeUndefined();
  expect(bare.harnessOverride).toBeUndefined();
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

// Real bug, found live: a real on-disk board.sqlite (this project's
// own dev database) had `selected TEXT NOT NULL` from before
// RoutingDecision.selected became nullable to represent a no-match
// decision — every no-match recordDecision() on that exact database
// had been silently throwing (caught and swallowed by orchestrator.ts's
// process(), leaving the task stuck unrouted in inbox forever) until
// the sweep loop actually ran for real against it. Exact schema
// reproduced from that real database, confident column included.
test("opens and heals a real pre-existing on-disk DB from before routing_decisions.selected was nullable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE routing_decisions (
        taskId TEXT NOT NULL,
        matchedTags TEXT NOT NULL,
        candidates TEXT NOT NULL,
        selected TEXT NOT NULL,
        reason TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decidedAt TEXT NOT NULL
      , confident INTEGER NOT NULL DEFAULT 1);
    `);
    // A real row already on disk, the way an existing database would
    // have one — must survive the migration intact.
    legacy.run(
      "INSERT INTO routing_decisions (taskId, matchedTags, candidates, selected, confident, reason, strategy, decidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["pre-existing-task", "[]", "[]", "implementer", 1, "old decision", "rule", "2026-01-01T00:00:00.000Z"],
    );
    legacy.close();

    const board = new SqliteBoard(dbPath);

    // The pre-existing row survived the table rebuild.
    expect(await board.getDecision("pre-existing-task")).toEqual({
      taskId: "pre-existing-task", matchedTags: [], candidates: [], selected: "implementer",
      confident: true, reason: "old decision", strategy: "rule", decidedAt: "2026-01-01T00:00:00.000Z",
    });

    // The actual bug: a no-match decision (selected: null) must no
    // longer throw.
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
    const noMatch: RoutingDecision = {
      taskId: task.id, matchedTags: [], candidates: [], selected: null,
      confident: false, reason: "zero tag overlap", strategy: "rule", decidedAt: new Date().toISOString(),
    };
    await board.recordDecision(noMatch);
    expect(await board.getDecision(task.id)).toEqual(noMatch);
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

// actor/reason turn a plain router override into a full audit trail —
// who forced it, when, why — the shape POST /tasks/:id/escalation/approve
// relies on (src/api/server.ts) since that endpoint overrides an
// escalation's outstanding objections outright.
test("recordOverride round-trips actor/reason on the task.override event, and omits them when not given", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => events.push(e));

  await board.recordOverride(task.id, "escalated", "review", "milton", "human review confirmed the fix is fine");
  await board.recordOverride(task.id, "a", "b");

  const [withAudit, without] = events as Extract<BoardEvent, { type: "task.override" }>[];
  expect(withAudit!.taskId).toBe(task.id);
  expect(withAudit!.routerPick).toBe("escalated");
  expect(withAudit!.humanPick).toBe("review");
  expect(withAudit!.actor).toBe("milton");
  expect(withAudit!.reason).toBe("human review confirmed the fix is fine");
  expect(typeof withAudit!.at).toBe("string");
  expect(without!.actor).toBeUndefined();
  expect(without!.reason).toBeUndefined();
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

// Round-trip for the review-pushback lineage fields (pushbackCount,
// reviewLineageId, escalationContext) and the "escalated" status —
// create() sets the lineage fields directly, move() drives status the
// same way every other status transition already does.
test("round-trips review lineage fields and the escalated status", async () => {
  const board = new SqliteBoard();
  const task = await board.create({
    title: "t",
    body: "b",
    labels: [],
    repo: "r",
    pushbackCount: 3,
    reviewLineageId: "lineage-1",
    escalationContext: "same feedback twice in a row, kicked to a human",
  });
  expect(task.pushbackCount).toBe(3);
  expect(task.reviewLineageId).toBe("lineage-1");
  expect(task.escalationContext).toBe("same feedback twice in a row, kicked to a human");

  const escalated = await board.move(task.id, "escalated");
  expect(escalated.status).toBe("escalated");

  const fetched = await board.get(task.id);
  expect(fetched).toEqual(escalated);
  expect(fetched!.pushbackCount).toBe(3);
  expect(fetched!.reviewLineageId).toBe("lineage-1");
  expect(fetched!.escalationContext).toBe("same feedback twice in a row, kicked to a human");
});

test("create round-trips supersededBy, and leaves review lineage fields undefined when omitted", async () => {
  const board = new SqliteBoard();
  const untouched = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect(untouched.pushbackCount).toBeUndefined();
  expect(untouched.reviewLineageId).toBeUndefined();
  expect(untouched.supersededBy).toBeUndefined();
  expect(untouched.escalationContext).toBeUndefined();

  const reattempt = await board.create({ title: "t (attempt 2)", body: "", labels: [], repo: "r", reviewLineageId: "lineage-1" });
  const superseded = await board.create({
    title: "t (attempt 1)",
    body: "",
    labels: [],
    repo: "r",
    reviewLineageId: "lineage-1",
    supersededBy: reattempt.id,
  });
  expect(superseded.supersededBy).toBe(reattempt.id);
  expect((await board.get(superseded.id))!.supersededBy).toBe(reattempt.id);
});

// Same class of bug covered for parentTaskId/confident/worktree above: a
// pre-existing on-disk DB from before the review-lineage columns existed
// must not break create() the moment those columns are read/written.
test("opens and heals a real pre-existing on-disk DB from before review lineage columns existed", async () => {
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
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r", pushbackCount: 1, reviewLineageId: "lineage-legacy" });
    expect(task.pushbackCount).toBe(1);
    expect(task.reviewLineageId).toBe("lineage-legacy");
    expect((await board.get(task.id))!.pushbackCount).toBe(1);

    const escalated = await board.move(task.id, "escalated");
    expect(escalated.status).toBe("escalated");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// TaskResult's review-verdict fields (verdict, reviewFeedback) need the
// same round-trip guarantee as every other task_results column.
test("getResult round-trips verdict and reviewFeedback", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });

  await board.recordResult({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "reviewed",
    verdict: "changes_requested",
    reviewFeedback: "board.html hardcodes the status enum, missing pending-review/escalated",
  });

  expect(await board.getResult(task.id)).toEqual({
    taskId: task.id,
    agentId: "a",
    ok: true,
    summary: "reviewed",
    verdict: "changes_requested",
    reviewFeedback: "board.html hardcodes the status enum, missing pending-review/escalated",
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

test("scheduleRetry moves a task back to inbox, clears routedTo, sets retryAfter, and emits task.moved", async () => {
  const board = new SqliteBoard();
  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => events.push(e));

  const task = await board.create({ title: "t", body: "", labels: ["code"], repo: "r" });
  await board.recordDecision({
    taskId: task.id, matchedTags: [], candidates: [], selected: "implementer", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  await board.move(task.id, "running");
  expect((await board.get(task.id))!.routedTo).toBe("implementer");

  const retryAfter = "2026-09-22T15:10:00.000Z";
  const updated = await board.scheduleRetry(task.id, retryAfter);
  expect(updated.status).toBe("inbox");
  expect(updated.routedTo).toBeUndefined();
  expect(updated.retryAfter).toBe(retryAfter);

  const fetched = await board.get(task.id);
  expect(fetched).toEqual(updated);

  expect(events.at(-1)).toEqual({ type: "task.moved", task: updated });
});

test("scheduleRetry rejects an unknown task id", async () => {
  const board = new SqliteBoard();
  await expect(board.scheduleRetry("no-such-task", "2026-09-22T15:10:00.000Z")).rejects.toThrow("task not found");
});

test("recordDecision clears a previously-set retryAfter — a task that's actually routing again no longer has a pending retry", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: ["code"], repo: "r" });
  await board.scheduleRetry(task.id, "2026-09-22T15:10:00.000Z");
  expect((await board.get(task.id))!.retryAfter).toBe("2026-09-22T15:10:00.000Z");

  await board.recordDecision({
    taskId: task.id, matchedTags: [], candidates: [], selected: "implementer", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });

  const after = await board.get(task.id);
  expect(after!.routedTo).toBe("implementer");
  expect(after!.retryAfter).toBeUndefined();
});

// doneAt: the one reliable "became done" marker every auto-archive
// decision is measured against (docs/SDD-task-archiving.md §3.2).
test("move stamps doneAt on every transition to done, refreshes it on re-entry, and leaves it untouched for any other status", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect(task.doneAt).toBeUndefined();

  const moved = await board.move(task.id, "done");
  expect(moved.doneAt).toBeDefined();
  const firstDoneAt = moved.doneAt!;
  expect((await board.get(task.id))!.doneAt).toBe(firstDoneAt);

  // Moving to any other status leaves doneAt untouched — it's a "was
  // ever done, when" marker, not a "currently done" flag.
  const failed = await board.move(task.id, "failed");
  expect(failed.doneAt).toBe(firstDoneAt);
  expect((await board.get(task.id))!.doneAt).toBe(firstDoneAt);

  // Re-entering done a second time refreshes it — last time in wins,
  // no special-casing for a hypothetical re-open.
  await new Promise((r) => setTimeout(r, 5));
  const doneAgain = await board.move(task.id, "done");
  expect(doneAgain.doneAt).toBeDefined();
  expect(doneAgain.doneAt).not.toBe(firstDoneAt);
});

test("opens and heals a real pre-existing on-disk DB from before doneAt/archivedAt existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-donearchived-"));
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
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT,
        pushbackCount INTEGER,
        reviewLineageId TEXT,
        supersededBy TEXT,
        escalationContext TEXT,
        retryAfter TEXT
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
    const moved = await board.move(task.id, "done");
    expect(moved.doneAt).toBeDefined();

    const archived = await board.archive(task.id);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.archivedAt).toBeDefined();
    expect((await board.get(task.id))!.archivedAt).toBe(archived[0]!.archivedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("opens and heals a real pre-existing on-disk DB from before model/harnessOverride existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-model-"));
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
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT,
        pushbackCount INTEGER,
        reviewLineageId TEXT,
        supersededBy TEXT,
        escalationContext TEXT,
        retryAfter TEXT,
        doneAt TEXT,
        archivedAt TEXT
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r", model: "claude-opus-5-5", harnessOverride: "codex-personal" });
    expect(task.model).toBe("claude-opus-5-5");
    expect(task.harnessOverride).toBe("codex-personal");
    expect((await board.get(task.id))!.model).toBe("claude-opus-5-5");
    expect((await board.get(task.id))!.harnessOverride).toBe("codex-personal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Board.archive/unarchive: downward cascade + single-row restore ---
// (docs/SDD-task-archiving.md §3.5/§3.6)

test("archive cascades down a multi-generation lineage in one call, stamping archivedAt on every row and firing one task.archived event", async () => {
  const board = new SqliteBoard();
  const events: BoardEvent[] = [];

  // implementer -> reviewer -> pushback re-attempt -> its own reviewer
  const implementer = await board.create({ title: "implementer", body: "", labels: [], repo: "r" });
  const reviewer = await board.create({ title: "reviewer", body: "", labels: [], repo: "r", parentTaskId: implementer.id });
  const reattempt = await board.create({ title: "reattempt", body: "", labels: [], repo: "r", parentTaskId: implementer.id });
  const reattemptReviewer = await board.create({ title: "reattempt reviewer", body: "", labels: [], repo: "r", parentTaskId: reattempt.id });

  board.events.on("event", (e: BoardEvent) => events.push(e));

  const touched = await board.archive(implementer.id);
  expect(touched.map((t) => t.id).sort()).toEqual([implementer.id, reviewer.id, reattempt.id, reattemptReviewer.id].sort());
  touched.forEach((t) => expect(t.archivedAt).toBeDefined());

  for (const id of [implementer.id, reviewer.id, reattempt.id, reattemptReviewer.id]) {
    expect((await board.get(id))!.archivedAt).toBeDefined();
  }

  const archivedEvents = events.filter((e) => e.type === "task.archived");
  expect(archivedEvents).toHaveLength(1);
  expect((archivedEvents[0] as Extract<BoardEvent, { type: "task.archived" }>).tasks).toHaveLength(4);
});

test("archiving a non-root subtask only touches its own subtree — siblings and the root stay untouched", async () => {
  const board = new SqliteBoard();
  const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
  const subtaskA = await board.create({ title: "subtask a", body: "", labels: [], repo: "r", parentTaskId: root.id });
  const subtaskAChild = await board.create({ title: "subtask a child", body: "", labels: [], repo: "r", parentTaskId: subtaskA.id });
  const subtaskB = await board.create({ title: "subtask b", body: "", labels: [], repo: "r", parentTaskId: root.id });

  const touched = await board.archive(subtaskA.id);
  expect(touched.map((t) => t.id).sort()).toEqual([subtaskA.id, subtaskAChild.id].sort());

  expect((await board.get(root.id))!.archivedAt).toBeUndefined();
  expect((await board.get(subtaskB.id))!.archivedAt).toBeUndefined();
  expect((await board.get(subtaskA.id))!.archivedAt).toBeDefined();
  expect((await board.get(subtaskAChild.id))!.archivedAt).toBeDefined();
});

test("archive on a task with no descendants archives as a 1-element result — no special-casing for the common case", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  const touched = await board.archive(task.id);
  expect(touched).toHaveLength(1);
  expect(touched[0]!.id).toBe(task.id);
});

test("unarchive clears exactly one row, even when called on a task whose whole tree was previously archived together, and emits task.unarchived", async () => {
  const board = new SqliteBoard();
  const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
  const child = await board.create({ title: "child", body: "", labels: [], repo: "r", parentTaskId: root.id });
  await board.archive(root.id);
  expect((await board.get(root.id))!.archivedAt).toBeDefined();
  expect((await board.get(child.id))!.archivedAt).toBeDefined();

  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => events.push(e));

  const restored = await board.unarchive(root.id);
  expect(restored.archivedAt).toBeUndefined();
  expect((await board.get(root.id))!.archivedAt).toBeUndefined();
  // The child, archived in the same original cascade, is untouched —
  // unarchive never cascades (§3.6).
  expect((await board.get(child.id))!.archivedAt).toBeDefined();

  expect(events).toEqual([{ type: "task.unarchived", task: restored }]);
});

test("archive and unarchive reject unknown ids, matching every other Board method's contract", async () => {
  const board = new SqliteBoard();
  await expect(board.archive("nope")).rejects.toThrow("task not found");
  await expect(board.unarchive("nope")).rejects.toThrow("task not found");
});

test("opens and heals a real pre-existing on-disk DB from before retryAfter existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-retryafter-"));
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
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT,
        pushbackCount INTEGER,
        reviewLineageId TEXT,
        supersededBy TEXT,
        escalationContext TEXT
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
    const retried = await board.scheduleRetry(task.id, "2026-09-22T15:10:00.000Z");
    expect(retried.retryAfter).toBe("2026-09-22T15:10:00.000Z");
    expect((await board.get(task.id))!.retryAfter).toBe("2026-09-22T15:10:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create round-trips pipelineId/pipelineRunId/pipelineStepId, and leaves them undefined when omitted", async () => {
  const board = new SqliteBoard();
  const pipelineTask = await board.create({
    title: "step",
    body: "",
    labels: [],
    repo: "r",
    pipelineId: "pipe-1",
    pipelineRunId: "run-1",
    pipelineStepId: "step-a",
  });
  expect(pipelineTask.pipelineId).toBe("pipe-1");
  expect(pipelineTask.pipelineRunId).toBe("run-1");
  expect(pipelineTask.pipelineStepId).toBe("step-a");
  const fetched = await board.get(pipelineTask.id);
  expect(fetched!.pipelineId).toBe("pipe-1");
  expect(fetched!.pipelineRunId).toBe("run-1");
  expect(fetched!.pipelineStepId).toBe("step-a");

  const bare = await board.create({ title: "b", body: "", labels: [], repo: "r" });
  expect(bare.pipelineId).toBeUndefined();
  expect(bare.pipelineRunId).toBeUndefined();
  expect(bare.pipelineStepId).toBeUndefined();
});

// Same class of bug as parentTaskId/harnessOverride before it: a
// pre-existing on-disk DB from before pipelineId/pipelineRunId/
// pipelineStepId existed must heal on open, not throw "table tasks has
// no column named pipelineId" the first time a pipeline task is created
// against it.
test("opens and heals a real pre-existing on-disk DB from before the pipeline* columns existed", async () => {
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
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT,
        pushbackCount INTEGER,
        reviewLineageId TEXT,
        supersededBy TEXT,
        escalationContext TEXT,
        retryAfter TEXT,
        doneAt TEXT,
        archivedAt TEXT,
        model TEXT,
        harnessOverride TEXT
      );
    `);
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r", pipelineId: "pipe-1", pipelineRunId: "run-1", pipelineStepId: "step-a" });
    expect(task.pipelineId).toBe("pipe-1");
    expect((await board.get(task.id))!.pipelineRunId).toBe("run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The pipelines table itself is a fresh addition (never existed on any
// pre-existing DB) — CREATE TABLE IF NOT EXISTS is sufficient, no
// ALTER TABLE heal needed. Round-trip CRUD lives in test/pipelines.test.ts
// (SqlitePipelineStore, sharing this exact connection) — this just
// confirms SqliteBoard actually creates the table on open.
test("opens a fresh DB with the pipelines table already present", async () => {
  const board = new SqliteBoard();
  expect(() => board.db.query("SELECT * FROM pipelines").all()).not.toThrow();
});
