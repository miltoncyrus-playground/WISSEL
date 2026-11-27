// The executor and the outbound queue (docs/SDD-coordinator.md §4.3,
// §4.11; phase 3 card 15).
//
// The executor carries out what the gate allows and nothing else. Each
// action is first decided by the policy gate (card 14) and recorded in
// the gate log, then:
// - allow (live): the performer for its kind runs it. A kind with no
//   performer yet (the channel, chat and tracker adapters come with cards
//   17 and 18) is reported, never faked.
// - allow (shadow): recorded only; nothing acts.
// - queue (quiet hours): kept in a persisted outbound queue. Each flush
//   decides it again, oldest first, and runs it once the gate no longer
//   says queue. A push flushed later goes through the merge path, which
//   fetches main and re-runs the gates, so a push that is no longer green
//   becomes a fix round, not a red push.
// - ask-owner / ask-decider: an owner task says what Wissel wants to do,
//   and for whom. Answering it through a decider or the window comes with
//   cards 16 and 22.
// - deny: reported with the rule that refused it.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { evaluate, gateContextFor, inQuietHours, type GateAction, type GateContext, type GateLog, type GateRecord, type HardLimits } from "./policy-gate.ts";
import type { Workstream } from "./workstreams.ts";

export type Performer = (action: ExecutorAction) => Promise<string>;

/** A gate action plus what the performer needs to act. */
export interface ExecutorAction extends GateAction {
  payload?: Record<string, unknown>;
}

export type ExecuteResult =
  | { status: "done"; record: GateRecord; detail: string }
  | { status: "recorded"; record: GateRecord }
  | { status: "queued"; record: GateRecord; queueId: string; flushAt?: string }
  | { status: "asked"; record: GateRecord; ownerTaskId?: string }
  | { status: "denied"; record: GateRecord }
  | { status: "unsupported"; record: GateRecord }
  | { status: "failed"; record: GateRecord; error: string };

export interface OutboundItem {
  id: string;
  workstreamId?: string;
  action: ExecutorAction;
  queuedAt: string;
  status: "queued" | "sent" | "failed" | "dropped";
  result?: string;
  settledAt?: string;
}

/** The first time at or after `now` the quiet hours end, to the minute.
 *  Undefined when `now` isn't inside them. */
export function quietHoursEnd(q: GateContext["quietHours"], now: Date): Date | undefined {
  if (!q || !inQuietHours(q, now)) return undefined;
  const t = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i <= 24 * 60; i++) {
    t.setTime(t.getTime() + 60_000);
    if (!inQuietHours(q, t)) return t;
  }
  return undefined;
}

export class OutboundQueue {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run("CREATE TABLE IF NOT EXISTS outbound_queue (id TEXT PRIMARY KEY, workstreamId TEXT, action TEXT NOT NULL, queuedAt TEXT NOT NULL, status TEXT NOT NULL, result TEXT, settledAt TEXT);");
  }

  add(action: ExecutorAction): string {
    const id = randomUUID();
    this.db.run("INSERT INTO outbound_queue (id, workstreamId, action, queuedAt, status) VALUES (?, ?, ?, ?, 'queued')", [id, action.workstreamId ?? null, JSON.stringify(action), this.clock().toISOString()]);
    return id;
  }

  /** Queued items oldest first; or every item for a workstream, newest first. */
  list(opts: { workstreamId?: string; queuedOnly?: boolean } = {}): OutboundItem[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.workstreamId) {
      where.push("workstreamId = ?");
      args.push(opts.workstreamId);
    }
    if (opts.queuedOnly) where.push("status = 'queued'");
    const order = opts.queuedOnly ? "queuedAt, rowid" : "queuedAt DESC, rowid DESC";
    const rows = this.db.query(`SELECT * FROM outbound_queue ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ${order} LIMIT 500`).all(...args) as Array<{
      id: string;
      workstreamId: string | null;
      action: string;
      queuedAt: string;
      status: OutboundItem["status"];
      result: string | null;
      settledAt: string | null;
    }>;
    return rows.map((r) => ({ id: r.id, ...(r.workstreamId ? { workstreamId: r.workstreamId } : {}), action: JSON.parse(r.action) as ExecutorAction, queuedAt: r.queuedAt, status: r.status, ...(r.result ? { result: r.result } : {}), ...(r.settledAt ? { settledAt: r.settledAt } : {}) }));
  }

  settle(id: string, status: Exclude<OutboundItem["status"], "queued">, result: string): void {
    this.db.run("UPDATE outbound_queue SET status = ?, result = ?, settledAt = ? WHERE id = ? AND status = 'queued'", [status, result, this.clock().toISOString(), id]);
  }
}

export interface ExecutorDeps {
  gateLog: GateLog;
  queue: OutboundQueue;
  workstream: (id: string | undefined) => Workstream | undefined;
  hardLimits: HardLimits;
  mainBranchFor: (action: ExecutorAction) => Promise<string>;
  performers: Partial<Record<GateAction["kind"], Performer>>;
  /** Raises the owner task for an ask verdict; returns its id. */
  ask: (action: ExecutorAction, record: GateRecord, forWhom: string) => Promise<string | undefined>;
  shadow?: () => boolean;
  duties?: (workstreamId: string | undefined) => GateContext["duties"];
  now?: () => Date;
  log?: (line: string) => void;
}

export class ActionExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  private async context(action: ExecutorAction): Promise<GateContext> {
    const ws = this.deps.workstream(action.workstreamId);
    return gateContextFor(ws, action.projectId, {
      hardLimits: this.deps.hardLimits,
      now: (this.deps.now ?? (() => new Date()))(),
      mainBranch: await this.deps.mainBranchFor(action),
      ...(this.deps.duties ? { duties: this.deps.duties(action.workstreamId) } : {}),
      ...(this.deps.shadow?.() ? { shadow: true } : {}),
    });
  }

  /** Decides and carries out one action. */
  async execute(action: ExecutorAction): Promise<ExecuteResult> {
    const ctx = await this.context(action);
    const record = this.deps.gateLog.decide(action, ctx);
    if (record.verdict === "queue") {
      const queueId = this.deps.queue.add(action);
      const end = quietHoursEnd(ctx.quietHours, ctx.now);
      return { status: "queued", record, queueId, ...(end ? { flushAt: end.toISOString() } : {}) };
    }
    return this.act(action, record);
  }

  private async act(action: ExecutorAction, record: GateRecord): Promise<ExecuteResult> {
    const log = this.deps.log ?? console.log;
    if (record.verdict === "deny") return { status: "denied", record };
    if (record.verdict === "ask-owner" || record.verdict === "ask-decider") {
      const ws = this.deps.workstream(action.workstreamId);
      const decider = ws?.projects.find((p) => p.projectId === action.projectId)?.decider;
      const forWhom = record.verdict === "ask-decider" ? (decider ?? "the decider") : "the owner";
      const ownerTaskId = await this.deps.ask(action, record, forWhom);
      return { status: "asked", record, ...(ownerTaskId ? { ownerTaskId } : {}) };
    }
    if (record.mode === "shadow") return { status: "recorded", record };
    const perform = this.deps.performers[action.kind];
    if (!perform) {
      log(`executor: ${action.kind} is allowed but has no performer yet; nothing was done`);
      return { status: "unsupported", record };
    }
    try {
      return { status: "done", record, detail: await perform(action) };
    } catch (e) {
      return { status: "failed", record, error: (e as Error).message };
    }
  }

  /** Decides every queued item again, oldest first; runs the ones the
   *  gate no longer queues. Returns how many left the queue. */
  async flush(): Promise<number> {
    let settled = 0;
    for (const item of this.deps.queue.list({ queuedOnly: true })) {
      const ctx = await this.context(item.action);
      const decision = evaluate(item.action, ctx);
      if (decision.verdict === "queue") continue;
      const record = this.deps.gateLog.decide(item.action, ctx);
      const r = await this.act(item.action, record);
      const text = r.status === "done" ? r.detail : r.status === "failed" ? r.error : `${r.status} (${record.rule})`;
      this.deps.queue.settle(item.id, r.status === "done" || r.status === "recorded" ? "sent" : r.status === "failed" ? "failed" : "dropped", text);
      settled++;
    }
    return settled;
  }
}

export const EXECUTOR_FLUSH_MS = 60_000;
