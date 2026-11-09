import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteChannelLog } from "../src/services/channel.ts";
import { SqliteConversationStore } from "../src/services/conversations.ts";
import { createCoordinatorWindow, QUICK_ACTIONS, validateWindowMessage, type WindowDocument, type WindowMessageResult } from "../src/services/coordinator-window.ts";
import { SqliteDecisionStore } from "../src/services/decision-cards.ts";
import { SqliteOwnerTaskStore } from "../src/services/owner-tasks.ts";
import { SqlitePendingActionStore } from "../src/services/pending-actions.ts";
import { SqliteWorkstreamStore } from "../src/services/workstreams.ts";

// The coordinator window's backend (docs/SDD-coordinator.md §4.14): one
// document per workstream (header, structured items, Decisions, Log) and
// a workstream-scoped conversation on the concierge's conversation and
// pending-action stores. Quick actions are code, no model; a policy
// change shows the change and waits for Confirm; "log it on the channel"
// is on by default and writes a status entry.

const req = (path: string, method = "GET", body?: unknown): Request => new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function setup() {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({
    name: "checkout",
    ticket: "SHOP-12",
    quietHours: { start: "00:00", end: "23:59", timezone: "UTC" },
    projects: [{ projectId: "p1", role: "decide", decider: "Ana", decideAlone: [], mustAsk: [], never: [] }, { projectId: "p2", role: "follow", decideAlone: [], mustAsk: [], never: [] }],
  });
  const ownerTasks = new SqliteOwnerTaskStore(board.db);
  const decisions = new SqliteDecisionStore(board.db);
  const channelLog = new SqliteChannelLog(board.db, { log() {} });
  const holds: string[] = [];
  const restarts: string[] = [];
  const window = createCoordinatorWindow({
    db: board.db, board, workstreams, ownerTasks, decisions, channelLog,
    conversations: new SqliteConversationStore(board.db),
    pending: new SqlitePendingActionStore(board.db),
    outbound: async () => ({ quiet: true, flushAt: "2026-11-09T23:59:00.000Z", queued: [{ id: "q1" }] as never }),
    live: async () => ({ dispatchHold: holds[0], restartPending: restarts.length > 0 }),
    holdDispatch: (reason) => void holds.push(reason),
    releaseDispatch: () => void holds.splice(0),
    requestRestart: () => (restarts.push("x"), { ok: true as const }),
    maxConcurrentTasks: 3,
  });
  return { board, ws, ownerTasks, decisions, channelLog, window, holds, restarts };
}

test("document: header, structured items, decisions and the log, all scoped to the workstream", async () => {
  const { board, ws, ownerTasks, decisions, channelLog, window } = await setup();
  const running = await board.create({ title: "A1 running", body: "", labels: [], dependsOn: [], workstreamId: ws.id, key: "A1" });
  await board.move(running.id, "running");
  const held = await board.create({ title: "A2 plan", body: "", labels: [], dependsOn: [], workstreamId: ws.id, key: "A2" });
  await board.create({ title: "A3 plan", body: "", labels: [], dependsOn: [], workstreamId: ws.id, key: "A3" });
  await board.create({ title: "other workstream", body: "", labels: [], dependsOn: [], workstreamId: "other" });
  const task = await ownerTasks.create({ title: "Log in to gh", why: "token expired", steps: ["run gh auth login"], check: ["gh", "auth", "status"], blocks: [held.id] });
  await ownerTasks.create({ title: "Elsewhere", why: "another workstream's card", steps: [], blocks: ["not-ours"] });
  const taken = decisions.create({ workstreamId: ws.id, text: "snake_case", alternative: "camelCase", by: "wissel" });
  const flipped = decisions.flip(decisions.create({ workstreamId: ws.id, text: "a", alternative: "b", by: "owner" }).id);
  decisions.create({ workstreamId: "other", text: "x", alternative: "y", by: "wissel" });
  await channelLog.adapter(ws.id).post({ kind: "claim", from: "wissel", about: { card: "A1" }, item: "A1", version: 1 });
  await channelLog.adapter(ws.id).post({ kind: "status", from: "Ana", about: { ticket: "SHOP-12" }, text: "payments PR is up" });
  await channelLog.adapter("other").post({ kind: "status", from: "x", about: { card: "c" }, text: "not ours" });

  const doc = (await window.document(ws.id))!;
  expect(doc.header).toEqual({
    workstream: { id: ws.id, name: "checkout", ticket: "SHOP-12" },
    roles: [{ projectId: "p1", role: "decide", decider: "Ana" }, { projectId: "p2", role: "follow" }],
    live: { dispatchHold: undefined, restartPending: false, running: 1 },
    cards: { live: 1, cap: 3 },
    channelLastWrittenAt: doc.log[1]!.at,
    quietHours: { start: "00:00", end: "23:59", timezone: "UTC", quiet: true },
    outbound: { queued: 1, flushAt: "2026-11-09T23:59:00.000Z" },
  });
  expect(doc.items).toEqual([
    { kind: "status", at: doc.log[1]!.at, from: "Ana", text: "payments PR is up" },
    { kind: "decision", decision: taken, flip: true },
    { kind: "decision", decision: flipped, flip: false },
    { kind: "owner-task", task, hasCheck: true },
    { kind: "plan", card: { id: held.id, key: "A2", title: "A2 plan", status: "inbox" }, held: `owner task: ${task.title}` },
    { kind: "plan", card: { id: expect.any(String), key: "A3", title: "A3 plan", status: "inbox" }, held: undefined },
  ]);
  expect(doc.decisions.map((d) => d.id)).toEqual([taken.id, flipped.id]);
  expect(doc.log.map((e) => e.message.kind)).toEqual(["claim", "status"]);
  expect(doc.conversation).toBeUndefined();
  expect(await window.document("nope")).toBeUndefined();
});

test("messages: status now and what waits on me answer at once and log a status entry unless told not to", async () => {
  const { ws, ownerTasks, channelLog, window } = await setup();
  await ownerTasks.create({ title: "Approve the token", why: "w", steps: ["open the console", "approve"], blocks: [] });
  expect(validateWindowMessage({ action: "status-now" })).toEqual({ ok: true, input: { action: "status-now", log: true } });
  expect(validateWindowMessage({ text: " pause ", log: false })).toEqual({ ok: true, input: { text: "pause", log: false } });
  for (const bad of [undefined, {}, { action: "dance" }, { text: "" }, { action: "status-now", log: "yes" }, { text: "x", extra: 1 }]) expect(validateWindowMessage(bad).ok).toBe(false);

  const status = await window.message(ws.id, { action: "status-now", log: true });
  expect(status.user.text).toBe("Status now");
  expect(status.assistant.text).toContain("p1 decide (Ana), p2 follow");
  expect(status.assistant.text).toContain("0 live of cap 3");
  expect(status.assistant.text).toContain("1 open owner task");
  expect(status.assistant.pending).toBeUndefined();
  const logged = channelLog.list(ws.id);
  expect(logged).toHaveLength(1);
  expect(logged[0]!.message).toMatchObject({ kind: "status", from: "owner", about: { ticket: "SHOP-12" }, text: expect.stringContaining("Status now") });

  const waiting = await window.message(ws.id, { action: "waiting-on-me", log: false });
  expect(waiting.conversation.id).toBe(status.conversation.id);
  expect(waiting.assistant.text).toContain("Approve the token");
  expect(waiting.assistant.text).toContain("open the console");
  expect(channelLog.list(ws.id)).toHaveLength(1);
  // Free text maps onto a quick action by its words; anything else gets the list.
  expect((await window.message(ws.id, { text: "what is waiting on me?", log: false })).assistant.text).toContain("Approve the token");
  expect((await window.message(ws.id, { text: "write a poem", log: false })).assistant.text).toContain(QUICK_ACTIONS.join(", "));
  const doc = (await window.document(ws.id))!;
  expect(doc.conversation!.conversation.id).toBe(status.conversation.id);
  expect(doc.conversation!.messages).toHaveLength(8);
});

test("messages: a policy change shows the change, waits for Confirm, then acts and logs; the Ask route refuses it", async () => {
  const { ws, channelLog, window, holds, restarts, board } = await setup();
  const pause = await window.message(ws.id, { action: "pause-new-cards", log: true });
  expect(pause.assistant.text).toContain("Change: new cards stop starting");
  expect(pause.assistant.text).toContain("Confirm");
  expect(pause.assistant.pending).toEqual([{ id: expect.any(String), kind: "confirm", lines: ["Pause new cards on checkout"], state: "open", expiresAt: expect.any(String) }]);
  expect(holds).toEqual([]);
  expect(channelLog.list(ws.id)).toHaveLength(0); // the change is logged when it happens, not when proposed

  const pid = pause.assistant.pending![0]!.id;
  expect((await window.confirm(ws.id, "nope", "confirm")).ok).toBe(false);
  const done = await window.confirm(ws.id, pid, "confirm");
  if (!done.ok) throw new Error(done.error);
  expect(done.value.pending.state).toBe("confirmed");
  expect(done.value.message.actions).toEqual([{ type: "window.pause-new-cards", window: true, ok: true, confirmedBy: "confirm", text: "Paused new cards on checkout; running ones continue." }]);
  expect(holds).toEqual(["paused from the coordinator window of checkout"]);
  expect(channelLog.list(ws.id).map((e) => (e.message as { text: string }).text)).toEqual(["Paused new cards on checkout; running ones continue."]);
  expect((await window.confirm(ws.id, pid, "confirm"))).toMatchObject({ ok: false, status: 409 });

  const restart = await window.message(ws.id, { action: "restart-when-idle", log: false });
  const rid = restart.assistant.pending![0]!.id;
  expect((await window.confirm(ws.id, rid, "cancel"))).toMatchObject({ ok: true, value: { pending: { state: "cancelled" } } });
  expect(restarts).toEqual([]);
  const again = await window.message(ws.id, { text: "restart when idle", log: false });
  await window.confirm(ws.id, again.assistant.pending![0]!.id, "confirm");
  expect(restarts).toEqual(["x"]);
  expect(channelLog.list(ws.id)).toHaveLength(1);

  // A window pending action is not a board control: the concierge's confirm refuses it instead of running it.
  const resume = await window.message(ws.id, { action: "resume-new-cards", log: false });
  const app = createApp(board, await Registry.load());
  const viaAsk = await app(req(`/ask/actions/${resume.assistant.pending![0]!.id}/confirm`, "POST", { conversationId: resume.conversation.id }));
  expect(viaAsk.status).toBe(409);
  expect(holds).toHaveLength(1);
});

test("API: GET the window, POST a message, confirm a change through the window's own route", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "shadow", decideAlone: [], mustAsk: [], never: [] }] });
  const app = createApp(board, await Registry.load(), undefined, { channelLog: new SqliteChannelLog(board.db, { log() {} }) });
  expect((await app(req("/workstreams/nope/window"))).status).toBe(404);
  const doc = (await (await app(req(`/workstreams/${ws.id}/window`))).json()) as WindowDocument;
  expect(doc.header).toMatchObject({ workstream: { id: ws.id, name: "w" }, roles: [{ projectId: "p1", role: "shadow" }], live: { restartPending: false, running: 0 }, cards: { live: 0 }, outbound: { queued: 0 } });
  expect(doc.header.quietHours).toBeUndefined();
  expect(doc.items).toEqual([]);

  expect((await app(req(`/workstreams/${ws.id}/window/messages`, "POST", { action: "dance" }))).status).toBe(400);
  const posted = await app(req(`/workstreams/${ws.id}/window/messages`, "POST", { action: "pause-new-cards" }));
  expect(posted.status).toBe(200);
  const r = (await posted.json()) as WindowMessageResult;
  const pid = r.assistant.pending![0]!.id;
  expect((await app(req(`/workstreams/${ws.id}/window/actions/${pid}/cancel`, "POST"))).status).toBe(200);
  expect((await app(req(`/workstreams/${ws.id}/window/actions/${pid}/confirm`, "POST"))).status).toBe(409);
  expect((await app(req(`/workstreams/${ws.id}/window/actions/nope/confirm`, "POST"))).status).toBe(404);

  const again = (await (await app(req(`/workstreams/${ws.id}/window/messages`, "POST", { action: "pause-new-cards" }))).json()) as WindowMessageResult;
  const confirmed = await app(req(`/workstreams/${ws.id}/window/actions/${again.assistant.pending![0]!.id}/confirm`, "POST"));
  expect(confirmed.status).toBe(200);
  const after = (await (await app(req(`/workstreams/${ws.id}/window`))).json()) as WindowDocument;
  expect(after.header.live.dispatchHold).toBe("paused from the coordinator window of w");
  expect(after.log.map((e) => e.message.kind)).toEqual(["status"]);
  expect(after.conversation!.messages.at(-1)!.actions[0]).toMatchObject({ type: "window.pause-new-cards", ok: true });
  // Restart needs a supervisor: the confirm runs, the action reports why it did not.
  const restart = (await (await app(req(`/workstreams/${ws.id}/window/messages`, "POST", { action: "restart-when-idle", log: false }))).json()) as WindowMessageResult;
  const failed = (await (await app(req(`/workstreams/${ws.id}/window/actions/${restart.assistant.pending![0]!.id}/confirm`, "POST"))).json()) as { message: { actions: { ok: boolean; error?: string }[] } };
  expect(failed.message.actions.at(-1)).toMatchObject({ ok: false, error: expect.stringContaining("WISSEL_SUPERVISED") });
});
