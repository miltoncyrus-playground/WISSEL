// Restart when idle (docs/SDD-coordinator.md §4.12): POST
// /admin/restart-when-idle holds new dispatches, waits for the cards
// still running, then exits with code 75 for the supervisor to restart
// the process. DELETE cancels, GET reports. Refused without
// WISSEL_SUPERVISED=1, since nothing would start wissel again (§10).
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createApp } from "../src/api/server.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { RESTART_EXIT_CODE, RestartWhenIdle, type RestartWhenIdleStatus } from "../src/core/restart-when-idle.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

/** Flushes the microtasks a check() round takes (one awaited running()). */
const settle = () => new Promise((r) => setTimeout(r, 0));

function harness(opts: { supervised?: boolean; running?: string[] } = {}) {
  const events = new EventEmitter();
  const exits: number[] = [];
  const holds: string[] = [];
  let running = opts.running ?? [];
  const log: string[] = [];
  const restart = new RestartWhenIdle({
    supervised: opts.supervised ?? true,
    exit: (code) => exits.push(code),
    holdDispatch: () => holds.push("hold"),
    releaseDispatch: () => holds.push("release"),
    running: async () => running,
    events,
    pollMs: 0,
    log: (line) => log.push(line),
  });
  return { restart, events, exits, holds, log, setRunning: (ids: string[]) => (running = ids) };
}

test("refused when unsupervised: nothing held, nothing exits, and the message says what to set", async () => {
  const { restart, exits, holds } = harness({ supervised: false });
  const r = restart.request();
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("WISSEL_SUPERVISED=1");
  await settle();
  expect(holds).toEqual([]);
  expect(exits).toEqual([]);
  expect((await restart.status()).pending).toBe(false);
});

test("exits with 75 only after the last running card finishes, and only once", async () => {
  const { restart, events, exits, holds, setRunning } = harness({ running: ["a", "b"] });
  expect(restart.request()).toEqual({ ok: true });
  await settle();
  expect(holds).toEqual(["hold"]);
  expect(exits).toEqual([]);
  expect(await restart.status()).toMatchObject({ pending: true, running: ["a", "b"], exitCode: 75 });

  setRunning(["b"]);
  events.emit("event", { type: "task.moved" });
  await settle();
  expect(exits).toEqual([]);

  setRunning([]);
  events.emit("event", { type: "task.moved" });
  events.emit("event", { type: "task.moved" });
  await settle();
  expect(exits).toEqual([RESTART_EXIT_CODE]);
  expect(RESTART_EXIT_CODE).toBe(75);
});

test("a second request while pending is a no-op; cancel releases dispatch and a later idle board does not exit", async () => {
  const { restart, events, exits, holds, setRunning } = harness({ running: ["a"] });
  restart.request();
  restart.request();
  await settle();
  expect(holds).toEqual(["hold"]);

  expect(restart.cancel()).toBe(true);
  expect(restart.cancel()).toBe(false);
  expect(holds).toEqual(["hold", "release"]);
  expect((await restart.status()).pending).toBe(false);

  setRunning([]);
  events.emit("event", { type: "task.moved" });
  await settle();
  expect(exits).toEqual([]);
});

test("an idle board exits right away on request", async () => {
  const { restart, exits } = harness({ running: [] });
  restart.request();
  await settle();
  expect(exits).toEqual([75]);
});

function fakeExecutor(tier: "readonly" | "write", run: Executor["run"]): Executor {
  return { id: `fake-${tier}`, harnessTool: "claude-cli", canHandle: (agent: AgentDef) => agent.tier === tier, run };
}

test("orchestrator: no dispatch while held; release sweeps the waiting card", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const ran: string[] = [];
  const orchestrator = new Orchestrator(board, registry, new Router(registry), [
    fakeExecutor("readonly", async (task, agent) => {
      ran.push(task.id);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" };
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  orchestrator.holdDispatch("restart", "restart pending");
  await orchestrator.sweep();
  const held = (await board.get(task.id))!;
  expect(held.status).toBe("inbox");
  expect(held.routedTo).toBeUndefined();
  expect(ran).toEqual([]);
  expect(orchestrator.dispatchHold).toBe("restart pending");

  // A human's Run is a dispatch too.
  await expect(orchestrator.runNow(task.id, [])).rejects.toThrow("restart pending");
  expect(orchestrator.inFlightTaskIds()).toEqual([]);

  orchestrator.releaseDispatch("restart");
  expect(orchestrator.dispatchHold).toBeUndefined();
  await orchestrator.sweep();
  expect(ran).toEqual([task.id]);
  expect((await board.get(task.id))!.status).toBe("done");
});

test("API: POST holds, GET reports the running card, exit 75 once it is done; unsupervised is 409", async () => {
  const registry = await Registry.load();

  const unsupervised = createApp(new SqliteBoard(), registry, undefined, { exit: () => {} });
  const refused = await unsupervised(req("/admin/restart-when-idle", { method: "POST" }));
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toContain("WISSEL_SUPERVISED=1");

  const board = new SqliteBoard();
  const exits: number[] = [];
  const app = createApp(board, registry, undefined, { supervised: true, exit: (code) => exits.push(code) });
  const card = await board.create({ title: "busy", body: "", labels: ["code"], repo: "r" });
  await board.move(card.id, "running");

  const idle = (await (await app(req("/admin/restart-when-idle"))).json()) as RestartWhenIdleStatus;
  expect(idle).toMatchObject({ pending: false, supervised: true, running: [card.id] });

  const accepted = await app(req("/admin/restart-when-idle", { method: "POST" }));
  expect(accepted.status).toBe(202);
  expect((await accepted.json()) as RestartWhenIdleStatus).toMatchObject({ pending: true, running: [card.id] });
  await settle();
  expect(exits).toEqual([]);

  // A fresh card cannot be started by hand while draining.
  const waiting = await board.create({ title: "later", body: "", labels: ["intake"], repo: "r" });
  const run = await app(req(`/tasks/${waiting.id}/run`, { method: "POST" }));
  expect(run.status).toBe(409);
  expect(((await run.json()) as { error: string }).error).toContain("restart");

  // Cancel, then re-request: the cancel must have fully released.
  const cancelled = await app(req("/admin/restart-when-idle", { method: "DELETE" }));
  expect(((await cancelled.json()) as RestartWhenIdleStatus).pending).toBe(false);
  expect((await app(req("/admin/restart-when-idle", { method: "POST" }))).status).toBe(202);

  await board.move(card.id, "done");
  await settle();
  expect(exits).toEqual([75]);
  const after = (await (await app(req("/admin/restart-when-idle"))).json()) as RestartWhenIdleStatus;
  expect(after.pending).toBe(true);
  expect((after as { running: TaskCard["id"][] }).running).toEqual([]);
});
