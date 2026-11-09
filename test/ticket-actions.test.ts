import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { Project, TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { CoordinatorExecutor, SqliteOutboundQueue, gateContextFor, type ExecutableAction } from "../src/services/coordinator-executor.ts";
import type { NewInboxEvent } from "../src/services/inbox.ts";
import { DEFAULT_HARD_LIMITS, PolicyGate, SqliteGateLog } from "../src/services/policy-gate.ts";
import { SqliteTrackerMemory, createTrackerSync, ticketHandlers } from "../src/services/ticket-actions.ts";
import type { Ticket, TicketProvider, TicketTransition } from "../src/services/ticket-provider.ts";
import { SqliteWorkstreamStore, type ProjectRole } from "../src/services/workstreams.ts";

// Ticket handlers and tracker sync (docs/SDD-coordinator.md §4.3, §4.10):
// ticket.transition and ticket.comment write through the configured
// provider only with writeBack on; board events propose the move the
// cards call for through the executor; a ticket moved by someone else
// is left alone and becomes a tracker.moved inbox event.

const REPO = "/repo/a";
const project: Project = { id: "p1", name: "a", path: REPO, source: "local", createdAt: "2026-11-09T00:00:00Z" };
const TRANSITIONS: TicketTransition[] = [
  { id: "11", name: "Start", to: "In Progress" },
  { id: "21", name: "Review", to: "In Review" },
  { id: "31", name: "Finish", to: "Done" },
];

/** A tracker that remembers its status: a transition moves it, a manual move is `state.status = ...`. */
function fakeProvider(opts: { writeBack?: boolean; status?: string } = {}) {
  const calls: string[] = [];
  const state = { status: opts.status ?? "To Do" };
  const provider: TicketProvider = {
    id: "fake",
    writeBack: opts.writeBack ?? true,
    async lookup(keys): Promise<Record<string, Ticket>> {
      calls.push(`lookup ${keys.join(",")}`);
      const t: Ticket = { key: "WS-7", summary: "Checkout", status: state.status, url: "https://t.example/browse/WS-7" };
      return keys.includes("WS-7") ? { "WS-7": t } : {};
    },
    async transitions(key) {
      calls.push(`transitions ${key}`);
      return TRANSITIONS;
    },
    async comment(key, text) {
      calls.push(`comment ${key} ${text.split("\n")[0]}`);
    },
    async transition(key, id) {
      calls.push(`transition ${key} ${id}`);
      state.status = TRANSITIONS.find((t) => t.id === id)!.to;
    },
  };
  return { provider, calls, state };
}

async function setup(role: ProjectRole, provider: TicketProvider | undefined) {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "w", ticket: "WS-7", projects: [{ projectId: "p1", role, decideAlone: [], mustAsk: [], never: [] }] });
  const actions: ExecutableAction[] = [];
  const events: NewInboxEvent[] = [];
  const posts: string[] = [];
  const handlers: Record<string, (a: ExecutableAction) => Promise<unknown>> = {};
  const executor = new CoordinatorExecutor({
    gate: new PolicyGate(new SqliteGateLog(board.db)), queue: new SqliteOutboundQueue(board.db), handlers,
    context: async (a) => gateContextFor((await workstreams.get(a.workstreamId))!, a.projectId, { limits: DEFAULT_HARD_LIMITS, mainBranch: "main", shadow: false }),
    quietHours: async () => undefined,
  });
  const sync = createTrackerSync({
    memory: new SqliteTrackerMemory(board.db), provider: () => provider, board, workstreams, projects: { list: async () => [project] },
    executor: { execute: (a) => { actions.push(a); return executor.execute(a); } },
    inbox: async (e) => void events.push(e), logger: () => {},
  });
  Object.assign(handlers, sync.handlers, { "channel.post": async (a: ExecutableAction) => void posts.push(String((a.payload?.message as { text: string }).text)) });
  const card = (more: Partial<TaskCard> = {}) => board.create({ title: "A4 add the index", body: "", labels: [], dependsOn: [], repo: REPO, workstreamId: ws.id, key: "A4", ...more });
  const moved = async (task: TaskCard, status: TaskCard["status"]) => sync.onBoardEvent({ type: "task.moved", task: await board.move(task.id, status) });
  const act = (kind: string, payload: Record<string, unknown>, id = "x"): ExecutableAction => ({ id, kind, workstreamId: ws.id, projectId: "p1", payload });
  return { board, ws, executor, sync, actions, events, posts, card, moved, act };
}

test("with write-back off, or no tracker at all, both handlers throw 'tracker is read-only' before any call", async () => {
  const off = fakeProvider({ writeBack: false });
  const h = ticketHandlers({ memory: new SqliteTrackerMemory(new SqliteBoard().db), provider: () => off.provider, board: { list: async () => [] }, workstreams: { get: async () => undefined, list: async () => [] }, projects: { list: async () => [] } });
  const a = (kind: string, payload: Record<string, unknown>): ExecutableAction => ({ kind, workstreamId: "w", projectId: "p1", payload });
  await expect(h["ticket.transition"]!(a("ticket.transition", { key: "WS-7", to: "done" }))).rejects.toThrow(/tracker is read-only.*write-back is off for fake/);
  await expect(h["ticket.comment"]!(a("ticket.comment", { key: "WS-7", text: "hi" }))).rejects.toThrow(/tracker is read-only/);
  expect(off.calls).toEqual([]);
  const none = ticketHandlers({ memory: new SqliteTrackerMemory(new SqliteBoard().db), provider: () => undefined, board: { list: async () => [] }, workstreams: { get: async () => undefined, list: async () => [] }, projects: { list: async () => [] } });
  await expect(none["ticket.transition"]!(a("ticket.transition", { key: "WS-7", to: "done" }))).rejects.toThrow(/tracker is read-only.*no ticket tracker/);
  // Through the executor the throw is a failed entry, never a silent success.
  const s = await setup("decide", off.provider);
  expect(await s.executor.execute(s.act("ticket.comment", { key: "WS-7", text: "hi" }))).toMatchObject({ outcome: "failed", error: expect.stringContaining("tracker is read-only") });
});

test("with write-back on, ticket.transition moves the ticket once with its comment; the repeat and the driver's duplicate are idempotent", async () => {
  const f = fakeProvider();
  const s = await setup("decide", f.provider);
  const c = await s.card();
  await s.board.move(c.id, "running");
  // The stage comes from the cards sharing the key (in progress), not from the payload's "done".
  const first = await s.executor.execute(s.act("ticket.transition", { key: "WS-7", to: "done", taskId: c.id }, "code-host:x:pr.merged:1#0"));
  expect(first).toMatchObject({ outcome: "done", result: { written: true, from: "todo", to: "in-progress" } });
  expect(f.calls).toEqual(["lookup WS-7", "transitions WS-7", "transition WS-7 11", "comment WS-7 Wissel moved WS-7 to In Progress."]);
  const again = await s.executor.execute(s.act("ticket.transition", { key: "WS-7", to: "in-progress" }, "tracker:WS-7:in-progress"));
  expect(again).toMatchObject({ outcome: "done", result: { written: false, reason: expect.stringContaining("already In Progress") } });
  expect(f.calls.slice(4)).toEqual(["lookup WS-7"]);
  expect(s.sync.memory.get("WS-7")).toMatchObject({ written: "in-progress", observed: "in-progress", foreign: false, workstreamId: s.ws.id });
  // ticket.comment writes straight through; a ticket the board has no cards for takes the payload's stage.
  expect((await s.executor.execute(s.act("ticket.comment", { key: "WS-7", text: "note" }))).outcome).toBe("done");
  expect(f.calls.at(-1)).toBe("comment WS-7 note");
  const noCards = await s.executor.execute(s.act("ticket.transition", { key: "WS-8", to: "done" }));
  expect(noCards).toMatchObject({ outcome: "failed", error: expect.stringContaining("does not know WS-8") });
});

test("board events propose the move the cards call for, once per stage; the handler writes it", async () => {
  const f = fakeProvider();
  const s = await setup("decide", f.provider);
  const c = await s.card();
  await s.sync.onBoardEvent({ type: "task.created", task: c });
  expect(s.actions).toEqual([]); // todo: nothing to move
  await s.moved(c, "running");
  await s.moved(c, "review"); // still in progress: no second proposal
  expect(s.actions.map((a) => `${a.id}:${a.kind}`)).toEqual(["tracker:WS-7:in-progress:ticket.transition"]);
  expect(s.actions[0]).toMatchObject({ workstreamId: s.ws.id, projectId: "p1", payload: { key: "WS-7", to: "in-progress", taskId: c.id } });
  expect(f.state.status).toBe("In Progress");
  const withPr = await s.board.updateFields(c.id, { pr: { number: 3, url: "https://code.example/pr/3", head: "feat/a4" } });
  await s.sync.onBoardEvent({ type: "task.updated", task: withPr });
  const merged = await s.board.updateFields(c.id, { pr: { ...withPr.pr!, lifecycle: "merged" } });
  await s.sync.onBoardEvent({ type: "task.updated", task: merged });
  expect(s.actions.map((a) => a.id)).toEqual(["tracker:WS-7:in-progress", "tracker:WS-7:in-review", "tracker:WS-7:done"]);
  expect(f.state.status).toBe("Done");
  expect(f.calls.filter((x) => x.startsWith("transition "))).toEqual(["transition WS-7 11", "transition WS-7 21", "transition WS-7 31"]);
  // A card outside every workstream, or without a ticket, proposes nothing.
  const loose = await s.board.create({ title: "loose", body: "", labels: [], dependsOn: [], repo: "/elsewhere" });
  await s.sync.onBoardEvent({ type: "task.moved", task: { ...loose, status: "running" } });
  expect(s.actions).toHaveLength(3);
});

test("a ticket moved by someone else is left alone and raises a tracker.moved inbox event, whose handler posts a status line", async () => {
  const f = fakeProvider();
  const s = await setup("decide", f.provider);
  const c = await s.card();
  await s.moved(c, "running");
  expect(f.state.status).toBe("In Progress");
  f.state.status = "To Do"; // a human moves it back
  await s.sync.poll();
  expect(s.events).toEqual([{ id: "tracker:WS-7:moved:To Do", source: "tracker", kind: "tracker.moved", workstreamId: s.ws.id, payload: { key: "WS-7", status: "To Do", stage: "todo", wrote: "in-progress" } }]);
  await s.sync.poll(); // the same observation again is not a second event
  expect(s.events).toHaveLength(1);
  expect(s.sync.memory.get("WS-7")).toMatchObject({ foreign: true, status: "To Do" });
  // Neither the trigger nor a direct action writes to it now.
  const withPr = await s.board.updateFields(c.id, { pr: { number: 3, url: "u", head: "feat/a4" } });
  await s.sync.onBoardEvent({ type: "task.updated", task: withPr });
  expect(s.actions.map((a) => a.id)).toEqual(["tracker:WS-7:in-progress"]);
  expect(await s.executor.execute(s.act("ticket.transition", { key: "WS-7", to: "done" }))).toMatchObject({ outcome: "failed", error: expect.stringContaining("moved to To Do outside Wissel") });
  expect(f.calls.filter((x) => x.startsWith("transition ") || x.startsWith("comment "))).toHaveLength(2);
  // The inbox handler turns the event into a gated status post.
  await s.sync.inboxHandlers["tracker.moved"]!({ ...s.events[0]!, untrusted: true, receivedAt: "2026-11-09T12:00:00Z" });
  expect(s.posts).toEqual([expect.stringContaining("WS-7 was moved to To Do outside Wissel")]);
  // Back where Wissel left it: hands on again.
  f.state.status = "In Progress";
  await s.sync.poll();
  expect(s.sync.memory.get("WS-7")).toMatchObject({ foreign: false });
  // Without a provider the poll reads nothing.
  const dark = await setup("decide", undefined);
  await dark.sync.poll();
  expect(dark.events).toEqual([]);
});

test("Shadow records would-entries only: no handler runs and the tracker is never written", async () => {
  const f = fakeProvider();
  const s = await setup("shadow", f.provider);
  const c = await s.card();
  await s.moved(c, "running");
  await s.moved(c, "review");
  await s.sync.onBoardEvent({ type: "task.updated", task: await s.board.updateFields(c.id, { pr: { number: 3, url: "u", head: "feat/a4" } }) });
  expect((await s.executor.status(s.ws.id)).would.map((e) => `${e.action.id}=${e.verdict}`)).toEqual(["tracker:WS-7:in-progress=allow", "tracker:WS-7:in-review=allow"]);
  expect(f.calls).toEqual([]);
  expect(s.sync.memory.get("WS-7")).toBeUndefined();
});

test("createApp wires the handlers and the board-event trigger to the configured provider", async () => {
  const f = fakeProvider();
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", ticket: "WS-7", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }] });
  createApp(board, await Registry.load(), undefined, { hardLimits: DEFAULT_HARD_LIMITS, tickets: { provider: f.provider }, inbox: { handlers: {} } });
  const c = await board.create({ title: "A4 add the index", body: "", labels: [], dependsOn: [], workstreamId: ws.id, key: "A4" });
  await board.move(c.id, "running");
  await new Promise((r) => setTimeout(r, 20));
  expect(f.calls).toEqual(["lookup WS-7", "transitions WS-7", "transition WS-7 11", "comment WS-7 Wissel moved WS-7 to In Progress."]);
});
