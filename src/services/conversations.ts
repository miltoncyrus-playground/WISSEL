import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ControlActionType, DroppedAction, Tier } from "./concierge-actions.ts";

// Ask's chats (docs/SDD-wissel-app.md §3.4): `conversations` and
// `messages` in board.sqlite, on the board's own connection (the same
// reason SqlitePipelineStore shares it: ":memory:" would otherwise be two
// unrelated databases).

/** What a control action acted on, as the reply names it. */
export interface ControlTarget {
  kind: "card" | "harness" | "mcp-server" | "pipeline" | "project" | "schedule";
  id: string;
  label: string;
}

/** A control action as it ran (docs/SDD-wissel-app.md §3.7), one per
 *  target: a batch of five retries is five of these. `text` is the
 *  sentence the reply shows ("Retried 'X' (card 2f0cd188)."). */
export interface ControlExecuted {
  type: ControlActionType;
  control: true;
  ok: boolean;
  tier: Tier;
  /** Who let it run: "tier-a" ran at once, "confirm" after a Confirm
   *  tap, "undo" an Undo tap. Never the model. */
  confirmedBy: "tier-a" | "confirm" | "undo";
  target: ControlTarget;
  text: string;
  error?: string;
  /** The pending action an Undo chip confirms, when there is one. */
  undoId?: string;
}

/** An action as it was executed: what it was, and what it made. */
export type ExecutedAction =
  | { type: "create_task"; ok: true; taskId: string; title: string }
  | { type: "run_pipeline"; ok: true; runId: string; name: string; pipelineId: string }
  | { type: "show_task"; ok: true; taskId: string }
  | { type: "create_task" | "run_pipeline" | "show_task"; ok: false; error: string; title?: string; name?: string }
  | ControlExecuted;

export function isControlExecuted(a: ExecutedAction): a is ControlExecuted {
  return "control" in a;
}

/** A Tier B action (or an undo) waiting for its tap, as the app shows it.
 *  Read from the pending-action store, never stored on the message. */
export interface PendingView {
  id: string;
  kind: "confirm" | "undo";
  /** "Merge 'X' (card 2f0cd188)", one line per target. */
  lines: string[];
  state: "open" | "confirmed" | "cancelled" | "expired";
  expiresAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant only: what was executed, in order. [] when nothing was. */
  actions: ExecutedAction[];
  /** Assistant only: what the model proposed that was not taken. */
  dropped: DroppedAction[];
  at: string;
  /** Assistant only: the run's real cost in USD, when known. */
  costUsd?: number;
  /** Assistant only: its Tier B actions and undos, with their state now.
   *  Joined in from the pending-action store when a message is read. */
  pending?: PendingView[];
}

/** A conversation's title: the first message, on one line, cut short. */
export const TITLE_LENGTH = 60;

export function conversationTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line || "New chat";
}

interface ConversationRow {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  text: string;
  actions: string | null;
  dropped: string | null;
  at: string;
  costUsd: number | null;
}

function rowToMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role === "assistant" ? "assistant" : "user",
    text: r.text,
    actions: r.actions ? (JSON.parse(r.actions) as ExecutedAction[]) : [],
    dropped: r.dropped ? (JSON.parse(r.dropped) as DroppedAction[]) : [],
    at: r.at,
    ...(r.costUsd !== null ? { costUsd: r.costUsd } : {}),
  };
}

export class SqliteConversationStore {
  constructor(private db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        actions TEXT,
        dropped TEXT,
        at TEXT NOT NULL,
        costUsd REAL
      );
    `);
    this.db.run("CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversationId);");
  }

  create(title: string, now = new Date().toISOString()): Conversation {
    const c: Conversation = { id: randomUUID(), title: conversationTitle(title), createdAt: now, updatedAt: now };
    this.db.run("INSERT INTO conversations (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)", [c.id, c.title, c.createdAt, c.updatedAt]);
    return c;
  }

  get(id: string): Conversation | undefined {
    return (this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | null) ?? undefined;
  }

  /** Most recently active first. */
  list(limit = 50): Conversation[] {
    return this.db.query("SELECT * FROM conversations ORDER BY updatedAt DESC, rowid DESC LIMIT ?").all(limit) as ConversationRow[];
  }

  /** Oldest first, in the order they were added. */
  messages(conversationId: string): ChatMessage[] {
    const rows = this.db.query("SELECT * FROM messages WHERE conversationId = ? ORDER BY rowid").all(conversationId) as MessageRow[];
    return rows.map(rowToMessage);
  }

  /** One message by id, in any conversation. */
  message(id: string): ChatMessage | undefined {
    const row = this.db.query("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | null;
    return row ? rowToMessage(row) : undefined;
  }

  /** Adds a message and bumps the conversation's updatedAt. Throws for
   *  an unknown conversation. `id` is for a caller that has to name the
   *  message before it exists (an Undo stored with it); else a new one. */
  add(msg: Omit<ChatMessage, "id" | "at" | "pending"> & { at?: string; id?: string }): ChatMessage {
    if (!this.get(msg.conversationId)) throw new Error(`conversation not found: ${msg.conversationId}`);
    const { id, ...rest } = msg;
    const full: ChatMessage = { ...rest, id: id ?? randomUUID(), at: msg.at ?? new Date().toISOString() };
    this.db.run("INSERT INTO messages (id, conversationId, role, text, actions, dropped, at, costUsd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      full.id,
      full.conversationId,
      full.role,
      full.text,
      full.actions.length ? JSON.stringify(full.actions) : null,
      full.dropped.length ? JSON.stringify(full.dropped) : null,
      full.at,
      full.costUsd ?? null,
    ]);
    this.db.run("UPDATE conversations SET updatedAt = ? WHERE id = ?", [full.at, full.conversationId]);
    return full;
  }

  /** Appends executed actions to a message (a Confirm or Undo tap ran
   *  them after the reply), so the message stays the audit trail.
   *  Throws for an unknown message. */
  appendActions(messageId: string, actions: ExecutedAction[], at = new Date().toISOString()): ChatMessage {
    const existing = this.message(messageId);
    if (!existing) throw new Error(`message not found: ${messageId}`);
    const all = [...existing.actions, ...actions];
    this.db.run("UPDATE messages SET actions = ? WHERE id = ?", [all.length ? JSON.stringify(all) : null, messageId]);
    this.db.run("UPDATE conversations SET updatedAt = ? WHERE id = ?", [at, existing.conversationId]);
    return { ...existing, actions: all };
  }
}
