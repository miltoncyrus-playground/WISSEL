import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { Project } from "../src/core/types.ts";
import { ASK_TTL_MS, SqliteAsks, createAskService, describeAction, type Ask } from "../src/services/asks.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteChannelLog, inboxEventFromChannelEntry, type ChannelEntry } from "../src/services/channel.ts";
import { createCoordinatorDriver } from "../src/services/coordinator-driver.ts";
import { CoordinatorExecutor, SqliteOutboundQueue, gateContextFor, startOutboundFlusher, type ExecutableAction } from "../src/services/coordinator-executor.ts";
import { createCoordinatorWindow, type WindowDocument } from "../src/services/coordinator-window.ts";
import { SqliteConversationStore } from "../src/services/conversations.ts";
import { SqliteDecisionStore } from "../src/services/decision-cards.ts";
import { InboxDispatcher, SqliteInbox } from "../src/services/inbox.ts";
import { SqliteOwnerTaskStore } from "../src/services/owner-tasks.ts";
import { SqlitePendingActionStore } from "../src/services/pending-actions.ts";
import { DEFAULT_HARD_LIMITS, PolicyGate, SqliteGateLog, type HardLimits } from "../src/services/policy-gate.ts";
import { SqliteWorkstreamStore, type ProjectRole } from "../src/services/workstreams.ts";

// Asks (docs/SDD-coordinator.md §4.2 rules 5 and 7, §4.3, §4.9, §4.13): an
// ask-owner or ask-decider verdict reaches a person (an owner task, or a
// question on the channel for the decider) and their answer runs the
// action through the owner's authority, once, after the hard limits are
// checked again. Shadow records would-entries, never asks.

const REPO = "/repo/a";
const project: Project = { id: "p1", name: "a", path: REPO, source: "local", createdAt: "2026-11-09T00:00:00Z" };
const at = (iso: string) => new Date(iso);
const req = (path: string, method = "GET", body?: unknown): Request => new Request(`http://x${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function setup(role: ProjectRole, over: { mustAsk?: string[]; limits?: HardLimits } = {}) {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "checkout", ticket: "WS-7", projects: [{ projectId: "p1", role, decider: "Ana", decideAlone: ["naming"], mustAsk: over.mustAsk ?? ["channel.post"], never: [] }] });
  const ownerTasks = new SqliteOwnerTaskStore(board.db);
  const lines: string[] = [];
  const channelLog = new SqliteChannelLog(board.db, { log: (l) => void lines.push(l) });
  const gateLog = new SqliteGateLog(board.db);
  const clock = { now: at("2026-11-09T12:00:00Z") };
  const limits = { current: over.limits ?? DEFAULT_HARD_LIMITS };
  const gate = new PolicyGate(gateLog, () => clock.now);
  const context = async (a: ExecutableAction) => gateContextFor((await workstreams.get(a.workstreamId))!, a.projectId, { limits: limits.current, mainBranch: "main", shadow: false });
  const executed: string[] = [];
  const store = new SqliteAsks(board.db);
  const asks = createAskService({ store, ownerTasks, channelLog, workstreams, gate, gateLog, context, run: (a) => executor.runApproved(a), log: (l) => void lines.push(l), now: () => clock.now });
  const executor = new CoordinatorExecutor({
    gate, queue: new SqliteOutboundQueue(board.db), asks, context, quietHours: async () => undefined, now: () => clock.now,
    handlers: { "channel.post": async (a) => void executed.push(`post:${a.post}`), "pr.arm": async (a) => void executed.push(`arm:${a.payload?.pr}`), "owner.task": async () => void executed.push("owner") },
  });
  const inbox = new SqliteInbox(board.db);
  const dispatcher = new InboxDispatcher({ inbox, handlers: createCoordinatorDriver({ executor, board, workstreams, projects: { list: async () => [project] }, openDecisionCard: async () => {}, asks, logger: { warn() {} } }).handlers });
  const decide = (id = "evt-1"): ExecutableAction => ({ id, kind: "channel.post", workstreamId: ws.id, projectId: "p1", post: "decision", decision: "schema", payload: { message: { kind: "decision", about: { card: "A4", pr: "12" }, decision: "schema", text: "one table" } } });
  const answer = (from: string, questionRef: string, text: string, ref = `ans-${Math.random()}`) => dispatcher.ingest(inboxEventFromChannelEntry({ ref, at: clock.now.toISOString(), workstreamId: ws.id, message: { kind: "answer", from, about: { card: "A4" }, questionRef, text }, untrusted: true } satisfies ChannelEntry));
  return { board, ws, workstreams, ownerTasks, channelLog, gateLog, store, asks, executor, dispatcher, decide, answer, executed, lines, clock, limits };
}

test("ask-owner: a decide-role decision in mustAsk becomes one ask and one owner task; nothing executes; a replay adds no second ask", async () => {
  const s = await setup("decide");
  const r = await s.executor.execute(s.decide());
  expect(r).toMatchObject({ outcome: "asked", verdict: { verdict: "ask-owner", rule: "5:must-ask" }, ask: { status: "open", verdict: "ask-owner", workstreamId: s.ws.id } });
  const ask = (r as { ask: Ask }).ask;
  expect(s.executed).toEqual([]);
  const tasks = await s.ownerTasks.list();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.title).toContain(describeAction(ask.action));
  expect(tasks[0]!.why).toContain("5:must-ask");
  expect(tasks[0]!.steps.join("\n")).toContain(`/workstreams/${s.ws.id}/asks/${ask.id}/approve`);
  expect(tasks[0]!.steps.join("\n")).toContain(`/asks/${ask.id}/reject`);
  expect(s.lines.some((l) => l.startsWith("coordinator>") && l.includes(ask.id))).toBe(true);
  expect(s.channelLog.list(s.ws.id)).toEqual([]); // the owner is asked in the window, not on the channel

  const again = await s.executor.execute(s.decide());
  expect(again).toMatchObject({ outcome: "asked", ask: { id: ask.id } });
  expect(s.store.list(s.ws.id)).toHaveLength(1);
  expect(await s.ownerTasks.list()).toHaveLength(1);
  const other = await s.executor.execute(s.decide("evt-2"));
  expect((other as { ask: Ask }).ask.id).not.toBe(ask.id);
  expect(s.store.list(s.ws.id, "open")).toHaveLength(2);
});

test("a role change re-routes the project's open asks (§4.13): asked the other way is handed over, still asked the same way is kept, denied or Shadow is withdrawn; one handover note per change", async () => {
  const s = await setup("decide");
  const decision = (await s.executor.execute(s.decide("evt-1")) as { ask: Ask }).ask; // 5:must-ask asks the owner under decide
  const stop = (await s.executor.execute({ id: "evt-2", kind: "card.stop", workstreamId: s.ws.id, projectId: "p1", payload: { taskId: "t-1" } }) as { ask: Ask }).ask; // 7:default: the owner in any role
  expect([decision.verdict, stop.verdict]).toEqual(["ask-owner", "ask-owner"]);
  expect((await s.ownerTasks.list()).map((t) => t.status)).toEqual(["open", "open"]);
  await s.workstreams.setRole(s.ws.id, "p1", { role: "follow" });
  const r = await s.asks.onRoleChange(s.ws.id, "p1", "decide", "follow");
  expect(r.moved.map((a) => a.id)).toEqual([decision.id]);
  expect(r.kept.map((a) => a.id)).toEqual([stop.id]);
  expect(r.withdrawn).toEqual([]);
  const moved = s.store.get(decision.id)!;
  expect(moved).toMatchObject({ status: "open", verdict: "ask-decider", rule: "5:must-ask", ownerTaskId: decision.ownerTaskId, questionRef: expect.any(String) });
  expect(Object.fromEntries((await s.ownerTasks.list()).map((t) => [t.id, t.status]))).toEqual({ [decision.ownerTaskId!]: "dismissed", [stop.ownerTaskId!]: "open" });
  const posts = s.channelLog.list(s.ws.id).map((e) => e.message);
  expect(posts).toMatchObject([
    { kind: "question", from: "wissel", options: ["approve", "reject"], text: expect.stringContaining(`ask ${decision.id}`) },
    { kind: "handover", from: "wissel", to: "Ana", about: { ticket: "WS-7" }, text: `Role of p1 changed from decide to follow: 1 ask(s) handed over (${decision.id}: channel.post decision (schema): one table), 0 withdrawn, 1 unchanged.` },
  ]);
  expect(s.asks.byQuestionRef(s.ws.id, s.store.get(decision.id)!.questionRef!)?.id).toBe(decision.id); // the decider's answer on the channel now resolves it
  expect(s.executed).toEqual([]); // a role change runs nothing

  // Back the other way: the question stays on the channel as the record; the owner gets a task again.
  await s.workstreams.setRole(s.ws.id, "p1", { role: "decide" });
  const back = await s.asks.onRoleChange(s.ws.id, "p1", "follow", "decide");
  expect(back.moved.map((a) => a.id)).toEqual([decision.id]);
  expect(s.store.get(decision.id)).toMatchObject({ verdict: "ask-owner" });
  expect((await s.ownerTasks.list()).filter((t) => t.status === "open")).toHaveLength(2);
  expect(s.channelLog.list(s.ws.id).slice(-1)[0]!.message).toMatchObject({ kind: "handover", to: "owner" });

  // Shadow: both withdrawn, their owner tasks dismissed, nothing runs; a project with no open asks posts no note.
  await s.workstreams.setRole(s.ws.id, "p1", { role: "shadow" });
  const shadow = await s.asks.onRoleChange(s.ws.id, "p1", "decide", "shadow");
  expect(shadow.withdrawn.map((a) => a.id).sort()).toEqual([decision.id, stop.id].sort());
  expect(s.store.list(s.ws.id, "open")).toEqual([]);
  expect(s.store.get(stop.id)).toMatchObject({ status: "withdrawn", resolvedBy: "role-change", via: "role-change" });
  expect((await s.ownerTasks.list()).filter((t) => t.status === "open")).toEqual([]);
  expect(s.channelLog.list(s.ws.id).slice(-1)[0]!.message).toMatchObject({ kind: "handover", text: expect.stringContaining("2 withdrawn") });
  const quiet = s.channelLog.list(s.ws.id).length;
  await s.asks.onRoleChange(s.ws.id, "p1", "shadow", "decide");
  expect(s.channelLog.list(s.ws.id)).toHaveLength(quiet);
  expect(s.executed).toEqual([]);
});

test("approve runs the handler exactly once through an owner-approved gate record; a second approve is a 409; reject never executes", async () => {
  const s = await setup("decide");
  const ask = (await s.executor.execute(s.decide()) as { ask: Ask }).ask;
  s.clock.now = at("2026-11-09T13:00:00Z");
  const ok = await s.asks.approve(s.ws.id, ask.id, "owner", "api");
  expect(ok).toMatchObject({ ok: true, ask: { status: "approved", resolvedBy: "owner", via: "api", resolvedAt: "2026-11-09T13:00:00.000Z" } });
  expect(s.executed).toEqual(["post:decision"]);
  const records = await s.gateLog.list(s.ws.id);
  expect(records.map((r) => `${r.verdict}:${r.rule}`)).toEqual(["ask-owner:5:must-ask", "ask-owner:5:must-ask", `allow:owner-approved:${ask.id}`]); // the first ask, the approve's re-check, the approval
  expect((await s.ownerTasks.list())[0]!.status).toBe("done");
  expect(await s.asks.approve(s.ws.id, ask.id, "owner", "api")).toMatchObject({ ok: false, status: 409 });
  expect(await s.asks.approve("other-ws", ask.id, "owner", "api")).toMatchObject({ ok: false, status: 404 });
  expect(s.executed).toEqual(["post:decision"]);

  const second = (await s.executor.execute(s.decide("evt-2")) as { ask: Ask }).ask;
  expect(await s.asks.reject(s.ws.id, second.id, "owner", "api")).toMatchObject({ ok: true, ask: { status: "rejected" } });
  expect(await s.asks.approve(s.ws.id, second.id, "owner", "api")).toMatchObject({ ok: false, status: 409 });
  expect(s.executed).toEqual(["post:decision"]);
  expect(s.store.list(s.ws.id, "open")).toEqual([]);
});

test("approve re-checks the hard limits: an action that now trips one is refused with a 409 and stays open; a denied action never becomes an ask", async () => {
  const s = await setup("decide", { mustAsk: ["pr.arm"] });
  const arm: ExecutableAction = { id: "evt-arm", kind: "pr.arm", workstreamId: s.ws.id, projectId: "p1", base: "main", checks: "green", repo: REPO, payload: { pr: 12, taskId: "t1" } };
  const ask = (await s.executor.execute(arm) as { ask: Ask }).ask;
  s.limits.current = { production: [], readOnlyRepos: [REPO] }; // the repo became read-only after the ask
  const r = await s.asks.approve(s.ws.id, ask.id, "owner", "api");
  expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("1:hard-limit") });
  expect(s.executed).toEqual([]);
  expect(s.store.get(ask.id)!.status).toBe("open");
  expect(await s.executor.execute({ ...arm, id: "evt-arm-2" })).toMatchObject({ outcome: "refused", verdict: { verdict: "deny" } });
  expect(s.store.list(s.ws.id)).toHaveLength(1);
});

test("ask-decider: a follow-role ask posts a channel question; the decider's approve answer runs the action, anyone else's is input only; reject does nothing", async () => {
  const s = await setup("follow", { mustAsk: [] }); // follow: a decision post is ask-decider by the role table
  const ask = (await s.executor.execute(s.decide()) as { ask: Ask }).ask;
  expect(ask.verdict).toBe("ask-decider");
  const log = s.channelLog.list(s.ws.id);
  expect(log).toHaveLength(1);
  expect(log[0]!.message).toMatchObject({ kind: "question", from: "wissel", about: { card: "A4", pr: "12" }, options: ["approve", "reject"] });
  expect(s.store.get(ask.id)!.questionRef).toBe(log[0]!.ref);
  expect(await s.ownerTasks.list()).toEqual([]);

  await s.answer("Bob", log[0]!.ref, "approve"); // not the decider
  expect(s.executed).toEqual([]);
  expect(s.store.get(ask.id)!.status).toBe("open");
  await s.answer("Ana", log[0]!.ref, "something else"); // the decider, but no verdict
  expect(s.store.get(ask.id)!.status).toBe("open");
  await s.answer("Ana", log[0]!.ref, "Approve, go ahead");
  expect(s.executed).toEqual(["post:decision"]);
  expect(s.store.get(ask.id)).toMatchObject({ status: "approved", resolvedBy: "Ana", via: "channel" });
  await s.answer("Ana", log[0]!.ref, "approve again"); // already resolved: nothing runs again
  expect(s.executed).toEqual(["post:decision"]);

  const second = (await s.executor.execute(s.decide("evt-2")) as { ask: Ask }).ask;
  await s.answer("Ana", s.store.get(second.id)!.questionRef!, "REJECT");
  expect(s.store.get(second.id)!.status).toBe("rejected");
  expect(s.executed).toEqual(["post:decision"]);
});

test("Shadow makes would-entries, not asks; an ask expires after 7 days on the flusher tick and expiry does nothing", async () => {
  const shadow = await setup("shadow");
  expect((await shadow.executor.execute(shadow.decide())).outcome).toBe("would");
  expect(shadow.store.list(shadow.ws.id)).toEqual([]);
  expect(await shadow.ownerTasks.list()).toEqual([]);

  const s = await setup("decide");
  const ask = (await s.executor.execute(s.decide()) as { ask: Ask }).ask;
  const flusher = startOutboundFlusher({ executor: s.executor, workstreams: s.workstreams, asks: s.asks, now: () => s.clock.now, setInterval: () => 0, clearInterval() {}, logger() {} });
  await flusher.tick();
  expect(s.store.get(ask.id)!.status).toBe("open");
  s.clock.now = new Date(at("2026-11-09T12:00:00Z").getTime() + ASK_TTL_MS);
  await flusher.tick();
  expect(s.store.get(ask.id)).toMatchObject({ status: "expired", via: "sweep" });
  expect((await s.ownerTasks.list())[0]!.status).toBe("dismissed");
  expect(s.executed).toEqual([]);
  expect(await s.asks.approve(s.ws.id, ask.id, "owner", "api")).toMatchObject({ ok: false, status: 409 });
});

test("the window lists open asks as items and counts them in what waits on me", async () => {
  const s = await setup("decide");
  const ask = (await s.executor.execute(s.decide()) as { ask: Ask }).ask;
  const window = createCoordinatorWindow({
    db: s.board.db, board: s.board, workstreams: s.workstreams, ownerTasks: s.ownerTasks, decisions: new SqliteDecisionStore(s.board.db), channelLog: s.channelLog, asks: s.store,
    conversations: new SqliteConversationStore(s.board.db), pending: new SqlitePendingActionStore(s.board.db),
    outbound: async () => ({ quiet: false, queued: [] }), live: async () => ({ restartPending: false }), holdDispatch() {}, releaseDispatch() {}, requestRestart: () => ({ ok: true as const }),
  });
  const doc = (await window.document(s.ws.id))!;
  expect(doc.items.filter((i) => i.kind === "ask")).toEqual([{ kind: "ask", ask: expect.objectContaining({ id: ask.id, status: "open" }) }]);
  const waiting = await window.message(s.ws.id, { action: "waiting-on-me", log: false });
  expect(waiting.assistant.text).toContain(`Ask: ${describeAction(ask.action)}`);
  expect(doc.resolvedAsks).toEqual([]);
  await s.asks.reject(s.ws.id, ask.id, "owner", "api");
  const after = (await window.document(s.ws.id))!;
  expect(after.items.filter((i) => i.kind === "ask")).toEqual([]);
  expect(after.resolvedAsks).toEqual([expect.objectContaining({ id: ask.id, status: "rejected", resolvedBy: "owner", via: "api" })]); // the Log tab's "who and how"
});

test("API: GET the open asks, approve one through the owner's route, reject another; the app's own executor and window see them", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: ["card.stop"], never: [] }] });
  const stopped: string[] = [];
  const app = createApp(board, await Registry.load(), undefined, { hardLimits: DEFAULT_HARD_LIMITS, executor: { handlers: { "card.stop": async (a) => void stopped.push(String(a.payload?.taskId)) } } });
  const store = new SqliteAsks(board.db);
  // The route's asks come from the app's executor, so the first ask is made through a card the app will not stop by itself: seed one directly.
  const a1 = store.create({ id: "e1#0", kind: "card.stop", workstreamId: ws.id, projectId: "p1", payload: { taskId: "t-1" } }, { verdict: "ask-owner", rule: "5:must-ask", mode: "live" }, "2026-11-09T12:00:00.000Z");
  const a2 = store.create({ id: "e2#0", kind: "card.stop", workstreamId: ws.id, projectId: "p1", payload: { taskId: "t-2" } }, { verdict: "ask-owner", rule: "5:must-ask", mode: "live" }, "2026-11-09T12:01:00.000Z");
  expect(((await (await app(req(`/workstreams/${ws.id}/asks?status=open`))).json()) as Ask[]).map((a) => a.id)).toEqual([a1.id, a2.id]);
  expect((await app(req(`/workstreams/${ws.id}/asks?status=nope`))).status).toBe(400);
  const approved = await app(req(`/workstreams/${ws.id}/asks/${a1.id}/approve`, "POST"));
  expect(approved.status).toBe(200);
  expect(await approved.json()).toMatchObject({ ask: { id: a1.id, status: "approved", resolvedBy: "owner", via: "api" } });
  expect(stopped).toEqual(["t-1"]);
  expect((await app(req(`/workstreams/${ws.id}/asks/${a1.id}/approve`, "POST"))).status).toBe(409);
  expect((await app(req(`/workstreams/${ws.id}/asks/${a2.id}/reject`, "POST"))).status).toBe(200);
  expect((await app(req(`/workstreams/${ws.id}/asks/nope/approve`, "POST"))).status).toBe(404);
  expect((await app(req(`/workstreams/other/asks/${a2.id}/approve`, "POST"))).status).toBe(404);
  expect(((await (await app(req(`/workstreams/${ws.id}/asks?status=open`))).json()) as Ask[])).toEqual([]);
  expect(((await (await app(req(`/workstreams/${ws.id}/asks`))).json()) as Ask[]).map((a) => a.status)).toEqual(["approved", "rejected"]);
  expect(stopped).toEqual(["t-1"]);
  const doc = (await (await app(req(`/workstreams/${ws.id}/window`))).json()) as WindowDocument;
  expect(doc.items.filter((i) => i.kind === "ask")).toEqual([]);
});
