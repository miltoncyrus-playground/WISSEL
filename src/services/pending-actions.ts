import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { TaskCard } from "../core/types.ts";
import type { ControlAction } from "./concierge-actions.ts";
import type { ExecutedAction, PendingView } from "./conversations.ts";

// Ask's two-phase actions (docs/SDD-wissel-app.md §3.7): a Tier B action
// (or a batch over three cards) waits here for a Confirm tap, and an
// Undo chip's inverse action waits here for its tap. Only
// POST /ask/actions/:id/confirm takes one; the model has no way to. A
// pending action is used at most once, within PENDING_TTL_MS, in the
// conversation it was made in. Anything else fails closed.
//
// Bound to who and what (docs/SDD-identity-and-permissions.md §3.5, §4.5,
// card 9): a pending action records the principal who asked and a hash
// of the actions with the cards they touch, as those cards were. Only
// that principal can confirm it, and only while the cards are unchanged;
// otherwise it is refused and nothing runs.

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
  /** Who asked: only they can confirm it. Unset on rows from before. */
  principalId?: string;
  /** sha-256 of the actions and the cards they touch, as proposed. */
  contentHash?: string;
}

/** Why a take or cancel was refused. */
export type PendingRefusal = "not-found" | "wrong-conversation" | "expired" | "used" | "wrong-principal" | "changed";

export const REFUSAL_TEXT: Record<PendingRefusal, string> = {
  "not-found": "no such pending action",
  "wrong-conversation": "that action belongs to another chat",
  expired: "that action expired; ask again",
  used: "that action was already confirmed or cancelled",
  "wrong-principal": "only the person who asked can confirm this",
  changed: "what this would act on changed since you were asked; ask again",
};

/** The fields of a card an approval covers: a change to any of them
 *  means the person approved something else. Times are left out. */
export function cardFingerprint(c: TaskCard | undefined): unknown {
  if (!c) return null;
  return [c.id, c.title, c.body, c.status, c.labels, c.repo ?? null, c.model ?? null, c.harnessOverride ?? null, c.extraAllowedTools ?? null, c.supersededBy ?? null, c.pr?.head ?? null, c.archivedAt ? "archived" : null];
}

/** The card ids a list of actions touches. */
export function actionCardIds(actions: ControlAction[]): string[] {
  const ids = new Set<string>();
  for (const a of actions as Array<Record<string, unknown>>) {
    if (typeof a.taskId === "string") ids.add(a.taskId);
    if (Array.isArray(a.taskIds)) for (const id of a.taskIds) if (typeof id === "string") ids.add(id);
  }
  return [...ids].sort();
}

/** sha-256 of the actions and the cards they touch, as they are now. */
export async function contentHashOf(actions: ControlAction[], getCard: (id: string) => Promise<TaskCard | undefined>): Promise<string> {
  const cards = await Promise.all(actionCardIds(actions).map(async (id) => cardFingerprint(await getCard(id))));
  return createHash("sha256").update(JSON.stringify([actions, cards])).digest("hex");
}

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
  principalId: string | null;
  contentHash: string | null;
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
    ...(r.principalId ? { principalId: r.principalId } : {}),
    ...(r.contentHash ? { contentHash: r.contentHash } : {}),
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
    // Card 9: who asked, and what it covers. Healed onto older databases.
    for (const ddl of ["ALTER TABLE ask_pending_actions ADD COLUMN principalId TEXT;", "ALTER TABLE ask_pending_actions ADD COLUMN contentHash TEXT;"]) {
      try {
        this.db.run(ddl);
      } catch {
        // already there
      }
    }
  }

  create(input: { conversationId: string; messageId: string; kind: PendingKind; actions: ControlAction[]; lines: string[]; principalId?: string; contentHash?: string }, now = new Date()): PendingAction {
    const p: PendingAction = {
      id: randomUUID(),
      ...input,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.db.run("INSERT INTO ask_pending_actions (id, conversationId, messageId, kind, actions, lines, createdAt, expiresAt, principalId, contentHash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      p.id,
      p.conversationId,
      p.messageId,
      p.kind,
      JSON.stringify(p.actions),
      JSON.stringify(p.lines),
      p.createdAt,
      p.expiresAt,
      p.principalId ?? null,
      p.contentHash ?? null,
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

  /** Takes it for a Confirm. The caller runs it, then calls finish.
   *  `by` is who confirms and `contentHash` what the actions would act on
   *  now: a pending action bound to someone else, or to cards that have
   *  changed since, is refused and stays open for its own person. */
  take(id: string, conversationId: string, now = new Date(), check: { by?: string; contentHash?: string } = {}): { ok: true; pending: PendingAction } | { ok: false; reason: PendingRefusal } {
    const p = this.get(id);
    if (p && p.conversationId === conversationId && !p.usedAt) {
      if (p.principalId && check.by !== undefined && check.by !== p.principalId) return { ok: false, reason: "wrong-principal" };
      if (p.contentHash && check.contentHash !== undefined && check.contentHash !== p.contentHash) return { ok: false, reason: "changed" };
    }
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
