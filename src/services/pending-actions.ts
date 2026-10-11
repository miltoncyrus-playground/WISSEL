import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ControlAction } from "./concierge-actions.ts";
import type { ExecutedAction, PendingView } from "./conversations.ts";

// Ask's two-phase actions (docs/SDD-wissel-app.md §3.7): a Tier B action
// (or a batch over three cards) waits here for a Confirm tap, and an
// Undo chip's inverse action waits here for its tap. Only
// POST /ask/actions/:id/confirm takes one; the model has no way to. A
// pending action is used at most once, within PENDING_TTL_MS, in the
// conversation it was made in. Anything else fails closed.

/** How long a pending action can be confirmed. */
export const PENDING_TTL_MS = 10 * 60_000;

export type PendingKind = "confirm" | "undo";

export interface PendingAction {
  id: string;
  conversationId: string;
  /** The assistant message that proposed it. */
  messageId: string;
  kind: PendingKind;
  /** What a Confirm runs, in order. */
  actions: ControlAction[];
  /** One line per target, as the Confirm card shows it. */
  lines: string[];
  createdAt: string;
  expiresAt: string;
  /** When it was confirmed or cancelled; unset while open. */
  usedAt?: string;
  resolution?: "confirmed" | "cancelled";
  /** What a Confirm ran, once it did. */
  outcome?: ExecutedAction[];
}

/** Why a take or cancel was refused. */
export type PendingRefusal = "not-found" | "wrong-conversation" | "expired" | "used";

export const REFUSAL_TEXT: Record<PendingRefusal, string> = {
  "not-found": "no such pending action",
  "wrong-conversation": "that action belongs to another chat",
  expired: "that action expired; ask again",
  used: "that action was already confirmed or cancelled",
};

interface Row {
  id: string;
  conversationId: string;
  messageId: string;
  kind: string;
  actions: string;
  lines: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  resolution: string | null;
  outcome: string | null;
}

function fromRow(r: Row): PendingAction {
  return {
    id: r.id,
    conversationId: r.conversationId,
    messageId: r.messageId,
    kind: r.kind === "undo" ? "undo" : "confirm",
    actions: JSON.parse(r.actions) as ControlAction[],
    lines: JSON.parse(r.lines) as string[],
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ...(r.usedAt ? { usedAt: r.usedAt } : {}),
    ...(r.resolution === "confirmed" || r.resolution === "cancelled" ? { resolution: r.resolution } : {}),
    ...(r.outcome ? { outcome: JSON.parse(r.outcome) as ExecutedAction[] } : {}),
  };
}

/** Open, confirmed, cancelled, or expired (open and past its time). */
export function pendingState(p: PendingAction, now: Date): PendingView["state"] {
  if (p.resolution) return p.resolution;
  return Date.parse(p.expiresAt) <= now.getTime() ? "expired" : "open";
}

export function pendingView(p: PendingAction, now: Date): PendingView {
  return { id: p.id, kind: p.kind, lines: p.lines, state: pendingState(p, now), expiresAt: p.expiresAt };
}

export class SqlitePendingActionStore {
  constructor(
    private db: Database,
    private ttlMs = PENDING_TTL_MS,
  ) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ask_pending_actions (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        kind TEXT NOT NULL,
        actions TEXT NOT NULL,
        lines TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedAt TEXT,
        resolution TEXT,
        outcome TEXT
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS ask_pending_by_message ON ask_pending_actions (messageId);");
  }

  create(input: { conversationId: string; messageId: string; kind: PendingKind; actions: ControlAction[]; lines: string[] }, now = new Date()): PendingAction {
    const p: PendingAction = {
      id: randomUUID(),
      ...input,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.db.run("INSERT INTO ask_pending_actions (id, conversationId, messageId, kind, actions, lines, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      p.id,
      p.conversationId,
      p.messageId,
      p.kind,
      JSON.stringify(p.actions),
      JSON.stringify(p.lines),
      p.createdAt,
      p.expiresAt,
    ]);
    return p;
  }

  get(id: string): PendingAction | undefined {
    const row = this.db.query("SELECT * FROM ask_pending_actions WHERE id = ?").get(id) as Row | null;
    return row ? fromRow(row) : undefined;
  }

  /** A message's pending actions, oldest first. */
  forMessage(messageId: string): PendingAction[] {
    return (this.db.query("SELECT * FROM ask_pending_actions WHERE messageId = ? ORDER BY rowid").all(messageId) as Row[]).map(fromRow);
  }

  /** Why `id` can't be used now by `conversationId`, or undefined. */
  private refusal(id: string, conversationId: string, now: Date): PendingRefusal | undefined {
    const p = this.get(id);
    if (!p) return "not-found";
    if (p.conversationId !== conversationId) return "wrong-conversation";
    if (p.usedAt) return "used";
    if (Date.parse(p.expiresAt) <= now.getTime()) return "expired";
    return undefined;
  }

  /** Marks it used, atomically: of two taps at once only one gets it. */
  private use(id: string, conversationId: string, resolution: "confirmed" | "cancelled", now: Date): { ok: true; pending: PendingAction } | { ok: false; reason: PendingRefusal } {
    const at = now.toISOString();
    const changed = this.db.run(
      "UPDATE ask_pending_actions SET usedAt = ?, resolution = ? WHERE id = ? AND conversationId = ? AND usedAt IS NULL AND expiresAt > ?",
      [at, resolution, id, conversationId, at],
    ).changes;
    if (changed !== 1) return { ok: false, reason: this.refusal(id, conversationId, now) ?? "used" };
    return { ok: true, pending: this.get(id)! };
  }

  /** Takes it for a Confirm. The caller runs it, then calls finish. */
  take(id: string, conversationId: string, now = new Date()) {
    return this.use(id, conversationId, "confirmed", now);
  }

  cancel(id: string, conversationId: string, now = new Date()) {
    return this.use(id, conversationId, "cancelled", now);
  }

  /** Records what a Confirm ran. */
  finish(id: string, outcome: ExecutedAction[]): void {
    this.db.run("UPDATE ask_pending_actions SET outcome = ? WHERE id = ?", [JSON.stringify(outcome), id]);
  }
}
