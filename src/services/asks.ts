import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { About, ChannelMessage, SqliteChannelLog } from "./channel.ts";
import type { ExecutableAction } from "./coordinator-executor.ts";
import type { OwnerTaskStore } from "./owner-tasks.ts";
import type { Action, GateContext, GateLog, GateVerdict, PolicyGate } from "./policy-gate.ts";
import type { Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * Asks (docs/SDD-coordinator.md §4.2 rules 5 and 7, §4.3, §4.9, §4.13):
 * where an ask-owner or ask-decider verdict goes. The executor opens one
 * ask per source-stable action id (a replayed event finds the same ask);
 * ask-owner raises an owner task naming the two resolve routes and
 * prints a coordinator> line, ask-decider posts a channel question from
 * wissel with the options approve and reject. The owner resolves an ask
 * through POST /workstreams/:id/asks/:askId/approve or /reject; the
 * project's decider answers the question on the channel
 * (coordinator-driver.ts). Approve re-checks the gate first, so an
 * action that now trips a hard limit is refused, then runs the action's
 * handler once and writes an owner-approved gate record carrying the ask
 * id. Reject and expiry (7 days, swept on the flusher tick) do nothing.
 */
export type AskVerdict = "ask-owner" | "ask-decider";
export const ASK_STATUSES = ["open", "approved", "rejected", "expired"] as const;
export type AskStatus = (typeof ASK_STATUSES)[number];
export type AskVia = "api" | "channel" | "sweep";
export const ASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface Ask {
  id: string;
  workstreamId: string;
  action: ExecutableAction;
  verdict: AskVerdict;
  /** The gate rule that asked. */
  rule: string;
  status: AskStatus;
  askedAt: string;
  resolvedAt?: string;
  /** "owner" through the API; the decider's name through the channel; "sweep" when expired. */
  resolvedBy?: string;
  via?: AskVia;
  /** The owner task an ask-owner raised; done or dismissed with the ask. */
  ownerTaskId?: string;
  /** The channel ref of the question an ask-decider posted; an answer names it. */
  questionRef?: string;
}

export const isAskStatus = (v: string): v is AskStatus => (ASK_STATUSES as readonly string[]).includes(v);

type Row = { id: string; workstreamId: string; actionId: string | null; action: string; verdict: AskVerdict; rule: string; status: AskStatus; askedAt: string; resolvedAt: string | null; resolvedBy: string | null; via: AskVia | null; ownerTaskId: string | null; questionRef: string | null };
const rowToAsk = (r: Row): Ask => ({
  id: r.id, workstreamId: r.workstreamId, action: JSON.parse(r.action) as ExecutableAction, verdict: r.verdict, rule: r.rule, status: r.status, askedAt: r.askedAt,
  ...(r.resolvedAt === null ? {} : { resolvedAt: r.resolvedAt }), ...(r.resolvedBy === null ? {} : { resolvedBy: r.resolvedBy }), ...(r.via === null ? {} : { via: r.via }),
  ...(r.ownerTaskId === null ? {} : { ownerTaskId: r.ownerTaskId }), ...(r.questionRef === null ? {} : { questionRef: r.questionRef }),
});

/** Shares the board's connection, like SqliteOutboundQueue. */
export class SqliteAsks {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS asks (id TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, actionId TEXT, action TEXT NOT NULL, verdict TEXT NOT NULL, rule TEXT NOT NULL, status TEXT NOT NULL, askedAt TEXT NOT NULL, resolvedAt TEXT, resolvedBy TEXT, via TEXT, ownerTaskId TEXT, questionRef TEXT)`);
  }

  create(action: ExecutableAction, v: GateVerdict, at: string): Ask {
    const id = randomUUID();
    this.db.query(`INSERT INTO asks (id, workstreamId, actionId, action, verdict, rule, status, askedAt) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`).run(id, action.workstreamId, action.id ?? null, JSON.stringify(action), v.verdict, v.rule, at);
    return this.get(id)!;
  }

  get(id: string): Ask | undefined {
    const row = this.db.query<Row, [string]>(`SELECT * FROM asks WHERE id = ?`).get(id);
    return row ? rowToAsk(row) : undefined;
  }

  /** The ask already made for a source-stable action id, whatever its status: a replay must not ask twice. */
  byActionId(workstreamId: string, actionId: string): Ask | undefined {
    const row = this.db.query<Row, [string, string]>(`SELECT * FROM asks WHERE workstreamId = ? AND actionId = ? ORDER BY rowid ASC LIMIT 1`).get(workstreamId, actionId);
    return row ? rowToAsk(row) : undefined;
  }

  byQuestionRef(workstreamId: string, ref: string): Ask | undefined {
    const row = this.db.query<Row, [string, string]>(`SELECT * FROM asks WHERE workstreamId = ? AND questionRef = ?`).get(workstreamId, ref);
    return row ? rowToAsk(row) : undefined;
  }

  list(workstreamId: string, status?: AskStatus): Ask[] {
    const rows = status
      ? this.db.query<Row, [string, string]>(`SELECT * FROM asks WHERE workstreamId = ? AND status = ? ORDER BY askedAt ASC, rowid ASC`).all(workstreamId, status)
      : this.db.query<Row, [string]>(`SELECT * FROM asks WHERE workstreamId = ? ORDER BY askedAt ASC, rowid ASC`).all(workstreamId);
    return rows.map(rowToAsk);
  }

  setRefs(id: string, refs: { ownerTaskId?: string; questionRef?: string }): Ask {
    this.db.query(`UPDATE asks SET ownerTaskId = COALESCE(?, ownerTaskId), questionRef = COALESCE(?, questionRef) WHERE id = ?`).run(refs.ownerTaskId ?? null, refs.questionRef ?? null, id);
    return this.get(id)!;
  }

  /** Settles an open ask; undefined when it was no longer open (the one check that makes approve run once). */
  resolve(id: string, status: Exclude<AskStatus, "open">, at: string, by: string, via: AskVia): Ask | undefined {
    const changes = this.db.query(`UPDATE asks SET status = ?, resolvedAt = ?, resolvedBy = ?, via = ? WHERE id = ? AND status = 'open'`).run(status, at, by, via, id).changes;
    return changes === 1 ? this.get(id) : undefined;
  }

  /** Open asks asked at or before `cutoff`. */
  openBefore(cutoff: string): Ask[] {
    return this.db.query<Row, [string]>(`SELECT * FROM asks WHERE status = 'open' AND askedAt <= ? ORDER BY askedAt ASC, rowid ASC`).all(cutoff).map(rowToAsk);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : undefined);

/** One line saying what the coordinator wants to do, for titles, questions and the window. */
export function describeAction(a: ExecutableAction): string {
  const p = a.payload ?? {};
  const m = isRecord(p.message) ? p.message : {};
  const subject = str(p.title) ?? str(m.text) ?? str(p.key) ?? str(p.taskId);
  const pr = str(p.pr);
  return `${a.kind}${a.post ? ` ${a.post}` : ""}${a.decision ? ` (${a.decision})` : ""}${pr ? ` on PR #${pr}` : ""}${subject ? `: ${subject}` : ""}`.replace(/\s+/g, " ");
}

/** What the question is about (§4.9): the action's own message, else its card and PR, else the workstream's ticket. */
function aboutOf(a: ExecutableAction, ws: Workstream): About {
  const p = a.payload ?? {};
  const m = isRecord(p.message) ? p.message : {};
  if (isRecord(m.about) && Object.keys(m.about).length > 0) return m.about as About;
  const card = str(p.key) ?? str(p.taskId), pr = str(p.pr);
  if (card || pr) return { ...(card ? { card } : {}), ...(pr ? { pr } : {}) };
  return ws.ticket ? { ticket: ws.ticket } : { card: ws.id };
}

export type ResolveOutcome = { ok: true; ask: Ask; result?: unknown; error?: string } | { ok: false; status: 404 | 409; error: string };

export interface AskServiceDeps {
  store: SqliteAsks;
  ownerTasks: Pick<OwnerTaskStore, "create" | "setStatus">;
  channelLog: Pick<SqliteChannelLog, "adapter">;
  workstreams: Pick<WorkstreamStore, "get">;
  /** The same gate the executor uses: approve re-evaluates the action and the hard limits refuse. */
  gate: Pick<PolicyGate, "evaluate">;
  gateLog: Pick<GateLog, "append">;
  context: (action: Action) => Promise<Omit<GateContext, "quiet">>;
  /** Runs the approved action's handler (CoordinatorExecutor.runApproved). */
  run: (action: ExecutableAction) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  /** The owner's console; defaults to console.log. */
  log?: (line: string) => void;
  now?: () => Date;
}

export function createAskService(deps: AskServiceDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const routes = (ask: Ask): string => `POST /workstreams/${ask.workstreamId}/asks/${ask.id}`;

  async function raise(ask: Ask): Promise<Ask> {
    const ws = await deps.workstreams.get(ask.workstreamId);
    const name = ws?.name ?? ask.workstreamId;
    const what = describeAction(ask.action);
    if (ask.verdict === "ask-decider" && ws) {
      const message: ChannelMessage = { kind: "question", from: "wissel", about: aboutOf(ask.action, ws), text: `May wissel ${what}? The gate asked the decider (rule ${ask.rule}); ask ${ask.id}`, options: ["approve", "reject"], lean: "approve" };
      const { ref } = await deps.channelLog.adapter(ws.id).post(message);
      return deps.store.setRefs(ask.id, { questionRef: ref });
    }
    const task = await deps.ownerTasks.create({
      title: `Approve or reject: ${what}`,
      why: `The coordinator wants to ${what} on ${name}; the gate asked the owner (rule ${ask.rule}).`,
      steps: [`Approve, and it runs: ${routes(ask)}/approve`, `Reject, and nothing happens: ${routes(ask)}/reject`],
      blocks: [],
    });
    log(`coordinator> ${name}: may I ${what}? approve with ${routes(ask)}/approve or reject with ${routes(ask)}/reject (ask ${ask.id})`);
    return deps.store.setRefs(ask.id, { ownerTaskId: task.id });
  }

  const closeTask = async (ask: Ask, status: "done" | "dismissed"): Promise<void> => {
    if (!ask.ownerTaskId) return;
    await deps.ownerTasks.setStatus(ask.ownerTaskId, status).catch((e: unknown) => log(`asks: owner task ${ask.ownerTaskId} not closed: ${e instanceof Error ? e.message : String(e)}`));
  };

  const find = (workstreamId: string, askId: string): ResolveOutcome | Ask => {
    const ask = deps.store.get(askId);
    if (!ask || ask.workstreamId !== workstreamId) return { ok: false, status: 404, error: `ask not found: ${askId}` };
    if (ask.status !== "open") return { ok: false, status: 409, error: `ask ${askId} is already ${ask.status}` };
    return ask;
  };

  return {
    /** The executor's path for an ask-* verdict: one ask per source-stable action id, raised to a person once. */
    async open(action: ExecutableAction, verdict: GateVerdict, at: Date): Promise<Ask> {
      const existing = action.id ? deps.store.byActionId(action.workstreamId, action.id) : undefined;
      if (existing) return existing;
      return raise(deps.store.create(action, verdict, at.toISOString()));
    },

    /** The owner (or the decider, via the channel) allows it: the gate's denies are re-checked, then the handler runs once. */
    async approve(workstreamId: string, askId: string, by: string, via: AskVia): Promise<ResolveOutcome> {
      const found = find(workstreamId, askId);
      if ("ok" in found) return found;
      const at = now().toISOString();
      const check = await deps.gate.evaluate(found.action, { ...(await deps.context(found.action)), quiet: false });
      if (check.verdict === "deny") return { ok: false, status: 409, error: `refused: the action now trips ${check.rule}; the ask stays open` };
      if (check.mode === "shadow") return { ok: false, status: 409, error: "refused: the project is in Shadow now; nothing runs" };
      const ask = deps.store.resolve(askId, "approved", at, by, via);
      if (!ask) return { ok: false, status: 409, error: `ask ${askId} was resolved meanwhile` };
      await deps.gateLog.append({ id: randomUUID(), action: ask.action, verdict: "allow", rule: `owner-approved:${ask.id}`, mode: "live", at });
      await closeTask(ask, "done");
      const r = await deps.run(ask.action);
      log(`coordinator> ask ${ask.id} approved by ${by} (${via}): ${describeAction(ask.action)}${r.ok ? "" : ` failed: ${r.error}`}`);
      return r.ok ? { ok: true, ask, result: r.result } : { ok: true, ask, error: r.error };
    },

    async reject(workstreamId: string, askId: string, by: string, via: AskVia): Promise<ResolveOutcome> {
      const found = find(workstreamId, askId);
      if ("ok" in found) return found;
      const ask = deps.store.resolve(askId, "rejected", now().toISOString(), by, via);
      if (!ask) return { ok: false, status: 409, error: `ask ${askId} was resolved meanwhile` };
      await closeTask(ask, "done");
      log(`coordinator> ask ${ask.id} rejected by ${by} (${via}): ${describeAction(ask.action)}`);
      return { ok: true, ask };
    },

    /** The flusher's sweep: open asks older than ASK_TTL_MS expire, their owner tasks are dismissed, nothing runs. */
    async expire(at: Date): Promise<Ask[]> {
      const expired: Ask[] = [];
      for (const open of deps.store.openBefore(new Date(at.getTime() - ASK_TTL_MS).toISOString())) {
        const ask = deps.store.resolve(open.id, "expired", at.toISOString(), "sweep", "sweep");
        if (!ask) continue;
        await closeTask(ask, "dismissed");
        expired.push(ask);
      }
      return expired;
    },

    byQuestionRef: (workstreamId: string, ref: string): Ask | undefined => deps.store.byQuestionRef(workstreamId, ref),
  };
}

export type AskService = ReturnType<typeof createAskService>;
