import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { CardTemplateKind, Project, TaskCard } from "../core/types.ts";
import type { Board } from "./board.ts";
import { renderCardTemplateFor } from "./card-templates.ts";
import type { NewOwnerTask, OwnerTask } from "./owner-tasks.ts";
import type { Action, ActionKind, GateContext, GateVerdict, HardLimits, PolicyGate, Verdict } from "./policy-gate.ts";
import type { Workstream } from "./workstreams.ts";

/**
 * The executor (docs/SDD-coordinator.md §4.3, §4.11): every action passes
 * the policy gate and only a live `allow` reaches its injected handler.
 * builtinHandlers wires the inward kinds (card.*, owner.task, host.*);
 * the outward kinds are adapters later cards bring. In quiet hours
 * outward actions wait in the persisted outbound queue and flush in order
 * when the window ends; a queued push is re-checked first and becomes a
 * fix round when no longer green. Shadow records a "would" entry with
 * the live verdict and never acts or queues.
 */
export type QuietHours = NonNullable<Workstream["quietHours"]>;
/** The gate reads the Action fields; `payload` is what the handler needs. */
export interface ExecutableAction extends Action {
  /** A source-stable id (the inbox event id plus an index, coordinator-driver.ts), so a replayed event builds the same action. */
  id?: string;
  payload?: Record<string, unknown>;
}
export type ActionHandler = (action: ExecutableAction) => Promise<unknown>;
export type ActionHandlers = Partial<Record<ActionKind, ActionHandler>>;

export type EntryStatus = "queued" | "flushed" | "fix-round" | "refused" | "failed" | "would";
export interface OutboundEntry {
  id: string;
  workstreamId: string;
  action: ExecutableAction;
  status: EntryStatus;
  /** The gate's verdict and rule when written (for a would-entry, what the live gate would have given). */
  verdict: Verdict;
  rule: string;
  queuedAt: string;
  flushedAt?: string;
  /** Why a flush settled the entry as fix-round, refused or failed. */
  note?: string;
}

type Row = Omit<OutboundEntry, "action" | "flushedAt" | "note"> & { action: string; flushedAt: string | null; note: string | null };
const rowToEntry = ({ action, flushedAt, note, ...r }: Row): OutboundEntry => ({ ...r, action: JSON.parse(action) as ExecutableAction, ...(flushedAt === null ? {} : { flushedAt }), ...(note === null ? {} : { note }) });

/** Shares the board's connection, like SqliteGateLog. Would-entries live in the same table under status "would". */
export class SqliteOutboundQueue {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS outbound_queue (id TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL, verdict TEXT NOT NULL, rule TEXT NOT NULL, queuedAt TEXT NOT NULL, flushedAt TEXT, note TEXT)`);
  }

  add(action: ExecutableAction, v: GateVerdict, status: "queued" | "would", at: string): OutboundEntry {
    const id = randomUUID();
    this.db.query(`INSERT INTO outbound_queue (id, workstreamId, action, status, verdict, rule, queuedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, action.workstreamId, JSON.stringify(action), status, v.verdict, v.rule, at);
    return this.get(id)!;
  }

  get(id: string): OutboundEntry | undefined {
    const row = this.db.query<Row, [string]>(`SELECT * FROM outbound_queue WHERE id = ?`).get(id);
    return row ? rowToEntry(row) : undefined;
  }

  list(workstreamId: string, status: EntryStatus): OutboundEntry[] {
    return this.db.query<Row, [string, string]>(`SELECT * FROM outbound_queue WHERE workstreamId = ? AND status = ? ORDER BY queuedAt ASC, rowid ASC`).all(workstreamId, status).map(rowToEntry);
  }

  settle(id: string, status: Exclude<EntryStatus, "queued" | "would">, at: string, note?: string): OutboundEntry {
    this.db.query(`UPDATE outbound_queue SET status = ?, flushedAt = ?, note = ? WHERE id = ?`).run(status, at, note ?? null, id);
    return this.get(id)!;
  }
}

const toMinutes = (hhmm: string): number => hhmm.split(":").map(Number).reduce((h, m) => h * 60 + m);
/** Minutes past local midnight in `timezone` at `now`. */
const localMinutes = (now: Date, timezone: string): number => toMinutes(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now)) % (24 * 60);

/** Whether `now` falls in the window; `start > end` means the window crosses midnight. No quiet hours means never. */
export function inQuietHours(q: QuietHours | undefined, now: Date): boolean {
  if (!q) return false;
  const t = localMinutes(now, q.timezone), start = toMinutes(q.start), end = toMinutes(q.end);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

/** The next instant the window ends, when `now` is inside it (to the minute; a DST change inside the window shifts it by the hour). */
export function quietHoursEnd(q: QuietHours | undefined, now: Date): Date | undefined {
  if (!q || !inQuietHours(q, now)) return undefined;
  const wait = (toMinutes(q.end) - localMinutes(now, q.timezone) + 24 * 60) % (24 * 60) || 24 * 60;
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + wait * 60_000);
}

/** The §4.2 context for one project of a workstream. Duties and Shadow come from later cards; the channel target is the only configured channel. */
export function gateContextFor(ws: Workstream, projectId: string, opts: { limits: HardLimits; mainBranch: string; shadow: boolean; duties?: GateContext["duties"] }): Omit<GateContext, "quiet"> {
  const p = ws.projects.find((e) => e.projectId === projectId);
  if (!p) throw new Error(`project ${projectId} is not in workstream ${ws.id}`);
  return { role: p.role, decideAlone: p.decideAlone, mustAsk: p.mustAsk, never: p.never, limits: opts.limits, mainBranch: opts.mainBranch, channels: ws.channel ? [ws.channel.target] : [], duties: opts.duties ?? {}, shadow: opts.shadow };
}

export type ExecuteOutcome =
  | { outcome: "done"; verdict: GateVerdict; result: unknown }
  | { outcome: "queued" | "would"; verdict: GateVerdict; entry: OutboundEntry }
  | { outcome: "refused"; verdict: GateVerdict }
  | { outcome: "failed"; verdict: GateVerdict; error: string };

export interface ExecutorOptions {
  gate: Pick<PolicyGate, "evaluate">;
  queue: SqliteOutboundQueue;
  handlers: ActionHandlers;
  /** The gate context minus `quiet`, which the executor sets from the workstream's quiet hours. */
  context: (action: Action) => Promise<Omit<GateContext, "quiet">>;
  quietHours: (workstreamId: string) => Promise<QuietHours | undefined>;
  /** Before a queued push flushes: merge main forward and re-run the gates; a red push becomes a fix round (a later card's callback). */
  pushStillGreen?: (action: ExecutableAction) => Promise<{ green: boolean; reason?: string }>;
  startFixRound?: (action: ExecutableAction, reason: string) => Promise<void>;
  now?: () => Date;
}

export class CoordinatorExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  private readonly flushing = new Set<string>();
  private now = (): Date => (this.opts.now ?? (() => new Date()))();

  private async run(action: ExecutableAction, verdict: GateVerdict): Promise<ExecuteOutcome> {
    const handler = this.opts.handlers[action.kind as ActionKind];
    if (!handler) return { outcome: "failed", verdict, error: `no executor for ${action.kind}` };
    try {
      return { outcome: "done", verdict, result: await handler(action) };
    } catch (e) {
      return { outcome: "failed", verdict, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Gate, then act, queue, record or refuse. Never acts on anything but a live `allow`. */
  async execute(action: ExecutableAction): Promise<ExecuteOutcome> {
    const now = this.now();
    const ctx: GateContext = { ...(await this.opts.context(action)), quiet: inQuietHours(await this.opts.quietHours(action.workstreamId), now) };
    const verdict = await this.opts.gate.evaluate(action, ctx);
    if (verdict.mode === "shadow") return { outcome: "would", verdict, entry: this.opts.queue.add(action, verdict, "would", now.toISOString()) };
    if (verdict.verdict === "queue") return { outcome: "queued", verdict, entry: this.opts.queue.add(action, verdict, "queued", now.toISOString()) };
    if (verdict.verdict !== "allow") return { outcome: "refused", verdict };
    return this.run(action, verdict);
  }

  /** Flushes the workstream's queue in order once its quiet hours are over; each entry is gated again first. A handler failure settles that entry and leaves the rest queued. */
  async flush(workstreamId: string): Promise<OutboundEntry[]> {
    if (this.flushing.has(workstreamId)) return []; // one flush per workstream at a time: an overlapping call would post the same queued rows twice
    this.flushing.add(workstreamId);
    try {
      return await this.flushOnce(workstreamId);
    } finally {
      this.flushing.delete(workstreamId);
    }
  }

  private async flushOnce(workstreamId: string): Promise<OutboundEntry[]> {
    const now = this.now();
    if (inQuietHours(await this.opts.quietHours(workstreamId), now)) return [];
    const at = now.toISOString();
    const settled: OutboundEntry[] = [];
    for (const entry of this.opts.queue.list(workstreamId, "queued")) {
      const verdict = await this.opts.gate.evaluate(entry.action, { ...(await this.opts.context(entry.action)), quiet: false });
      if (verdict.verdict !== "allow" || verdict.mode === "shadow") {
        settled.push(this.opts.queue.settle(entry.id, "refused", at, `${verdict.verdict} by ${verdict.rule}${verdict.mode === "shadow" ? " (shadow)" : ""}`));
        continue;
      }
      const check = entry.action.kind === "branch.push" && this.opts.pushStillGreen ? await this.opts.pushStillGreen(entry.action) : { green: true };
      if (!check.green) {
        const reason = check.reason ?? "gates no longer green";
        await this.opts.startFixRound?.(entry.action, reason);
        settled.push(this.opts.queue.settle(entry.id, "fix-round", at, reason));
        continue;
      }
      const outcome = await this.run(entry.action, verdict);
      settled.push(this.opts.queue.settle(entry.id, outcome.outcome === "failed" ? "failed" : "flushed", at, outcome.outcome === "failed" ? outcome.error : undefined));
      if (outcome.outcome === "failed") break;
    }
    return settled;
  }

  /** What `GET /workstreams/:id/outbound` shows (§4.11): the queue and its flush time, plus Shadow's would-entries. */
  async status(workstreamId: string): Promise<{ quiet: boolean; flushAt?: string; queued: OutboundEntry[]; would: OutboundEntry[] }> {
    const now = this.now();
    const q = await this.opts.quietHours(workstreamId);
    const flushAt = quietHoursEnd(q, now)?.toISOString();
    return { quiet: inQuietHours(q, now), ...(flushAt ? { flushAt } : {}), queued: this.opts.queue.list(workstreamId, "queued"), would: this.opts.queue.list(workstreamId, "would") };
  }
}

export interface OutboundFlusherOptions {
  executor: Pick<CoordinatorExecutor, "flush">;
  workstreams: { list(): Promise<{ id: string }[]> };
  /** How often to look for queues whose quiet hours have ended. */
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: (message: string) => void;
}

/** The trigger for `CoordinatorExecutor.flush` (§4.3, §4.11): on every tick each workstream's queue is flushed, which does
 *  nothing while its quiet hours last and sends the queued actions in order once they are over. */
export function startOutboundFlusher(opts: OutboundFlusherOptions): { tick: () => Promise<void>; stop: () => void } {
  const log = opts.logger ?? ((m: string) => console.log(m));
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      for (const ws of await opts.workstreams.list()) {
        try {
          const settled = await opts.executor.flush(ws.id);
          if (settled.length > 0) log(`outbound ${ws.id}: flushed ${settled.length} queued action(s)`);
        } catch (e) {
          log(`outbound ${ws.id}: flush failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      log(`outbound flush: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = false;
    }
  };
  const handle = (opts.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); (h as { unref?: () => void }).unref?.(); return h; }))(() => void tick(), opts.intervalMs ?? 60_000);
  return { tick, stop: () => (opts.clearInterval ?? ((h) => clearInterval(h as Parameters<typeof clearInterval>[0])))(handle) };
}

export interface BuiltinDeps {
  board: Pick<Board, "create">;
  projects: { list(): Promise<Project[]> };
  ownerTasks: { create(task: NewOwnerTask): Promise<OwnerTask> };
  holdDispatch: (reason: string) => void;
  releaseDispatch: () => void;
  requestRestart: () => { ok: true } | { ok: false; error: string };
  stopCard: (taskId: string) => Promise<unknown>; // the board's Discard: worktree removed, card to failed
}

const str = (v: unknown, name: string): string => (typeof v === "string" && v.trim() !== "" ? v : (() => { throw new Error(`${name} must be a non-empty string`); })());
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** The inward kinds of §4.3 against existing services. card.start renders the project's template with its rules and refuses an empty placeholder (§4.16). */
export function builtinHandlers(deps: BuiltinDeps): ActionHandlers {
  return {
    "card.start": async (a) => {
      const p = a.payload ?? {};
      const project = (await deps.projects.list()).find((x) => x.id === a.projectId);
      if (!project) throw new Error(`unknown project ${a.projectId}`);
      // `optional` names the placeholders that may be empty (a fix round's key, ticket and files; buildFixRoundBody).
      const rendered = renderCardTemplateFor(project, str(p.template, "template") as CardTemplateKind, (p.vars ?? {}) as Record<string, string | undefined>, { optional: list(p.optional) });
      if (!rendered.ok) throw new Error(rendered.error);
      const card: Omit<TaskCard, "id" | "status"> = {
        title: str(p.title, "title"), body: rendered.body, labels: list(p.labels), repo: project.path, dependsOn: [], workstreamId: a.workstreamId,
        ...(typeof p.key === "string" ? { key: p.key } : {}), ...(typeof p.round === "number" ? { round: p.round } : {}),
      };
      return deps.board.create(card);
    },
    "card.stop": (a) => deps.stopCard(str(a.payload?.taskId, "taskId")),
    "owner.task": (a) => {
      const p = a.payload ?? {};
      return deps.ownerTasks.create({ title: str(p.title, "title"), why: str(p.why, "why"), steps: list(p.steps), blocks: list(p.blocks), ...(Array.isArray(p.check) ? { check: p.check as string[] } : {}) });
    },
    "host.pause": async (a) => deps.holdDispatch(typeof a.payload?.reason === "string" ? a.payload.reason : "paused by the coordinator"),
    "host.resume": async () => deps.releaseDispatch(),
    "host.restart-when-idle": async () => {
      const r = deps.requestRestart();
      if (!r.ok) throw new Error(r.error);
    },
  };
}
