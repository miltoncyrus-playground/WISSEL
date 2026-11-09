import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { createRoleChanges } from "../src/services/role-changes.ts";
import { SqliteWorkstreamStore } from "../src/services/workstreams.ts";

// Role-change timing (docs/SDD-coordinator.md §4.13): a change during an arm
// waits for it; a held change is a row on the board's connection, so a
// restart (no arm in flight) applies it instead of losing it; once applied,
// the project's open asks are re-routed (asks.ts onRoleChange).

/** An executor with `arms` pr.arm handlers in flight; a held one never settles within the test (the process "restarts" instead). */
const fakeExecutor = (arms: number) => ({ armsInFlight: () => arms, whenArmsSettle: () => (arms === 0 ? Promise.resolve() : new Promise<void>(() => {})) });

test("a change held during an arm is persisted; a new instance on the same database applies it at startup and re-routes the asks; an applied one leaves no row", async () => {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "w", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }] });
  const rerouted: string[] = [];
  const asks = { onRoleChange: async (_ws: string, projectId: string, from: string, to: string) => { rerouted.push(`${projectId}:${from}>${to}`); return { kept: [], moved: [], withdrawn: [] }; } };
  const rows = () => board.db.query<{ projectId: string; change: string }, []>(`SELECT projectId, change FROM pending_role_changes`).all();
  const lines: string[] = [];

  const busy = fakeExecutor(1);
  const first = createRoleChanges({ workstreams, executor: busy, asks, db: board.db, log: (l) => void lines.push(l), now: () => new Date("2026-11-09T12:00:00Z") });
  const held = await first.request(ws.id, "p1", { role: "follow" });
  expect(held).toMatchObject({ applied: false, pending: { projectId: "p1", change: { role: "follow" }, waitingOn: "arm", requestedAt: "2026-11-09T12:00:00.000Z" } });
  expect(first.pending(ws.id)).toHaveLength(1);
  expect(rows()).toEqual([{ projectId: "p1", change: '{"role":"follow"}' }]);
  // The owner's last word wins: the row follows the replacement.
  await first.request(ws.id, "p1", { role: "shadow" });
  expect(rows()).toEqual([{ projectId: "p1", change: '{"role":"shadow"}' }]);
  expect((await workstreams.get(ws.id))!.projects[0]!.role).toBe("decide");
  expect(rerouted).toEqual([]);

  // A restart: nothing is in flight, so the held change lands through the same path, and the row goes.
  const restarted = createRoleChanges({ workstreams, executor: fakeExecutor(0), asks, db: board.db, log: (l) => void lines.push(l) });
  await new Promise((r) => setTimeout(r, 10));
  expect((await workstreams.get(ws.id))!.projects[0]!.role).toBe("shadow");
  expect(rows()).toEqual([]);
  expect(restarted.pending(ws.id)).toEqual([]);
  expect(rerouted).toEqual(["p1:decide>shadow"]);
  expect(lines).toContainEqual(`coordinator> ${ws.id}: role of p1 is now shadow`);

  // No arm in flight: applied at once, re-routed, no row written.
  expect(await restarted.request(ws.id, "p1", { role: "decide", decider: "Ana" })).toMatchObject({ applied: true, workstream: { projects: [{ role: "decide", decider: "Ana" }] } });
  expect(rows()).toEqual([]);
  expect(rerouted).toEqual(["p1:decide>shadow", "p1:shadow>decide"]);
});
