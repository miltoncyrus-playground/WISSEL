import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { notBeforeRefusal } from "../src/services/board-actions.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import { MAX_NOT_BEFORE_DAYS, validateNotBefore } from "../src/core/not-before.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";

// "Start at" (TaskCard.notBefore), docs/SDD-schedules.md §4.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = Date.parse("2026-10-12T10:00:00.000Z");

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function post(path: string, body: unknown): Request {
  return req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function setup(executors: Executor[], opts?: OrchestratorOptions) {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, opts);
  return { board, registry, orchestrator };
}

function recordingExecutor(seen: string[]): Executor {
  return {
    id: "fake-readonly",
    harnessTool: "claude-cli",
    canHandle: (agent: AgentDef) => agent.tier === "readonly",
    run: async (task, agent) => {
      seen.push(task.id);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "x" };
    },
  };
}

// ---------- validateNotBefore ----------

test("validateNotBefore accepts a future time with a zone and normalizes it to UTC", () => {
  const now = new Date(BASE);
  expect(validateNotBefore("2026-10-12T23:00:00Z", now)).toEqual({ ok: true, notBefore: "2026-10-12T23:00:00.000Z" });
  expect(validateNotBefore("2026-10-13T01:00:00+02:00", now)).toEqual({ ok: true, notBefore: "2026-10-12T23:00:00.000Z" });
  expect(validateNotBefore("2026-10-12T23:00Z", now)).toEqual({ ok: true, notBefore: "2026-10-12T23:00:00.000Z" });
});

test("validateNotBefore refuses unparseable, zone-less and non-string values", () => {
  const now = new Date(BASE);
  for (const bad of ["tonight at 11", "", "2026-10-12", "2026-10-12T23:00:00", "2026-13-01T00:00:00Z", 1760310000000, null, undefined, {}]) {
    const check = validateNotBefore(bad, now);
    expect(check.ok).toBe(false);
  }
  expect(validateNotBefore("2026-10-12T23:00:00", now)).toEqual({
    ok: false,
    error: "notBefore must be a date and time with a zone, e.g. 2026-10-12T23:00:00Z",
  });
});

test("validateNotBefore refuses now and the past", () => {
  const now = new Date(BASE);
  expect(validateNotBefore(now.toISOString(), now)).toEqual({ ok: false, error: "notBefore must be in the future" });
  expect(validateNotBefore("2026-10-12T09:59:59Z", now)).toEqual({ ok: false, error: "notBefore must be in the future" });
});

test("validateNotBefore allows exactly 30 days out and refuses one second more", () => {
  const now = new Date(BASE);
  expect(validateNotBefore(new Date(BASE + MAX_NOT_BEFORE_DAYS * DAY).toISOString(), now).ok).toBe(true);
  expect(validateNotBefore(new Date(BASE + MAX_NOT_BEFORE_DAYS * DAY + 1000).toISOString(), now)).toEqual({
    ok: false,
    error: "notBefore must be at most 30 days from now",
  });
});

test("notBeforeRefusal allows only a queued, unrouted, unarchived, non-pipeline card", () => {
  expect(notBeforeRefusal({ status: "inbox" })).toBeUndefined();
  expect(notBeforeRefusal({ status: "ready" })).toBeUndefined();
  expect(notBeforeRefusal({ status: "inbox", routedTo: "triager" })).toContain("already routed");
  expect(notBeforeRefusal({ status: "running" })).toContain("task is running");
  expect(notBeforeRefusal({ status: "done" })).toContain("task is done");
  expect(notBeforeRefusal({ status: "inbox", archivedAt: "2026-10-12T00:00:00Z" })).toContain("archived");
  expect(notBeforeRefusal({ status: "inbox", pipelineId: "p1" })).toContain("pipeline");
});

// ---------- board ----------

test("board round trips notBefore through create, setNotBefore and clear, and emits task.not-before", async () => {
  const board = new SqliteBoard();
  const created = await board.create({ title: "t", body: "", labels: [], repo: "r", notBefore: "2026-10-12T23:00:00.000Z" });
  expect(created.notBefore).toBe("2026-10-12T23:00:00.000Z");
  expect((await board.get(created.id))!.notBefore).toBe("2026-10-12T23:00:00.000Z");

  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));
  const moved = await board.setNotBefore(created.id, "2026-10-13T06:00:00.000Z");
  expect(moved.notBefore).toBe("2026-10-13T06:00:00.000Z");
  expect((await board.get(created.id))!.notBefore).toBe("2026-10-13T06:00:00.000Z");

  const cleared = await board.setNotBefore(created.id, undefined);
  expect(cleared.notBefore).toBeUndefined();
  expect((await board.get(created.id))!.notBefore).toBeUndefined();
  expect(events).toEqual(["task.not-before", "task.not-before"]);

  await expect(board.setNotBefore("nope", undefined)).rejects.toThrow("task not found: nope");
});

test("recordDecision clears retryAfter but leaves notBefore on the card", async () => {
  const board = new SqliteBoard();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r", notBefore: "2026-10-12T23:00:00.000Z" });
  await board.scheduleRetry(task.id, "2026-10-12T22:00:00.000Z");
  await board.recordDecision({
    taskId: task.id, matchedTags: [], candidates: [], selected: "triager", confident: true, reason: "r", strategy: "rule", decidedAt: "2026-10-12T23:00:01.000Z",
  });
  const after = await board.get(task.id);
  expect(after!.retryAfter).toBeUndefined();
  expect(after!.notBefore).toBe("2026-10-12T23:00:00.000Z");
});

test("opens and heals a real pre-existing on-disk DB from before notBefore existed", async () => {
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
    legacy.run("INSERT INTO tasks (id, title, body, labels, repo, status) VALUES ('old', 'old card', '', '[]', 'r', 'inbox')");
    legacy.close();

    const board = new SqliteBoard(dbPath);
    expect((await board.get("old"))!.notBefore).toBeUndefined();
    const task = await board.create({ title: "t", body: "", labels: [], repo: "r", notBefore: "2026-10-12T23:00:00.000Z" });
    expect((await board.get(task.id))!.notBefore).toBe("2026-10-12T23:00:00.000Z");
    expect((await board.setNotBefore("old", "2026-10-13T06:00:00.000Z")).notBefore).toBe("2026-10-13T06:00:00.000Z");
    expect((await board.get("old"))!.notBefore).toBe("2026-10-13T06:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- orchestrator ----------

test("sweep skips a card until its notBefore passes, then routes and runs it, and keeps notBefore on it", async () => {
  let clock = BASE;
  const seen: string[] = [];
  const { board, orchestrator } = await setup([recordingExecutor(seen)], { now: () => clock });
  const startAt = new Date(BASE + HOUR).toISOString();
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r", notBefore: startAt });

  await orchestrator.sweep();
  let t = await board.get(task.id);
  expect(t!.status).toBe("inbox");
  expect(t!.routedTo).toBeUndefined();
  expect(await board.getDecision(task.id)).toBeUndefined();
  expect(seen).toEqual([]);

  clock = BASE + HOUR - 1; // a millisecond early
  await orchestrator.sweep();
  expect(seen).toEqual([]);

  clock = BASE + HOUR; // due: no longer in the future
  await orchestrator.sweep();
  t = await board.get(task.id);
  expect(seen).toEqual([task.id]);
  expect(t!.status).toBe("done");
  expect(t!.routedTo).toBe("triager");
  expect(t!.notBefore).toBe(startAt);
});

test("wake timer arms for notBefore when no card has a retryAfter", async () => {
  const { board, orchestrator } = await setup([recordingExecutor([])], { now: () => BASE });
  await board.create({ title: "later", body: "", labels: ["intake"], repo: "r", notBefore: new Date(BASE + 2 * HOUR).toISOString() });
  orchestrator.start();
  try {
    await orchestrator.sweep();
    expect(orchestrator.nextWakeAt).toBe(BASE + 2 * HOUR);
  } finally {
    orchestrator.stop();
  }
  expect(orchestrator.nextWakeAt).toBeUndefined();
});

test("wake timer arms for the earlier of retryAfter and notBefore, on one card or across cards", async () => {
  // Earlier notBefore on one card, later retryAfter on another.
  {
    const { board, orchestrator } = await setup([recordingExecutor([])], { now: () => BASE });
    const a = await board.create({ title: "a", body: "", labels: ["intake"], repo: "r" });
    await board.scheduleRetry(a.id, new Date(BASE + 3 * HOUR).toISOString());
    await board.create({ title: "b", body: "", labels: ["intake"], repo: "r", notBefore: new Date(BASE + HOUR).toISOString() });
    orchestrator.start();
    try {
      await orchestrator.sweep();
      expect(orchestrator.nextWakeAt).toBe(BASE + HOUR);
    } finally {
      orchestrator.stop();
    }
  }
  // Both on the same card, retryAfter earlier this time.
  {
    const { board, orchestrator } = await setup([recordingExecutor([])], { now: () => BASE });
    const c = await board.create({ title: "c", body: "", labels: ["intake"], repo: "r", notBefore: new Date(BASE + 5 * HOUR).toISOString() });
    await board.scheduleRetry(c.id, new Date(BASE + 4 * HOUR).toISOString());
    orchestrator.start();
    try {
      await orchestrator.sweep();
      expect(orchestrator.nextWakeAt).toBe(BASE + 4 * HOUR);
    } finally {
      orchestrator.stop();
    }
  }
});

test("wake timer ignores the notBefore of an archived, routed or past card", async () => {
  const { board, orchestrator } = await setup([recordingExecutor([])], { now: () => BASE });
  const archived = await board.create({ title: "archived", body: "", labels: [], repo: "r", notBefore: new Date(BASE + HOUR).toISOString() });
  await board.archive(archived.id);
  const running = await board.create({ title: "running", body: "", labels: [], repo: "r", notBefore: new Date(BASE + HOUR).toISOString() });
  await board.move(running.id, "running");
  await board.create({ title: "past", body: "", labels: ["intake"], repo: "r", notBefore: new Date(BASE - HOUR).toISOString() });
  await board.create({ title: "live", body: "", labels: [], repo: "r", notBefore: new Date(BASE + 6 * HOUR).toISOString() });
  orchestrator.start();
  try {
    await orchestrator.sweep();
    expect(orchestrator.nextWakeAt).toBe(BASE + 6 * HOUR);
  } finally {
    orchestrator.stop();
  }
});

// The 2026-10-09 bug (a quiet board never waking for a future time) must
// not come back for notBefore: no board event after start(), real clock.
test("a started orchestrator runs a card once its notBefore passes, with no board event", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup([recordingExecutor(seen)]);
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r", notBefore: new Date(Date.now() + 300).toISOString() });

  orchestrator.start();
  try {
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toEqual([]); // not before its time
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([task.id]);
    expect((await board.get(task.id))!.status).toBe("done");
  } finally {
    orchestrator.stop();
  }
});

test("runNow on a card with a future notBefore runs it and clears notBefore", async () => {
  const seen: string[] = [];
  const executor = recordingExecutor(seen);
  const { board, orchestrator } = await setup([], { now: () => BASE });
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r", notBefore: new Date(BASE + 10 * DAY).toISOString() });

  await orchestrator.runNow(task.id, [executor]);
  // Cleared before runNow returns, not only once the run finishes.
  expect((await board.get(task.id))!.notBefore).toBeUndefined();
  const deadline = Date.now() + 3000;
  while ((await board.get(task.id))!.status !== "done" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(seen).toEqual([task.id]);
  expect((await board.get(task.id))!.status).toBe("done");
});

// ---------- API ----------

async function makeApp(board = new SqliteBoard()) {
  const registry = await Registry.load();
  return { app: createApp(board, registry), board };
}

const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

test("POST /tasks validates notBefore: unparseable, past and more than 30 days out are 400", async () => {
  const { app, board } = await makeApp();
  const cases: [unknown, string][] = [
    ["tonight at 11", "notBefore must be a date and time with a zone, e.g. 2026-10-12T23:00:00Z"],
    [inHours(-1), "notBefore must be in the future"],
    [new Date(Date.now() + 31 * DAY).toISOString(), "notBefore must be at most 30 days from now"],
  ];
  for (const [notBefore, error] of cases) {
    const res = await app(post("/tasks", { title: "t", body: "", labels: [], repo: "r", notBefore }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  }
  expect(await board.list()).toEqual([]);
});

test("POST /tasks stores a valid notBefore normalized to UTC; omitted or null leaves none", async () => {
  const { app, board } = await makeApp();
  const local = new Date(Date.now() + 2 * HOUR);
  // Same instant written with a +02:00 offset.
  const withOffset = new Date(local.getTime() + 2 * HOUR).toISOString().replace(/\.\d{3}Z$/, "+02:00");
  const res = await app(post("/tasks", { title: "t", body: "", labels: [], repo: "r", notBefore: withOffset }));
  expect(res.status).toBe(201);
  const created = (await res.json()) as TaskCard;
  const expected = new Date(Math.floor(local.getTime() / 1000) * 1000).toISOString();
  expect(created.notBefore).toBe(expected);
  expect((await board.get(created.id))!.notBefore).toBe(expected);

  for (const extra of [{}, { notBefore: null }]) {
    const plain = (await (await app(post("/tasks", { title: "t", body: "", labels: [], repo: "r", ...extra }))).json()) as TaskCard;
    expect(plain.notBefore).toBeUndefined();
  }
});

test("POST /tasks/:id/not-before sets and clears with null, returning the updated card", async () => {
  const { app, board } = await makeApp();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  const at = inHours(3);

  const set = await app(post(`/tasks/${task.id}/not-before`, { notBefore: at }));
  expect(set.status).toBe(200);
  expect(((await set.json()) as TaskCard).notBefore).toBe(at);
  expect((await board.get(task.id))!.notBefore).toBe(at);

  const cleared = await app(post(`/tasks/${task.id}/not-before`, { notBefore: null }));
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as TaskCard).notBefore).toBeUndefined();
  expect((await board.get(task.id))!.notBefore).toBeUndefined();
});

test("POST /tasks/:id/not-before is 400 for an invalid time, missing field or past time", async () => {
  const { app, board } = await makeApp();
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  for (const body of [{ notBefore: "soon" }, {}, { notBefore: inHours(-2) }, { notBefore: new Date(Date.now() + 40 * DAY).toISOString() }]) {
    const res = await app(post(`/tasks/${task.id}/not-before`, body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toStartWith("notBefore must");
  }
  expect((await board.get(task.id))!.notBefore).toBeUndefined();
});

test("POST /tasks/:id/not-before is 409 for a routed, running, done, archived or pipeline card", async () => {
  const { app, board } = await makeApp();
  const routed = await board.create({ title: "routed", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routed.id, matchedTags: [], candidates: [], selected: "triager", confident: true, reason: "r", strategy: "rule", decidedAt: new Date().toISOString(),
  });
  const running = await board.create({ title: "running", body: "", labels: [], repo: "r" });
  await board.move(running.id, "running");
  const done = await board.create({ title: "done", body: "", labels: [], repo: "r" });
  await board.move(done.id, "done");
  const archived = await board.create({ title: "archived", body: "", labels: [], repo: "r" });
  await board.archive(archived.id);
  const pipeline = await board.create({ title: "pipeline", body: "", labels: [], repo: "", pipelineId: "p1" });

  for (const id of [routed.id, running.id, done.id, archived.id, pipeline.id]) {
    for (const notBefore of [inHours(1), null]) {
      const res = await app(post(`/tasks/${id}/not-before`, { notBefore }));
      expect(res.status).toBe(409);
      expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
    }
    expect((await board.get(id))!.notBefore).toBeUndefined();
  }
});

test("POST /tasks/:id/not-before is 404 for an unknown id", async () => {
  const { app } = await makeApp();
  const res = await app(post("/tasks/nope/not-before", { notBefore: inHours(1) }));
  expect(res.status).toBe(404);
});
