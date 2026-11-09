import type { Database } from "bun:sqlite";
import { type About, type ChannelEntry, type ChannelMessage, inboxEventFromChannelEntry, type SqliteChannelLog, validateChannelMessage } from "./channel.ts";
import type { ChatMessage } from "./conversations.ts";
import type { ActionHandlers } from "./coordinator-executor.ts";
import type { WindowMessageInput } from "./coordinator-window.ts";
import type { NewInboxEvent } from "./inbox.ts";
import type { Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * The channel's two halves around the executor and the inbox
 * (docs/SDD-coordinator.md §4.1, §4.3, §4.9, §4.14).
 *
 * Sinks: the executor's `channel.post` and `chat.post` handlers. Both write
 * the board's channel log (the one adapter, channel.ts) and print a line
 * the owner reads in the server terminal; neither calls a network. There
 * is no chat service, so `chat.post` is a status entry in the same log
 * plus a `coordinator>` line.
 *
 * Reader: every new entry in a workstream's log becomes one inbox event,
 * `inboxEventFromChannelEntry`, through the dispatcher. Wissel's own
 * entries are skipped (they would loop back); an entry from anyone but a
 * decider of the workstream's projects is stored and marked `inputOnly`
 * (the driver ignores non-deciders anyway). The read cursor is persisted
 * per workstream, so a restart continues where it stopped instead of
 * replaying; the inbox's own ids would dedupe a replay, but the handlers
 * would still run. Entries that were in a log before the reader first
 * saw it are the owner's record, not new events: the first start sets
 * each existing workstream's cursor to the end of its log. A workstream
 * created later is read from its first entry.
 *
 * Owner: a message posted from the coordinator window becomes an
 * `owner.message` event (source "owner", trusted), so the driver sees it.
 */
export interface ChannelSinkDeps {
  channelLog: Pick<SqliteChannelLog, "adapter">;
  workstreams: Pick<WorkstreamStore, "get">;
  /** The owner's console; `coordinator>` lines go here. Defaults to console.log. */
  log?: (line: string) => void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown, name: string): string => (typeof v === "string" && v.trim() !== "" ? v : (() => { throw new Error(`${name} must be a non-empty string`); })());
/** §4.9: a message names a card, PR or ticket; a chat line about nothing in particular is about the workstream's ticket, else the workstream. */
const defaultAbout = (ws: Workstream, about: unknown): About => (isRecord(about) && Object.keys(about).length > 0 ? (about as About) : ws.ticket ? { ticket: ws.ticket } : { card: ws.id });

export function channelHandlers(deps: ChannelSinkDeps): ActionHandlers {
  const log = deps.log ?? ((line: string) => console.log(line));
  const must = async (id: string): Promise<Workstream> => {
    const ws = await deps.workstreams.get(id);
    if (!ws) throw new Error(`workstream not found: ${id}`);
    return ws;
  };
  return {
    // The log's own sink prints channelLogLine for every post, so the owner sees each coordinator post once.
    "channel.post": async (a) => {
      const body = a.payload?.message;
      if (!isRecord(body)) throw new Error("channel.post: message must be an object");
      const check = validateChannelMessage({ ...body, from: "wissel" });
      if (!check.ok) throw new Error(`channel.post refused: ${check.error}`);
      return deps.channelLog.adapter(a.workstreamId).post(check.message);
    },
    "chat.post": async (a) => {
      const text = nonEmpty(a.payload?.text, "chat.post: text");
      const ws = await must(a.workstreamId);
      const message: ChannelMessage = { kind: "status", from: "wissel", about: defaultAbout(ws, a.payload?.about), text };
      const posted = await deps.channelLog.adapter(ws.id).post(message);
      log(`coordinator> ${ws.name}: ${text.replace(/\s+/g, " ")}`);
      return posted;
    },
  };
}

/** The inbox event for a log entry, or undefined for one of wissel's own.
 *  `deciders` are the workstream's project deciders: anyone else's entry
 *  is marked `inputOnly` in the payload. */
export function channelInboxEvent(entry: ChannelEntry, deciders: readonly string[]): NewInboxEvent | undefined {
  if (entry.message.from === "wissel") return undefined;
  const event = inboxEventFromChannelEntry(entry);
  return deciders.includes(entry.message.from) ? event : { ...event, payload: { ...(event.payload as Record<string, unknown>), inputOnly: true } };
}

/** The owner's window message as an inbox event (§4.1, §4.14): the id is the stored message's, so one message is one event. */
export function ownerMessageEvent(workstreamId: string, message: Pick<ChatMessage, "id" | "conversationId" | "text">, input: WindowMessageInput): NewInboxEvent {
  return { id: `owner:${message.id}`, source: "owner", kind: "owner.message", workstreamId, payload: { messageId: message.id, conversationId: message.conversationId, text: message.text, ...(input.action ? { action: input.action } : {}), log: input.log } };
}

export interface ChannelReaderOptions {
  /** The board's connection: the cursors live in `channel_cursors`. */
  db: Database;
  channelLog: Pick<SqliteChannelLog, "adapter">;
  workstreams: Pick<WorkstreamStore, "list">;
  dispatcher: { ingest(event: NewInboxEvent): Promise<unknown> };
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: { warn(message: string): void };
}

/** Polls every workstream's log from its persisted cursor (the log has no
 *  append signal); `tick` is the poll, exposed for tests and for a nudge
 *  after a post. */
export function startChannelReader(opts: ChannelReaderOptions): { tick: () => Promise<void>; stop: () => void } {
  const log = opts.logger ?? console;
  opts.db.run(`CREATE TABLE IF NOT EXISTS channel_cursors (workstreamId TEXT PRIMARY KEY, cursor TEXT NOT NULL)`);
  const cursorOf = (wsId: string): string | undefined => opts.db.query<{ cursor: string }, [string]>(`SELECT cursor FROM channel_cursors WHERE workstreamId = ?`).get(wsId)?.cursor;
  const setCursor = (wsId: string, cursor: string): void => void opts.db.query(`INSERT OR REPLACE INTO channel_cursors (workstreamId, cursor) VALUES (?, ?)`).run(wsId, cursor);

  // First start: what is already in a log predates the reader; begin at its end.
  const init = (async () => {
    for (const ws of await opts.workstreams.list()) if (cursorOf(ws.id) === undefined) setCursor(ws.id, (await opts.channelLog.adapter(ws.id).read("")).next);
  })().catch((e) => log.warn(`channel reader: could not set the starting cursors: ${e instanceof Error ? e.message : String(e)}`));

  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await init;
      for (const ws of await opts.workstreams.list()) {
        try {
          const deciders = ws.projects.flatMap((p) => (p.decider ? [p.decider] : []));
          const cursor = cursorOf(ws.id) ?? "";
          const { entries, next } = await opts.channelLog.adapter(ws.id).read(cursor);
          for (const entry of entries) {
            const event = channelInboxEvent(entry, deciders);
            if (event) await opts.dispatcher.ingest(event);
          }
          if (next !== cursor) setCursor(ws.id, next);
        } catch (e) {
          log.warn(`channel reader ${ws.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log.warn(`channel reader: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  const handle = (opts.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); (h as { unref?: () => void }).unref?.(); return h; }))(() => void tick(), opts.intervalMs ?? 5_000);
  return { tick, stop: () => (opts.clearInterval ?? ((h) => clearInterval(h as Parameters<typeof clearInterval>[0])))(handle) };
}
