import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { DEFAULT_HARD_LIMITS, GateLog } from "../src/services/policy-gate.ts";
import { ActionExecutor, OutboundQueue, quietHoursEnd, type ExecutorAction } from "../src/services/executor.ts";
import type { Workstream, WorkstreamProject } from "../src/services/workstreams.ts";

// docs/SDD-coordinator.md §4.3, §4.11, phase 3 card 15: the executor does
// what the gate allows and nothing else; quiet hours queue outward
// actions and flush them in order once the window ends.

const NIGHT = new Date("2026-11-27T23:30:00Z");
const MORNING = new Date("2026-11-28T08:00:00Z");
const QUIET = { start: "22:00", end: "07:00", timezone: "UTC" };

describe("quiet hours", () => {
  test("quietHoursEnd is the next minute outside them, and nothing when outside", () => {
    expect(quietHoursEnd(QUIET, NIGHT)?.toISOString()).toBe("2026-11-28T07:00:00.000Z");
    expect(quietHoursEnd(QUIET, MORNING)).toBeUndefined();
  });
});

describe("the executor", () => {
  function setup(project: Partial<WorkstreamProject> = {}, extra: Partial<Workstream> = {}) {
    let now = NIGHT;
    const board = new SqliteBoard();
    const ws: Workstream = { id: "ws1", name: "Checkout", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [], decider: "Dana", ...project }], chat: { adapter: "slack", channel: "slack:#team" }, quietHours: QUIET, createdAt: "x", ...extra };
    const ran: string[] = [];
    const asked: string[] = [];
    const queue = new OutboundQueue(board.db, () => now);
    const ex = new ActionExecutor({
      gateLog: new GateLog(board.db, () => now),
      queue,
      workstream: (id) => (id === ws.id ? ws : undefined),
      hardLimits: DEFAULT_HARD_LIMITS,
      mainBranchFor: async () => "main",
      performers: {
        "chat.post": async (a) => (ran.push(`chat ${String(a.payload?.text)}`), "posted"),
        "card.start": async () => (ran.push("card"), "started"),
        "owner.task": async () => {
          throw new Error("no room on the board");
        },
      },
      ask: async (a, _r, forWhom) => (asked.push(`${a.kind} for ${forWhom}`), "ot-1"),
      now: () => now,
      log: () => {},
    });
    return { ex, queue, ran, asked, ws, setNow: (d: Date) => (now = d) };
  }
  const chat = (text: string): ExecutorAction => ({ kind: "chat.post", workstreamId: "ws1", projectId: "p1", target: { channel: "slack:#team" }, payload: { text } });

  test("allowed: the performer runs; shadow: recorded, nothing runs; denied: nothing runs", async () => {
    const { ex, ran, setNow } = setup();
    setNow(MORNING);
    expect(await ex.execute(chat("hi"))).toMatchObject({ status: "done", detail: "posted" });
    expect(await ex.execute({ ...chat("x"), target: { channel: "slack:#random" } })).toMatchObject({ status: "denied", record: { rule: expect.stringContaining("hard-limit") } });
    const shadow = setup({ role: "shadow" });
    shadow.setNow(MORNING);
    expect(await shadow.ex.execute(chat("would"))).toMatchObject({ status: "recorded", record: { mode: "shadow" } });
    expect(ran).toEqual(["chat hi"]);
    expect(shadow.ran).toEqual([]);
  });

  test("ask verdicts raise an owner task naming who decides; no performer is unsupported; a throw is failed", async () => {
    const follow = setup({ role: "follow" });
    follow.setNow(MORNING);
    expect(await follow.ex.execute({ kind: "card.start", workstreamId: "ws1", projectId: "p1" })).toMatchObject({ status: "asked", ownerTaskId: "ot-1" });
    expect(follow.asked).toEqual(["card.start for Dana"]);
    expect(follow.ran).toEqual([]);
    const { ex, setNow } = setup();
    setNow(MORNING);
    expect(await ex.execute({ kind: "ticket.comment", workstreamId: "ws1", projectId: "p1" })).toMatchObject({ status: "unsupported" });
    expect(await ex.execute({ kind: "owner.task", workstreamId: "ws1", projectId: "p1" })).toMatchObject({ status: "failed", error: "no room on the board" });
  });

  test("quiet hours: outward actions queue with their flush time, flush in order once the window ends, and a re-decision can drop one", async () => {
    const { ex, queue, ran, setNow, ws } = setup();
    expect(await ex.execute(chat("one"))).toMatchObject({ status: "queued", flushAt: "2026-11-28T07:00:00.000Z" });
    await ex.execute(chat("two"));
    expect(await ex.execute({ kind: "card.start", workstreamId: "ws1", projectId: "p1" })).toMatchObject({ status: "done" });
    expect(await ex.flush()).toBe(0);
    expect(ran).toEqual(["card"]);
    setNow(MORNING);
    expect(ws.quietHours).toEqual(QUIET);
    expect(await ex.flush()).toBe(2);
    expect(ran).toEqual(["card", "chat one", "chat two"]);
    expect(queue.list({ workstreamId: "ws1" }).map((i) => i.status)).toEqual(["sent", "sent"]);

    // A re-decision at flush can drop one: the owner forbade chat for the
    // project meanwhile, so it isn't sent on the old verdict.
    const again = setup();
    await again.ex.execute(chat("late"));
    again.ws.projects[0]!.never = ["chat.post"];
    again.setNow(MORNING);
    await again.ex.flush();
    expect(again.ran).toEqual([]);
    expect(again.queue.list({ workstreamId: "ws1" })[0]).toMatchObject({ status: "dropped", result: "denied (never)" });
  });
});

describe("the API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-executor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("POST /workstreams/:id/actions goes through the gate: a decide project raises the owner task, a follow project asks, a bad kind is refused", async () => {
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const ids: string[] = [];
    for (const name of ["a", "b"]) {
      const repo = join(dir, name);
      mkdirSync(repo);
      Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
      ids.push((await call("POST", "/projects/local", { path: repo })).body.id as string);
    }
    const ws = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId: ids[0], role: "decide" }, { projectId: ids[1], role: "follow", decider: "Dana" }] })).body.id as string;
    const raise = await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "owner.task", projectId: ids[0], payload: { title: "Rotate the key", why: "It expires Friday.", steps: ["Rotate it"] } } });
    expect(raise).toMatchObject({ status: 200, body: { status: "done", detail: expect.stringContaining("raised owner task") } });
    const ask = await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "card.start", projectId: ids[1], payload: { card: { title: "x", body: "", labels: [] } } } });
    expect(ask).toMatchObject({ status: 202, body: { status: "asked" } });
    const owner = (await call("GET", "/owner-tasks?status=open")).body as unknown as Array<{ title: string }>;
    expect(owner.map((t) => t.title).sort()).toEqual(["Rotate the key", "Wissel asks Dana: card.start"]);
    expect((await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "rm" } })).status).toBe(400);
    expect((await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "card.start", projectId: "nope" } })).status).toBe(400);
    expect(((await call("GET", `/workstreams/${ws}/gate-log`)).body as unknown as unknown[]).length).toBe(2);
    expect((await call("GET", `/workstreams/${ws}/outbound`)).body).toEqual([] as never);
  });
});
