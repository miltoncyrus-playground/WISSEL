import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { OwnerTaskStore, ownerTaskBody, ownerTaskError } from "../src/services/owner-tasks.ts";
import { needsYouFor } from "../src/services/needs-you.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

// docs/SDD-coordinator.md §3.4, §4.14, phase 1 card 4: owner tasks with a
// why, tick-box steps, the cards waiting on them, and a check Wissel runs
// after Done.

const exits = (code: number, out = ""): CommandRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd) => (calls.push(cmd), { stdout: out, stderr: code ? "still signed out" : "", exitCode: code });
  return Object.assign(run, { calls });
};

const INPUT = { title: "Sign in to the work account again", why: "Its SSO session expired, so no card can run on it.", steps: ["Run claude /login in a terminal", "Pick the work account"], check: ["claude", "auth", "status"] };

describe("validation", () => {
  test("title, why and at least one step are required; check is argv; unknown fields are refused", () => {
    expect(ownerTaskError(INPUT)).toBeUndefined();
    expect(ownerTaskError({ ...INPUT, why: " " })).toContain("why");
    expect(ownerTaskError({ ...INPUT, steps: [] })).toContain("steps");
    expect(ownerTaskError({ ...INPUT, check: "claude auth status" })).toContain("argv");
    expect(ownerTaskError({ ...INPUT, check: [""] })).toContain("argv");
    expect(ownerTaskError({ ...INPUT, blocks: ["../x"] })).toContain("card ids");
    expect(ownerTaskError({ ...INPUT, status: "done" })).toContain('unknown field "status"');
  });

  test("the card's body carries the why, numbered steps and what Done will run", () => {
    expect(ownerTaskBody(INPUT)).toBe("Its SSO session expired, so no card can run on it.\n\nSteps:\n1. Run claude /login in a terminal\n2. Pick the work account\n\nWhen you press Done, Wissel runs `claude auth status` and closes this only if it passes.");
  });
});

describe("the store", () => {
  test("raising one puts its card in review and makes the blocked cards wait on it", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    const waiting = await board.create({ title: "needs the account", body: "", labels: [], dependsOn: [] });
    const r = await store.create({ ...INPUT, blocks: [waiting.id] });
    expect(r.ok).toBe(true);
    const task = r.ok ? r.task : undefined!;
    expect(task).toMatchObject({ status: "open", blocks: [waiting.id] });
    expect(await board.get(task.cardId)).toMatchObject({ status: "review", labels: ["owner"], title: INPUT.title });
    expect((await board.get(waiting.id))!.dependsOn).toEqual([task.cardId]);
    expect(store.byCard(task.cardId)?.id).toBe(task.id);
    expect(store.list("open").map((t) => t.id)).toEqual([task.id]);
  });

  test("an unknown blocked card refuses the task before anything is written", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    expect(await store.create({ ...INPUT, blocks: ["nope"] })).toEqual({ ok: false, error: "no such card: nope" });
    expect(await board.list()).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  test("Done with a failing check keeps it open and records what the check said; a passing one closes it and releases the card", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    const r = await store.create(INPUT);
    const id = r.ok ? r.task.id : "";
    const failing = exits(1);
    const no = await store.done(id, failing);
    expect(no).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("did not pass (exit 1)") });
    expect(failing.calls).toEqual([["claude", "auth", "status"]]);
    expect(store.get(id)).toMatchObject({ status: "open", lastCheck: { ok: false, exitCode: 1, output: "still signed out" } });
    const yes = await store.done(id, exits(0, "Logged in"));
    expect(yes.ok && yes.task).toMatchObject({ status: "done", lastCheck: { ok: true } });
    expect((await board.get(store.get(id)!.cardId))!.status).toBe("done");
    expect(await store.done(id, exits(0))).toMatchObject({ ok: false, status: 409, error: "owner task is already done" });
  });

  test("a check that hangs counts as failed after the timeout", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    const r = await store.create(INPUT);
    const hang: CommandRunner = () => new Promise(() => {});
    const out = await store.done(r.ok ? r.task.id : "", hang, 20);
    expect(out).toMatchObject({ ok: false, task: { lastCheck: { exitCode: 124, output: "timed out after 0s" } } });
  });

  test("Done without a check closes at once; Dismiss closes without running anything", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    const a = await store.create({ title: "a", why: "w", steps: ["s"] });
    const runner = exits(1);
    expect((await store.done(a.ok ? a.task.id : "", runner)).ok).toBe(true);
    expect(runner.calls).toEqual([]);
    const b = await store.create(INPUT);
    const d = await store.dismiss(b.ok ? b.task.id : "");
    expect(d.ok && d.task.status).toBe("dismissed");
    expect((await board.get(b.ok ? b.task.cardId : ""))!.status).toBe("done");
  });
});

describe("Needs a human", () => {
  test("an open owner task's card shows its why, its steps and Done; once closed it no longer needs anyone", async () => {
    const board = new SqliteBoard();
    const store = new OwnerTaskStore(board.db, board);
    const waiting = await board.create({ title: "w", body: "", labels: [], dependsOn: [] });
    const r = await store.create({ ...INPUT, blocks: [waiting.id] });
    const task = r.ok ? r.task : undefined!;
    const needs = await needsYouFor(board, await board.list(), { ownerTaskFor: (id) => store.byCard(id) });
    expect(needs.get(task.cardId)).toEqual({
      kind: "owner-task",
      lane: "human",
      value: "owner-task",
      line: "Only you can do this; Done checks it",
      why: `${INPUT.why} 1 card waits on it.`,
      checklist: INPUT.steps,
      action: { label: "Done", href: `/owner-tasks/${task.id}/done`, method: "POST" },
    });
    await store.dismiss(task.id);
    const after = await needsYouFor(board, await board.list(), { ownerTaskFor: (id) => store.byCard(id) });
    expect(after.has(task.cardId)).toBe(false);
  });
});

describe("API", () => {
  async function app(runner: CommandRunner) {
    const board = new SqliteBoard();
    return { board, app: createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), ownerTaskRunner: runner }) };
  }
  const call = (a: (r: Request) => Promise<Response> | Response, method: string, path: string, body?: unknown) =>
    a(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));

  test("POST, GET, the card's needsYou on GET /tasks, and Done through the check", async () => {
    const runner = exits(0);
    const { app: a } = await app(runner);
    const created = await call(a, "POST", "/owner-tasks", INPUT);
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; cardId: string };
    expect(((await (await call(a, "GET", "/owner-tasks?status=open")).json()) as unknown[]).length).toBe(1);
    const cards = (await (await call(a, "GET", "/tasks")).json()) as Array<{ id: string; needsYou?: { kind: string; action: { href: string } } }>;
    const card = cards.find((c) => c.id === task.cardId)!;
    expect(card.needsYou?.kind).toBe("owner-task");
    const done = await call(a, "POST", card.needsYou!.action.href);
    expect(done.status).toBe(200);
    expect(((await done.json()) as { status: string }).status).toBe("done");
    expect(runner.calls).toEqual([INPUT.check]);
  });

  test("a bad body is 400, an unknown id 404, a failing check 409 with what it said", async () => {
    const { app: a } = await app(exits(3, "nope"));
    expect((await call(a, "POST", "/owner-tasks", { title: "t" })).status).toBe(400);
    expect((await call(a, "GET", "/owner-tasks?status=closed")).status).toBe(400);
    expect((await call(a, "POST", "/owner-tasks/missing/done")).status).toBe(404);
    const task = (await (await call(a, "POST", "/owner-tasks", INPUT)).json()) as { id: string };
    const res = await call(a, "POST", `/owner-tasks/${task.id}/done`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { task: { lastCheck: { exitCode: number } } }).task.lastCheck.exitCode).toBe(3);
  });
});
