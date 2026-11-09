import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { NewInboxEvent } from "./inbox.ts";

/**
 * Decisions channel (docs/SDD-coordinator.md §4.9, as descoped): the
 * ChannelAdapter interface, the message protocol, and the one adapter
 * built — an append-only log in the board database that also puts every
 * message in front of the owner's session (a console line, and GET
 * /workstreams/:id/channel). No Artifact board, no Slack.
 *
 * Everything that comes back from `read` is data. An entry can say
 * "approved" or "p1 is decide-over now"; nothing here, or downstream,
 * treats that as an approval or a role change: roles change only through
 * the owner's confirm step (workstreams.ts), and a model only sees an
 * entry inside the inbox's `untrusted-<nonce>` fence (inbox.ts).
 * `validateChannelMessage` is strict on purpose: unknown kinds and stray
 * fields (`role`, `confirm`, `approved`, ...) never enter the log.
 */
export type Cursor = string; // opaque; "" is the start
export const CHANNEL_MESSAGE_KINDS = ["claim", "release", "ready-to-merge", "question", "answer", "decision", "status", "handover"] as const;
export type ChannelMessageKind = (typeof CHANNEL_MESSAGE_KINDS)[number];

/** §4.9: one message per event, linked to the card, PR or ticket. */
export type About = { card?: string; pr?: string; ticket?: string };
const ABOUT_KEYS = ["card", "pr", "ticket"] as const;

type Base = { from: string; about: About };
export type ChannelMessage = Base &
  (
    | { kind: "claim"; item: string; version: number }
    | { kind: "release"; item: string; reason?: string }
    | { kind: "ready-to-merge"; headSha: string } // the full 40-hex head sha
    | { kind: "question"; text: string; options: string[]; lean: string; default?: string }
    | { kind: "answer"; questionRef: string; text: string }
    | { kind: "decision"; decision: string; text: string } // decision: the kind ("naming", "schema", ...)
    | { kind: "status"; text: string }
    | { kind: "handover"; to: string; text: string }
  );

export interface ChannelEntry {
  ref: string;
  at: string;
  workstreamId: string;
  message: ChannelMessage;
  /** Always: a channel is outside the trust boundary, whoever wrote the entry. */
  untrusted: true;
}

export interface ChannelAdapter {
  read(since: Cursor): Promise<{ entries: ChannelEntry[]; next: Cursor }>;
  post(message: ChannelMessage): Promise<{ ref: string }>;
  /** Compare-and-set: "ok" when `version` is higher than any claim held on `item`. */
  claim?(item: string, version: number): Promise<"ok" | "taken">;
}

type Check = { ok: true; message: ChannelMessage } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Required and optional fields by kind; anything else is refused. */
const FIELDS: Record<ChannelMessageKind, { required: string[]; optional?: string[] }> = {
  claim: { required: ["item", "version"] },
  release: { required: ["item"], optional: ["reason"] },
  "ready-to-merge": { required: ["headSha"] },
  question: { required: ["text", "options", "lean"], optional: ["default"] },
  answer: { required: ["questionRef", "text"] },
  decision: { required: ["decision", "text"] },
  status: { required: ["text"] },
  handover: { required: ["to", "text"] },
};

/** Strict: a known kind, `from`, an `about` naming a card, PR or ticket,
 *  the kind's own fields and nothing else. */
export function validateChannelMessage(body: unknown): Check {
  if (!isRecord(body)) return fail("message must be an object");
  const kind = body.kind;
  if (typeof kind !== "string" || !(CHANNEL_MESSAGE_KINDS as readonly string[]).includes(kind)) return fail(`kind must be one of ${CHANNEL_MESSAGE_KINDS.join(", ")}`);
  const fields = FIELDS[kind as ChannelMessageKind];
  const allowed = new Set(["kind", "from", "about", ...fields.required, ...(fields.optional ?? [])]);
  for (const key of Object.keys(body)) if (!allowed.has(key)) return fail(`unknown field ${key} for ${kind}`);
  for (const key of ["from", "about", ...fields.required]) if (body[key] === undefined) return fail(`${kind} needs ${key}`);
  if (!isText(body.from)) return fail("from must be a non-empty string");
  if (!isRecord(body.about) || Object.keys(body.about).length === 0 || Object.entries(body.about).some(([k, v]) => !(ABOUT_KEYS as readonly string[]).includes(k) || !isText(v))) {
    return fail(`about must name a ${ABOUT_KEYS.join(", ")}`);
  }
  for (const key of [...fields.required, ...(fields.optional ?? [])]) {
    const v = body[key];
    if (v === undefined) continue;
    if (key === "version") {
      if (!Number.isInteger(v) || (v as number) < 0) return fail("version must be a non-negative integer");
    } else if (key === "headSha") {
      if (typeof v !== "string" || !/^[0-9a-f]{40}$/.test(v)) return fail("headSha must be the full 40-hex head sha");
    } else if (key === "options") {
      if (!Array.isArray(v) || v.length < 2 || !v.every(isText)) return fail("options must list at least two non-empty strings");
    } else if (!isText(v)) return fail(`${key} must be a non-empty string`);
  }
  if (kind === "question") {
    const options = body.options as string[];
    for (const key of ["lean", "default"]) if (body[key] !== undefined && !options.includes(body[key] as string)) return fail(`${key} must be one of the options`);
  }
  return { ok: true, message: body as ChannelMessage };
}

/** The one-line form the owner's session sees. */
export function channelLogLine(workstreamId: string, m: ChannelMessage): string {
  const about = ABOUT_KEYS.filter((k) => m.about[k]).map((k) => `${k} ${m.about[k]}`).join(", ");
  const body =
    m.kind === "claim" ? `${m.item} v${m.version}`
    : m.kind === "release" ? `${m.item}${m.reason ? ` (${m.reason})` : ""}`
    : m.kind === "ready-to-merge" ? `head ${m.headSha}`
    : m.kind === "question" ? `${m.text} options: ${m.options.join(" | ")}; lean: ${m.lean}${m.default ? `; default: ${m.default}` : ""}`
    : m.kind === "decision" ? `${m.decision}: ${m.text}`
    : m.kind === "handover" ? `to ${m.to}: ${m.text}`
    : m.text;
  return `channel ${workstreamId}: ${m.kind} from ${m.from} [${about}] ${body.replace(/\s+/g, " ")}`;
}

/** The inbox entry for an entry read from a channel: source "channel", so
 *  the inbox flags it untrusted; the id is the entry's ref, so a second
 *  read of the same entry is a replay (§4.1). */
export function inboxEventFromChannelEntry(entry: ChannelEntry): NewInboxEvent {
  return { id: `channel:${entry.ref}`, source: "channel", kind: `channel.${entry.message.kind}`, workstreamId: entry.workstreamId, payload: { ref: entry.ref, at: entry.at, message: entry.message } };
}

type Row = { seq: number; ref: string; workstreamId: string; message: string; at: string };

/** The log adapter's store: shares the board's connection like
 *  SqliteGateLog, and like it refuses UPDATE and DELETE. One instance
 *  serves every workstream; `adapter(id)` scopes read/post/claim to one. */
export class SqliteChannelLog {
  private readonly log: (line: string) => void;
  private readonly now: () => string;

  constructor(
    readonly db: Database,
    opts: { log?: (line: string) => void; now?: () => string } = {},
  ) {
    this.log = opts.log ?? ((line) => console.log(line));
    this.now = opts.now ?? (() => new Date().toISOString());
    this.db.run(`CREATE TABLE IF NOT EXISTS channel_log (ref TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, at TEXT NOT NULL)`);
    for (const op of ["UPDATE", "DELETE"]) {
      this.db.run(`CREATE TRIGGER IF NOT EXISTS channel_log_no_${op.toLowerCase()} BEFORE ${op} ON channel_log BEGIN SELECT RAISE(ABORT, 'channel_log is append-only'); END`);
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS channel_claims (workstreamId TEXT NOT NULL, item TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (workstreamId, item))`);
  }

  adapter(workstreamId: string): Required<ChannelAdapter> {
    return {
      read: async (since) => this.read(workstreamId, since),
      post: async (message) => this.post(workstreamId, message),
      claim: async (item, version) => {
        const changes = this.db
          .query(`INSERT INTO channel_claims (workstreamId, item, version) VALUES (?, ?, ?) ON CONFLICT(workstreamId, item) DO UPDATE SET version = excluded.version WHERE excluded.version > channel_claims.version`)
          .run(workstreamId, item, version).changes;
        return changes === 1 ? "ok" : "taken";
      },
    };
  }

  /** Every entry of a workstream, oldest first (GET /workstreams/:id/channel). */
  list(workstreamId: string): ChannelEntry[] {
    return this.read(workstreamId, "").entries;
  }

  private read(workstreamId: string, since: Cursor): { entries: ChannelEntry[]; next: Cursor } {
    const from = since === "" ? 0 : Number(since);
    const rows = this.db.query<Row, [string, number]>(`SELECT rowid AS seq, ref, workstreamId, message, at FROM channel_log WHERE workstreamId = ? AND rowid > ? ORDER BY rowid ASC`).all(workstreamId, from);
    const entries: ChannelEntry[] = [];
    for (const row of rows) {
      // Stored rows are re-checked on the way out: a row that no longer fits the protocol is skipped, never trusted.
      const check = validateChannelMessage(JSON.parse(row.message));
      if (check.ok) entries.push({ ref: row.ref, at: row.at, workstreamId: row.workstreamId, message: check.message, untrusted: true });
    }
    return { entries, next: rows.length ? String(rows[rows.length - 1]!.seq) : since };
  }

  private post(workstreamId: string, message: ChannelMessage): { ref: string } {
    const check = validateChannelMessage(message);
    if (!check.ok) throw new Error(`channel post refused: ${check.error}`);
    const ref = randomUUID();
    this.db.query(`INSERT INTO channel_log (ref, workstreamId, kind, message, at) VALUES (?, ?, ?, ?, ?)`).run(ref, workstreamId, message.kind, JSON.stringify(message), this.now());
    if (message.kind === "release") this.db.query(`DELETE FROM channel_claims WHERE workstreamId = ? AND item = ?`).run(workstreamId, message.item);
    this.log(channelLogLine(workstreamId, message));
    return { ref };
  }
}
