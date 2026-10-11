import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { DroppedAction } from "./concierge-actions.ts";

// Ask's chats (docs/SDD-wissel-app.md §3.4): `conversations` and
// `messages` in board.sqlite, on the board's own connection (the same
// reason SqlitePipelineStore shares it: ":memory:" would otherwise be two
// unrelated databases).

/** An action as it was executed: what it was, and what it made. */
export type ExecutedAction =
  | { type: "create_task"; ok: true; taskId: string; title: string }
  | { type: "run_pipeline"; ok: true; runId: string; name: string; pipelineId: string }
  | { type: "show_task"; ok: true; taskId: string }
  | { type: "create_task" | "run_pipeline" | "show_task"; ok: false; error: string; title?: string; name?: string };

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
   *  an unknown conversation. */
  add(msg: Omit<ChatMessage, "id" | "at"> & { at?: string }): ChatMessage {
    if (!this.get(msg.conversationId)) throw new Error(`conversation not found: ${msg.conversationId}`);
    const full: ChatMessage = { ...msg, id: randomUUID(), at: msg.at ?? new Date().toISOString() };
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
}
