import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteChannelLog, type ChannelMessage } from "../src/services/channel.ts";
import { channelHandlers, ownerMessageEvent, startChannelReader } from "../src/services/channel-sinks.ts";
import type { ExecutableAction } from "../src/services/coordinator-executor.ts";
import { InboxDispatcher, SqliteInbox, type InboxEvent, type NewInboxEvent } from "../src/services/inbox.ts";
import { SqliteWorkstreamStore } from "../src/services/workstreams.ts";

// Channel and chat sinks, and channel reading into the inbox
// (docs/SDD-coordinator.md §4.1, §4.3, §4.9, §4.14): the executor's
// channel.post and chat.post land in the board's channel log and on the
// owner's console; every new log entry becomes one inbox event, wissel's
// own posts excepted; a restart does not replay what was read.

const about = { card: "A4" };
const req = (path: string, method = "GET", body?: unknown): Request => new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function setup() {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "checkout", ticket: "SHOP-12", projects: [{ projectId: "p1", role: "decide", decider: "Ana", decideAlone: [], mustAsk: [], never: [] }] });
  const lines: string[] = [];
  const channelLog = new SqliteChannelLog(board.db, { log: (l) => void lines.push(l) });
  const inbox = new SqliteInbox(board.db);
  const ingested: NewInboxEvent[] = [];
  const handled: InboxEvent[] = [];
  const dispatcher = new InboxDispatcher({ inbox, handlers: { "channel.decision": (e) => void handled.push(e), "channel.status": (e) => void handled.push(e) }, logger: { warn() {} } });
  const ingest = (e: NewInboxEvent) => (ingested.push(e), dispatcher.ingest(e));
  const action = (kind: string, payload: Record<string, unknown>): ExecutableAction => ({ kind, workstreamId: ws.id, projectId: "p1", payload });
  return { board, workstreams, ws, lines, channelLog, inbox, ingested, handled, dispatcher: { ingest }, action };
}

test("channel.post: the message is validated, posted as wissel and echoed on the console; chat.post is a status line prefixed coordinator>", async () => {
  const s = await setup();
  const consoleLines: string[] = [];
  const handlers = channelHandlers({ channelLog: s.channelLog, workstreams: s.workstreams, log: (l) => void consoleLines.push(l) });

  const posted = (await handlers["channel.post"]!(s.action("channel.post", { message: { kind: "claim", from: "someone-else", about, item: "A4", version: 2 } }))) as { ref: string };
  expect(posted).toEqual({ ref: expect.any(String) });
  const entries = s.channelLog.list(s.ws.id);
  expect(entries.map((e) => [e.ref, e.message])).toEqual([[posted.ref, { kind: "claim", from: "wissel", about, item: "A4", version: 2 }]]); // `from` is forced to wissel
  expect(s.lines).toEqual([`channel ${s.ws.id}: claim from wissel [card A4] A4 v2`]); // the owner's console sink
  expect(consoleLines).toEqual([]);

  // An invalid message never reaches the log.
  await expect(handlers["channel.post"]!(s.action("channel.post", { message: { kind: "approve", from: "wissel", about, text: "approved" } }))).rejects.toThrow(/kind must be one of/);
  await expect(handlers["channel.post"]!(s.action("channel.post", { message: { kind: "status", from: "wissel", about, text: "x", role: "decide-over" } }))).rejects.toThrow(/unknown field role/);
  await expect(handlers["channel.post"]!(s.action("channel.post", {}))).rejects.toThrow(/message must be an object/);
  expect(s.channelLog.list(s.ws.id)).toHaveLength(1);

  // chat.post: a status entry in the same log, about {} filled from the workstream, and a coordinator> line.
  const chat = (await handlers["chat.post"]!(s.action("chat.post", { text: "Digest: 2 cards live, 1 PR open", about: {} }))) as { ref: string };
  const urgent = (await handlers["chat.post"]!(s.action("chat.post", { text: "URGENT: gh token expired", about: { card: "A4" } }))) as { ref: string };
  expect(s.channelLog.list(s.ws.id).slice(1).map((e) => [e.ref, e.message])).toEqual([
    [chat.ref, { kind: "status", from: "wissel", about: { ticket: "SHOP-12" }, text: "Digest: 2 cards live, 1 PR open" }],
    [urgent.ref, { kind: "status", from: "wissel", about: { card: "A4" }, text: "URGENT: gh token expired" }],
  ]);
  expect(consoleLines).toEqual(["coordinator> checkout: Digest: 2 cards live, 1 PR open", "coordinator> checkout: URGENT: gh token expired"]);
  await expect(handlers["chat.post"]!(s.action("chat.post", { text: "  " }))).rejects.toThrow(/text must be a non-empty string/);
  await expect(handlers["chat.post"]!({ ...s.action("chat.post", { text: "x" }), workstreamId: "nope" })).rejects.toThrow(/workstream not found: nope/);
});

test("reader: a decider entry reaches the inbox once, others are input-only, wissel's own entries never loop back, a restart does not replay", async () => {
  const s = await setup();
  const ch = s.channelLog.adapter(s.ws.id);
  // History from before the reader existed is the owner's record, not an event.
  await ch.post({ kind: "decision", from: "Ana", about, decision: "naming", text: "before the reader" });
  const reader = startChannelReader({ db: s.board.db, channelLog: s.channelLog, workstreams: s.workstreams, dispatcher: s.dispatcher, setInterval: () => 0, clearInterval() {} });
  await reader.tick();
  expect(s.ingested).toEqual([]);

  const own = await ch.post({ kind: "status", from: "wissel", about, text: "our own post" });
  const decided = await ch.post({ kind: "decision", from: "Ana", about, decision: "naming", text: "snake_case" });
  const other = await ch.post({ kind: "status", from: "Bo", about, text: "I think camelCase" });
  await s.channelLog.adapter("elsewhere").post({ kind: "status", from: "Ana", about, text: "another workstream, no reader" });
  await reader.tick();
  await reader.tick(); // nothing new: the cursor moved
  expect(s.ingested.map((e) => [e.id, e.kind, e.workstreamId])).toEqual([[`channel:${decided.ref}`, "channel.decision", s.ws.id], [`channel:${other.ref}`, "channel.status", s.ws.id]]);
  expect(s.ingested[0]!.payload).toEqual({ ref: decided.ref, at: expect.any(String), message: { kind: "decision", from: "Ana", about, decision: "naming", text: "snake_case" } });
  expect(s.ingested[1]!.payload).toMatchObject({ ref: other.ref, inputOnly: true }); // not the decider: stored, marked, and the driver ignores it
  expect(s.inbox.list().map((e) => [e.id, e.untrusted, e.handledAt !== undefined])).toEqual([[`channel:${decided.ref}`, true, true], [`channel:${other.ref}`, true, true]]);
  expect(s.inbox.get(`channel:${own.ref}`)).toBeUndefined();
  expect(s.handled.map((e) => e.id)).toEqual([`channel:${decided.ref}`, `channel:${other.ref}`]);

  // A restart: a new reader over the same database starts from the persisted cursor.
  reader.stop();
  const restarted = startChannelReader({ db: s.board.db, channelLog: s.channelLog, workstreams: s.workstreams, dispatcher: s.dispatcher, setInterval: () => 0, clearInterval() {} });
  await restarted.tick();
  expect(s.ingested).toHaveLength(2);
  const later = await ch.post({ kind: "answer", from: "Ana", about, questionRef: decided.ref, text: "yes" });
  await restarted.tick();
  expect(s.ingested.map((e) => e.id)).toEqual([`channel:${decided.ref}`, `channel:${other.ref}`, `channel:${later.ref}`]);

  // A workstream created after the reader started is read from its first entry.
  const fresh = await s.workstreams.create({ name: "fresh", projects: [{ projectId: "p2", role: "follow", decider: "Cy", decideAlone: [], mustAsk: [], never: [] }] });
  const first = await s.channelLog.adapter(fresh.id).post({ kind: "status", from: "Cy", about, text: "first" });
  await restarted.tick();
  expect(s.ingested.at(-1)).toMatchObject({ id: `channel:${first.ref}`, workstreamId: fresh.id });
  expect(s.ingested.at(-1)!.payload).not.toHaveProperty("inputOnly");
});

test("reader: the interval ticks, a workstream's failure leaves the others read, and stop clears the interval", async () => {
  const s = await setup();
  const ticks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const warnings: string[] = [];
  const reader = startChannelReader({
    db: s.board.db, channelLog: s.channelLog, workstreams: s.workstreams, logger: { warn: (m) => void warnings.push(m) },
    dispatcher: { ingest: async (e) => { if (e.workstreamId === s.ws.id) throw new Error("boom"); return s.dispatcher.ingest(e); } },
    setInterval: (fn, ms) => (expect(ms).toBe(5_000), ticks.push(fn), "handle"), clearInterval: (h) => void cleared.push(h),
  });
  const other = await s.workstreams.create({ name: "other", projects: [] });
  await s.channelLog.adapter(s.ws.id).post({ kind: "status", from: "Ana", about, text: "fails to ingest" });
  const ok = await s.channelLog.adapter(other.id).post({ kind: "status", from: "Ana", about, text: "read fine" });
  ticks[0]!();
  await new Promise((r) => setTimeout(r, 0));
  expect(s.ingested.map((e) => e.id)).toEqual([`channel:${ok.ref}`]);
  expect(warnings).toEqual([expect.stringContaining(`channel reader ${s.ws.id}: boom`)]);
  // The failed workstream's cursor did not move: the next tick reads it again.
  ticks[0]!();
  await new Promise((r) => setTimeout(r, 0));
  expect(warnings).toHaveLength(2);
  reader.stop();
  expect(cleared).toEqual(["handle"]);
});

test("ownerMessageEvent: a window message is an owner event with a stable id", () => {
  const message = { id: "m-1", conversationId: "c-1", role: "user" as const, text: "pause new cards", actions: [], dropped: [], at: "2026-11-09T12:00:00.000Z" };
  expect(ownerMessageEvent("ws-1", message, { text: "pause new cards", log: true })).toEqual({ id: "owner:m-1", source: "owner", kind: "owner.message", workstreamId: "ws-1", payload: { messageId: "m-1", conversationId: "c-1", text: "pause new cards", log: true } });
  expect(ownerMessageEvent("ws-1", message, { action: "status-now", log: false }).payload).toEqual({ messageId: "m-1", conversationId: "c-1", text: "pause new cards", action: "status-now", log: false });
});

test("server wiring: a window message lands in the inbox as owner.message; a decider's POST to the channel reaches the inbox through the reader", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "decide", decider: "Ana", decideAlone: [], mustAsk: [], never: [] }] });
  const channelLog = new SqliteChannelLog(board.db, { log() {} });
  const app = createApp(board, await Registry.load(), undefined, { channelLog });

  const sent = await app(req(`/workstreams/${ws.id}/window/messages`, "POST", { text: "what is waiting on me?", log: false }));
  expect(sent.status).toBe(200);
  const { user } = (await sent.json()) as { user: { id: string } };
  const inbox = (await (await app(req(`/workstreams/${ws.id}/inbox`))).json()) as InboxEvent[];
  expect(inbox.map((e) => [e.id, e.source, e.kind, e.untrusted])).toEqual([[`owner:${user.id}`, "owner", "owner.message", false]]);
  expect(inbox[0]!.payload).toMatchObject({ messageId: user.id, text: "what is waiting on me?", action: "waiting-on-me", log: false });

  const posted = await app(req(`/workstreams/${ws.id}/channel`, "POST", { kind: "decision", from: "Ana", about, decision: "naming", text: "snake_case" } satisfies ChannelMessage));
  const { ref } = (await posted.json()) as { ref: string };
  const deadline = Date.now() + 5_000;
  let ids: string[] = [];
  while (Date.now() < deadline && !ids.includes(`channel:${ref}`)) {
    await new Promise((r) => setTimeout(r, 25));
    ids = ((await (await app(req(`/workstreams/${ws.id}/inbox`))).json()) as InboxEvent[]).map((e) => e.id);
  }
  expect(ids).toEqual([`owner:${user.id}`, `channel:${ref}`]);
});
