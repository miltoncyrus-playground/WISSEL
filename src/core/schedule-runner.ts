import type { Board } from "../services/board.ts";
import type { ScheduleStore } from "../services/schedules.ts";
import type { TelemetryLog } from "../services/telemetry.ts";
import { nextRunAfter } from "./schedule-time.ts";
import type { ScheduleDef, ScheduleOutcome, ScheduleTaskTemplate, TaskCard } from "./types.ts";

/**
 * The schedule ticker (docs/SDD-schedules.md §3.4). In-process, owns the
 * only timer: croner (src/core/schedule-time.ts) only says when.
 *
 * Every tick reads the store, and for each enabled schedule whose
 * `nextRunAt` has passed:
 *
 * - advances `nextRunAt` to the first occurrence after *now* (not after
 *   the old `nextRunAt`, so any number of missed occurrences collapse
 *   into one) in one write, before anything starts: a crash between the
 *   write and the run loses that run, it never doubles it;
 * - skips it as stale when it is more than `catchUpHours` late;
 * - skips it as an overlap while its last run (`lastRunId`) isn't
 *   finished;
 * - otherwise fires: a pipeline through the shared runPipelineNow
 *   (src/core/pipeline-runner.ts), never awaiting the run's settlement,
 *   or a task card the normal sweep then routes with every usual gate.
 *
 * Ticks and run-nows go through one queue, so two of them never look at
 * the same schedule at once.
 */

/** Fire precision: due work is found at most this late. */
export const SCHEDULE_TICK_MS = 30_000;

/** A fire found by a tick soon after its time is on time, not a catch-up:
 *  without this, `catchUpHours: 0` ("never catch up") would skip every
 *  run the 30 s tick reaches a few seconds late. */
export const ON_TIME_GRACE_MS = 60_000;

const HOUR_MS = 60 * 60 * 1000;

/** run-now refused: the schedule's last run is still going. */
export class ScheduleOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleOverlapError";
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`schedule not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}

/** runPipelineNow bound to the server's board, registry and executors. */
export type RunPipelineNowFn = (
  pipelineId: string,
  repo: string | undefined,
  input: string | undefined,
  opts: { onRootCreated: (root: TaskCard) => void; scheduleId: string },
) => Promise<TaskCard>;

export interface ScheduleRunnerLogger {
  log(line: string): void;
  error(line: string): void;
}

export interface ScheduleRunnerOptions {
  store: ScheduleStore;
  board: Pick<Board, "get" | "create">;
  runPipelineNow: RunPipelineNowFn;
  /** The deep `POST /tasks` checks, re-run on every fire: a harness the
   *  template names may have gone since the schedule was saved. */
  validateTaskTemplate?: (template: ScheduleTaskTemplate) => Promise<{ ok: true } | { ok: false; error: string }>;
  telemetry?: Pick<TelemetryLog, "record">;
  logger?: ScheduleRunnerLogger;
  now?: () => Date;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  tickMs?: number;
}

/** What one fire did; `runId` on `started`, `error` on `error`. */
export interface ScheduleFireResult {
  outcome: ScheduleOutcome;
  runId?: string;
  error?: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** "2026-10-13 06:00 Europe/Madrid": a wall-clock time in the schedule's
 *  own zone, for log lines. */
export function formatScheduleTime(iso: string, timezone: string): string {
  const local = new Date(iso).toLocaleString("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${local} ${timezone}`;
}

export class ScheduleRunner {
  private readonly store: ScheduleStore;
  private readonly board: Pick<Board, "get" | "create">;
  private readonly runPipeline: RunPipelineNowFn;
  private readonly validateTaskTemplate: ScheduleRunnerOptions["validateTaskTemplate"];
  private readonly telemetry: ScheduleRunnerOptions["telemetry"];
  private readonly logger: ScheduleRunnerLogger;
  private readonly now: () => Date;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly tickMs: number;

  private interval: unknown;
  private pendingChangeTick: unknown;
  private unsubscribe?: () => void;
  /** Every tick and run-now runs after the previous one finished. */
  private queue: Promise<unknown> = Promise.resolve();
  /** A tick queued but not started yet: a second request joins it. */
  private queuedTick?: Promise<void>;

  constructor(opts: ScheduleRunnerOptions) {
    this.store = opts.store;
    this.board = opts.board;
    this.runPipeline = opts.runPipelineNow;
    this.validateTaskTemplate = opts.validateTaskTemplate;
    this.telemetry = opts.telemetry;
    this.logger = opts.logger ?? { log: (l) => console.log(l), error: (l) => console.error(l) };
    this.now = opts.now ?? (() => new Date());
    this.setIntervalFn = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.setTimeoutFn = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.tickMs = opts.tickMs ?? SCHEDULE_TICK_MS;
  }

  /** Logs what is scheduled, ticks once now, then every `tickMs` and
   *  right after any store change other than the ticker's own writes. */
  start(): void {
    if (this.interval !== undefined) return;
    this.unsubscribe = this.store.onChange((event) => {
      if (event.type === "schedule.ran") return;
      if (this.pendingChangeTick !== undefined) return;
      // Next turn, so the write that changed it has returned first.
      this.pendingChangeTick = this.setTimeoutFn(() => {
        this.pendingChangeTick = undefined;
        void this.tick();
      }, 0);
    });
    this.interval = this.setIntervalFn(() => void this.tick(), this.tickMs);
    void this.exclusive(() => this.logStart());
    void this.tick();
  }

  stop(): void {
    if (this.interval !== undefined) this.clearIntervalFn(this.interval);
    if (this.pendingChangeTick !== undefined) this.clearTimeoutFn(this.pendingChangeTick);
    this.interval = undefined;
    this.pendingChangeTick = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** One pass over every schedule. Resolves when it is done; never
   *  rejects (a failing schedule is logged and the others still run). */
  tick(): Promise<void> {
    if (this.queuedTick) return this.queuedTick;
    const t = this.exclusive(async () => {
      this.queuedTick = undefined;
      await this.tickOnce();
    });
    this.queuedTick = t;
    return t;
  }

  /** Fires `id` now through the same code as a tick, leaving `nextRunAt`
   *  alone. Throws ScheduleNotFoundError, or ScheduleOverlapError while
   *  the last run isn't finished. An `error` result (pipeline gone, repo
   *  missing, template invalid) is recorded and returned, not thrown. */
  runNow(id: string): Promise<ScheduleFireResult> {
    return this.exclusive(async () => {
      const s = await this.store.get(id);
      if (!s) throw new ScheduleNotFoundError(id);
      if (await this.lastRunActive(s)) {
        throw new ScheduleOverlapError(`schedule "${s.name}" is still on its last run (${s.lastRunId}); try again when it has finished`);
      }
      return this.fire(s, this.now(), s.nextRunAt ?? null);
    });
  }

  /** Status of the schedule's last run card, or null when there is none
   *  (never ran, or the card was deleted). */
  async lastRunStatus(s: ScheduleDef): Promise<TaskCard["status"] | null> {
    if (!s.lastRunId) return null;
    return (await this.board.get(s.lastRunId))?.status ?? null;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async logStart(): Promise<void> {
    try {
      const enabled = (await this.store.list()).filter((s) => s.enabled && s.nextRunAt);
      enabled.sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
      const first = enabled[0];
      this.logger.log(
        first ? `schedules: ${enabled.length} enabled, next: ${first.name} at ${formatScheduleTime(first.nextRunAt!, first.timezone)}` : "schedules: 0 enabled",
      );
    } catch (e) {
      this.logger.error(`schedules: couldn't read schedules: ${errorText(e)}`);
    }
  }

  private async tickOnce(): Promise<void> {
    let all: ScheduleDef[];
    try {
      all = await this.store.list();
    } catch (e) {
      this.logger.error(`schedules: tick failed: ${errorText(e)}`);
      return;
    }
    const now = this.now();
    for (const s of all) {
      if (!s.enabled || !s.nextRunAt || Date.parse(s.nextRunAt) > now.getTime()) continue;
      try {
        await this.handleDue(s, now);
      } catch (e) {
        this.logger.error(`schedule: "${s.name}" tick failed: ${errorText(e)}`);
      }
    }
  }

  private async handleDue(s: ScheduleDef, now: Date): Promise<void> {
    const at = now.toISOString();
    let next: string;
    try {
      next = nextRunAfter(s.cron, s.timezone, now).toISOString();
    } catch (e) {
      // The store validated it, so only a hand-edited row lands here.
      // No next run: it stays visible as an error until someone fixes it.
      await this.record(s, { nextRunAt: null, lastRunAt: at, lastOutcome: "error", lastError: errorText(e) }, { outcome: "error", error: errorText(e) }, at);
      return;
    }
    const lateMs = now.getTime() - Date.parse(s.nextRunAt!);
    if (lateMs > s.catchUpHours * HOUR_MS + ON_TIME_GRACE_MS) {
      await this.record(s, { nextRunAt: next, lastRunAt: at, lastOutcome: "skipped-stale" }, { outcome: "skipped-stale" }, at);
      return;
    }
    if (await this.lastRunActive(s)) {
      await this.record(s, { nextRunAt: next, lastRunAt: at, lastOutcome: "skipped-overlap" }, { outcome: "skipped-overlap", runId: s.lastRunId }, at);
      return;
    }
    await this.fire(s, now, next);
  }

  /** Advance first, then start. `nextRunAt` is what the schedule keeps:
   *  the next occurrence for a tick, the current one for a run-now. */
  private async fire(s: ScheduleDef, now: Date, nextRunAt: string | null): Promise<ScheduleFireResult> {
    const at = now.toISOString();
    // The at-most-once write. "started" here is provisional: the write
    // below replaces it with the run id, or with the error.
    await this.store.recordRun(s.id, { nextRunAt, lastRunAt: at, lastOutcome: "started" });
    const started = s.kind === "pipeline" ? await this.startPipeline(s) : await this.createTask(s);
    const result: ScheduleFireResult = "runId" in started ? { outcome: "started", runId: started.runId } : { outcome: "error", error: started.error };
    await this.record(
      s,
      "runId" in started
        ? { nextRunAt, lastRunAt: at, lastOutcome: "started", lastRunId: started.runId }
        : { nextRunAt, lastRunAt: at, lastOutcome: "error", lastError: started.error },
      result,
      at,
    );
    return result;
  }

  /** Resolves as soon as the root card exists; the run goes on without
   *  the tick waiting for it. */
  private async startPipeline(s: ScheduleDef): Promise<{ runId: string } | { error: string }> {
    if (!s.pipelineId) return { error: "a pipeline schedule needs a pipelineId" };
    try {
      const root = await new Promise<TaskCard>((resolve, reject) => {
        let rootSeen = false;
        this.runPipeline(s.pipelineId!, s.repo, s.input, {
          scheduleId: s.id,
          onRootCreated: (r) => {
            rootSeen = true;
            resolve(r);
          },
        }).then(resolve, (e: unknown) => {
          // Before the root exists this is the fire's error; after, the
          // run's own cards show the failure.
          if (rootSeen) this.logger.error(`schedule: "${s.name}" run failed: ${errorText(e)}`);
          else reject(e);
        });
      });
      return { runId: root.id };
    } catch (e) {
      return { error: errorText(e) };
    }
  }

  private async createTask(s: ScheduleDef): Promise<{ runId: string } | { error: string }> {
    if (!s.taskTemplate) return { error: "a task schedule needs a taskTemplate" };
    const template: ScheduleTaskTemplate = { ...s.taskTemplate, ...(s.taskTemplate.repo || !s.repo ? {} : { repo: s.repo }) };
    try {
      if (this.validateTaskTemplate) {
        const check = await this.validateTaskTemplate(template);
        if (!check.ok) return { error: `taskTemplate: ${check.error}` };
      }
      const card = await this.board.create({ ...template, scheduleId: s.id });
      return { runId: card.id };
    } catch (e) {
      return { error: errorText(e) };
    }
  }

  /** The last run is still going: a pipeline root not done/failed, a
   *  task card not done/failed/archived. A deleted card is not. */
  private async lastRunActive(s: ScheduleDef): Promise<boolean> {
    if (!s.lastRunId) return false;
    const card = await this.board.get(s.lastRunId);
    if (!card) return false;
    if (card.status === "done" || card.status === "failed") return false;
    if (s.kind === "task" && card.archivedAt) return false;
    return true;
  }

  /** The store write plus the trace (§3.6): one log line and one
   *  telemetry event per fire, skip or error. */
  private async record(s: ScheduleDef, run: Parameters<ScheduleStore["recordRun"]>[1], result: ScheduleFireResult, at: string): Promise<void> {
    await this.store.recordRun(s.id, run);
    if (result.outcome === "started") this.logger.log(`schedule: "${s.name}" fired, run ${result.runId}`);
    else if (result.outcome === "error") this.logger.error(`schedule: "${s.name}" error: ${result.error}`);
    else this.logger.log(`schedule: "${s.name}" skipped (${result.outcome === "skipped-overlap" ? "overlap" : "stale"})`);
    try {
      await this.telemetry?.record({
        type: "schedule",
        scheduleId: s.id,
        name: s.name,
        outcome: result.outcome,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(result.error ? { error: result.error } : {}),
        at,
      });
    } catch (e) {
      this.logger.error(`schedule: "${s.name}" telemetry failed: ${errorText(e)}`);
    }
  }
}
