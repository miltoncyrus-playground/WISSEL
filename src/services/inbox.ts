// The event inbox (docs/SDD-coordinator.md §4.1, phase 3 card 13).
//
// One persisted queue every coordinator trigger goes through:
// - the board: a card reached review, failed or escalated;
// - the PR watcher (§4.7): checks finished, the PR went dirty, ready,
//   merged or closed;
// - the host guard (§4.12);
// - the owner: a message sent to it;
// - later the channel (§4.9) and the tracker (§4.10).
//
// Every event carries a source-stable id. Seeing the same event twice (the
// watcher's next look, a replayed day) is a no-op, which replaces the
// pilot's `board-seen.txt` and bookmark. The timestamp is the server's,
// never one an agent or a channel wrote: the pilot invented board
// timestamps twice.
//
// A small dispatcher takes unhandled events in the order they arrived and
// hands each to the handler for its kind. That is a deterministic one now;
// decision cards (card 16) and the gate (card 14) join it later. A kind
// with no handler is recorded as such. A handler that throws is retried
// once, then the event is marked failed with the error.
import type { Database } from "bun:sqlite";
import type { BoardEvent } from "./board.ts";
import type { PrChangedEvent } from "./pr-watcher.ts";

export type InboxSource = "board" | "code-host" | "channel" | "tracker" | "owner" | "host";
/** Sources whose payload someone outside Wissel wrote: never instructions. */
export const UNTRUSTED_SOURCES: ReadonlySet<InboxSource> = new Set(["code-host", "channel", "tracker"]);

export interface InboxEvent {
  id: string;
  source: InboxSource;
  kind: string;
  workstreamId?: string;
  payload: unknown;
  receivedAt: string;
  handledAt?: string;
  /** "handled" by a handler, "unrouted" when no handler takes the kind,
   *  "failed" after the retry. */
  outcome?: "handled" | "unrouted" | "failed";
  handler?: string;
  error?: string;
  attempts: number;
  untrusted: boolean;
}

export type NewInboxEvent = Pick<InboxEvent, "id" | "source" | "kind" | "workstreamId" | "payload">;

interface Row {
  id: string;
  source: InboxSource;
  kind: string;
  workstreamId: string | null;
  payload: string;
  receivedAt: string;
  handledAt: string | null;
  outcome: InboxEvent["outcome"] | null;
  handler: string | null;
  error: string | null;
  attempts: number;
}

const toEvent = (r: Row): InboxEvent => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  ...(r.workstreamId ? { workstreamId: r.workstreamId } : {}),
  payload: JSON.parse(r.payload) as unknown,
  receivedAt: r.receivedAt,
  ...(r.handledAt ? { handledAt: r.handledAt } : {}),
  ...(r.outcome ? { outcome: r.outcome } : {}),
  ...(r.handler ? { handler: r.handler } : {}),
  ...(r.error ? { error: r.error } : {}),
  attempts: r.attempts,
  untrusted: UNTRUSTED_SOURCES.has(r.source),
});

export const MAX_ATTEMPTS = 2;

export class InboxStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS inbox_events (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, workstreamId TEXT, payload TEXT NOT NULL,
      receivedAt TEXT NOT NULL, handledAt TEXT, outcome TEXT, handler TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
    );`);
    db.run("CREATE INDEX IF NOT EXISTS idx_inbox_unhandled ON inbox_events(handledAt, receivedAt);");
  }

  /** Adds an event. Returns false, changing nothing, for an id already in
   *  the inbox. The timestamp is always the server's. */
  add(e: NewInboxEvent): boolean {
    const r = this.db.run("INSERT OR IGNORE INTO inbox_events (id, source, kind, workstreamId, payload, receivedAt) VALUES (?, ?, ?, ?, ?, ?)", [
      e.id,
      e.source,
      e.kind,
      e.workstreamId ?? null,
      JSON.stringify(e.payload ?? null),
      this.clock().toISOString(),
    ]);
    return r.changes > 0;
  }

  get(id: string): InboxEvent | undefined {
    const r = this.db.query("SELECT * FROM inbox_events WHERE id = ?").get(id) as Row | null;
    return r ? toEvent(r) : undefined;
  }

  /** Newest first. */
  list(opts: { workstreamId?: string; unhandled?: boolean; limit?: number } = {}): InboxEvent[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.workstreamId) {
      where.push("workstreamId = ?");
      args.push(opts.workstreamId);
    }
    if (opts.unhandled) where.push("handledAt IS NULL");
    const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)));
    const sql = `SELECT * FROM inbox_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY receivedAt DESC, rowid DESC LIMIT ${limit}`;
    return (this.db.query(sql).all(...args) as Row[]).map(toEvent);
  }

  /** The oldest unhandled event. */
  next(): InboxEvent | undefined {
    const r = this.db.query("SELECT * FROM inbox_events WHERE handledAt IS NULL ORDER BY receivedAt, rowid LIMIT 1").get() as Row | null;
    return r ? toEvent(r) : undefined;
  }

  settle(id: string, outcome: NonNullable<InboxEvent["outcome"]>, handler: string, error?: string): void {
    this.db.run("UPDATE inbox_events SET handledAt = ?, outcome = ?, handler = ?, error = ?, attempts = attempts + 1 WHERE id = ?", [this.clock().toISOString(), outcome, handler, error ?? null, id]);
  }

  /** A failed attempt that will be retried. */
  retryLater(id: string, error: string): void {
    this.db.run("UPDATE inbox_events SET attempts = attempts + 1, error = ? WHERE id = ?", [error, id]);
  }
}

export type InboxHandler = (event: InboxEvent) => Promise<void>;

/** Hands unhandled events to the handler for their kind, oldest first,
 *  one at a time. `handlers` keys are exact kinds or a "prefix.*". */
export class InboxDispatcher {
  private draining: Promise<void> | undefined;

  constructor(
    private readonly store: InboxStore,
    private readonly handlers: Record<string, InboxHandler>,
    private readonly log: (line: string) => void = console.log,
  ) {}

  private handlerFor(kind: string): [string, InboxHandler] | undefined {
    if (this.handlers[kind]) return [kind, this.handlers[kind]!];
    const prefix = Object.keys(this.handlers).find((k) => k.endsWith(".*") && kind.startsWith(k.slice(0, -1)));
    return prefix ? [prefix, this.handlers[prefix]!] : undefined;
  }

  /** Adds an event and starts handling it. False for a seen id. */
  push(e: NewInboxEvent): boolean {
    const added = this.store.add(e);
    if (added) void this.drain();
    return added;
  }

  /** Handles every unhandled event; one drain at a time. */
  drain(): Promise<void> {
    this.draining ??= this.run().finally(() => (this.draining = undefined));
    return this.draining;
  }

  private async run(): Promise<void> {
    // Bounded: an event a handler keeps failing is settled after the
    // retry, so this always ends.
    for (let guard = 0; guard < 10_000; guard++) {
      const e = this.store.next();
      if (!e) return;
      const found = this.handlerFor(e.kind);
      if (!found) {
        this.store.settle(e.id, "unrouted", "none");
        continue;
      }
      const [name, handle] = found;
      try {
        await handle(e);
        this.store.settle(e.id, "handled", name);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        if (e.attempts + 1 >= MAX_ATTEMPTS) {
          this.store.settle(e.id, "failed", name, message);
          this.log(`inbox: ${e.kind} ${e.id} failed after ${MAX_ATTEMPTS} attempts: ${message}`);
        } else {
          this.store.retryLater(e.id, message);
        }
      }
    }
  }
}

/** The inbox event for a board change, or undefined when it isn't one
 *  the coordinator reacts to: a card reaching review, failed or
 *  escalated. The id is stable per card, status and round. */
export function boardInboxEvent(e: BoardEvent): NewInboxEvent | undefined {
  if (e.type !== "task.moved") return undefined;
  const t = e.task;
  if (t.status !== "review" && t.status !== "failed" && t.status !== "escalated") return undefined;
  return {
    id: `board:${t.id}:${t.status}:${t.round ?? (t.pushbackCount ?? 0) + 1}`,
    source: "board",
    kind: `card.${t.status}`,
    ...(t.workstreamId ? { workstreamId: t.workstreamId } : {}),
    payload: { taskId: t.id, title: t.title, ...(t.key ? { key: t.key } : {}), status: t.status },
  };
}

/** The inbox events for one PR watcher change: one per thing that
 *  happened (checks finished, went dirty, ready, merged, closed). Each id
 *  names the head it happened on, so the next look adds nothing. */
export function prInboxEvents(e: PrChangedEvent, workstreamId?: string): NewInboxEvent[] {
  const out: NewInboxEvent[] = [];
  const base = { source: "code-host" as const, ...(workstreamId ? { workstreamId } : {}), payload: { taskId: e.taskId, number: e.number, headSha: e.headSha, changes: e.changes } };
  const at = `${e.taskId}:${e.number}:${e.headSha}`;
  if (e.checks === "passing" || e.checks === "failing") out.push({ ...base, id: `pr:${at}:checks:${e.checks}`, kind: `pr.checks-${e.checks}` });
  if (e.mergeable === "dirty") out.push({ ...base, id: `pr:${at}:dirty`, kind: "pr.dirty" });
  if (e.lifecycle === "ready" || e.lifecycle === "merged" || e.lifecycle === "closed") out.push({ ...base, id: `pr:${at}:${e.lifecycle}`, kind: `pr.${e.lifecycle}` });
  return out;
}
