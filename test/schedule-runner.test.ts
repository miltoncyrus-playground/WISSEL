import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteScheduleStore, type ScheduleInput } from "../src/services/schedules.ts";
import { TelemetryLog, type TelemetryEvent } from "../src/services/telemetry.ts";
import { PipelineNotFoundError } from "../src/core/pipeline-runner.ts";
import {
  ON_TIME_GRACE_MS,
  SCHEDULE_TICK_MS,
  ScheduleOverlapError,
  ScheduleRunner,
  formatScheduleTime,
  type RunPipelineNowFn,
  type ScheduleRunnerOptions,
} from "../src/core/schedule-runner.ts";
import type { ScheduleDef, TaskCard } from "../src/core/types.ts";

// The schedule ticker, docs/SDD-schedules.md §3.4 and §3.6. Fake clock,
// fake timers, fake runPipelineNow: no network, no LLM, no real timer.

const MIN = 60_000;
const HOUR = 60 * MIN;
// 05:00 in Madrid (CEST): `0 6 * * *` is due at 04:00Z today.
const START = Date.parse("2026-10-12T03:00:00.000Z");
const TODAY_0600 = "2026-10-12T04:00:00.000Z";
const TOMORROW_0600 = "2026-10-13T04:00:00.000Z";

interface FakeTimer {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function fakeTimers() {
  const intervals: FakeTimer[] = [];
  const timeouts: FakeTimer[] = [];
  return {
    intervals,
    timeouts,
    setInterval: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      intervals.push(t);
      return t;
    },
    clearInterval: (h: unknown) => void ((h as FakeTimer).cleared = true),
    setTimeout: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timeouts.push(t);
      return t;
    },
    clearTimeout: (h: unknown) => void ((h as FakeTimer).cleared = true),
    /** Runs every pending, not-cleared timeout once. */
    flushTimeouts: () => {
      for (const t of timeouts.splice(0)) if (!t.cleared) t.fn();
    },
  };
}

/** A runPipelineNow that makes a root card (status "running"), calls
 *  onRootCreated and settles only when the test says so. `throwBefore`
 *  makes it reject before any root exists, like a missing pipeline. */
function fakePipelines(board: SqliteBoard, store: SqliteScheduleStore) {
  const calls: { pipelineId: string; repo?: string; input?: string; scheduleId: string; nextRunAtAtCall?: string }[] = [];
  const settle: Array<(e?: Error) => void> = [];
  let throwBefore: Error | undefined;
  const run: RunPipelineNowFn = async (pipelineId, repo, input, opts) => {
    calls.push({ pipelineId, repo, input, scheduleId: opts.scheduleId, nextRunAtAtCall: (await store.get(opts.scheduleId))?.nextRunAt });
    if (throwBefore) throw throwBefore;
    const root = await board.create({ title: `Pipeline: ${pipelineId}`, body: input ?? "", labels: [], repo, pipelineId, scheduleId: opts.scheduleId });
    await board.move(root.id, "running");
    opts.onRootCreated(root);
    return new Promise<TaskCard>((resolve, reject) => settle.push((e) => (e ? reject(e) : resolve(root))));
  };
  return {
    run,
    calls,
    settle,
    failBeforeRoot: (e: Error | undefined) => (throwBefore = e),
  };
}

function setup(extra: Partial<ScheduleRunnerOptions> = {}) {
  const board = new SqliteBoard();
  let clock = START;
  const now = () => new Date(clock);
  const store = new SqliteScheduleStore(board.db, { now });
  const timers = fakeTimers();
  const pipelines = fakePipelines(board, store);
  const events: TelemetryEvent[] = [];
  const lines: string[] = [];
  const errors: string[] = [];
  const runner = new ScheduleRunner({
    store,
    board,
    runPipelineNow: pipelines.run,
    telemetry: { record: async (e) => void events.push(e) },
    logger: { log: (l) => lines.push(l), error: (l) => errors.push(l) },
    now,
    ...timers,
    ...extra,
  });
  return {
    board,
    store,
    runner,
    timers,
    pipelines,
    events,
    lines,
    errors,
    setClock: (iso: string | number) => (clock = typeof iso === "number" ? iso : Date.parse(iso)),
  };
}

const podcast: ScheduleInput = { name: "AI news podcast", kind: "pipeline", pipelineId: "p1", input: "today", cron: "0 6 * * *", timezone: "Europe/Madrid" };
const retro: ScheduleInput = {
  name: "Daily retro",
  kind: "task",
  repo: "/r",
  taskTemplate: { title: "Retro", body: "Write the retro", labels: ["research"] },
  cron: "0 6 * * *",
  timezone: "Europe/Madrid",
};

async function get(store: SqliteScheduleStore, id: string): Promise<ScheduleDef> {
  return (await store.get(id))!;
}

// ---------- due, once, advance before fire ----------

test("fires a due pipeline schedule once across repeated ticks, and not before it is due", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  expect(s.nextRunAt).toBe(TODAY_0600);

  t.setClock(Date.parse(TODAY_0600) - 1000);
  await t.runner.tick();
  expect(t.pipelines.calls).toEqual([]);

  t.setClock(Date.parse(TODAY_0600) + 10_000);
  await t.runner.tick();
  await t.runner.tick();
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(1);
  expect(t.pipelines.calls[0]).toMatchObject({ pipelineId: "p1", input: "today", scheduleId: s.id });

  const after = await get(t.store, s.id);
  const root = (await t.board.list()).find((c) => c.pipelineId === "p1")!;
  expect(after).toMatchObject({ nextRunAt: TOMORROW_0600, lastRunAt: "2026-10-12T04:00:10.000Z", lastOutcome: "started", lastRunId: root.id, enabled: true });
  expect(after.lastError).toBeUndefined();
  expect(root.scheduleId).toBe(s.id);
});

test("advance before fire: nextRunAt is already the next occurrence when the run starts", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  expect(t.pipelines.calls[0]!.nextRunAtAtCall).toBe(TOMORROW_0600);
  expect((await get(t.store, s.id)).nextRunAt).toBe(TOMORROW_0600);
});

test("a run that throws after the advance is recorded as an error and does not fire again until the next occurrence", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.pipelines.failBeforeRoot(new Error("boom"));
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  t.setClock(Date.parse(TODAY_0600) + 5 * MIN);
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(1);
  expect(await get(t.store, s.id)).toMatchObject({ nextRunAt: TOMORROW_0600, lastOutcome: "error", lastError: "boom", enabled: true });
});

test("the tick doesn't wait for a pipeline run to settle; a rejection after the root exists is logged, not recorded", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick(); // resolves although the run is still pending
  expect(t.pipelines.settle).toHaveLength(1);
  t.pipelines.settle[0]!(new Error("step exploded"));
  await Bun.sleep(0);
  expect(t.errors).toEqual(['schedule: "AI news podcast" run failed: step exploded']);
  expect((await get(t.store, s.id)).lastOutcome).toBe("started");
});

// ---------- catch-up and staleness ----------

test("collapsed catch-up: several missed occurrences fire once, and nextRunAt counts from now", async () => {
  const t = setup();
  // Every 6 hours in UTC: 06:00Z, 12:00Z, 18:00Z were all missed.
  const s = await t.store.create({ ...podcast, cron: "0 */6 * * *", timezone: "UTC", catchUpHours: 24 });
  expect(s.nextRunAt).toBe("2026-10-12T06:00:00.000Z");
  t.setClock("2026-10-12T19:30:00.000Z");
  await t.runner.tick();
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(1);
  expect(await get(t.store, s.id)).toMatchObject({ lastOutcome: "started", nextRunAt: "2026-10-13T00:00:00.000Z" });
});

test("stale: more than catchUpHours late is skipped, advanced, and not run", async () => {
  const t = setup();
  const s = await t.store.create({ ...podcast, catchUpHours: 12 });
  t.setClock(Date.parse(TODAY_0600) + 13 * HOUR);
  await t.runner.tick();
  expect(t.pipelines.calls).toEqual([]);
  expect(await get(t.store, s.id)).toMatchObject({ lastOutcome: "skipped-stale", nextRunAt: TOMORROW_0600, lastRunAt: new Date(Date.parse(TODAY_0600) + 13 * HOUR).toISOString() });

  // 11 hours late is still in the window.
  const t2 = setup();
  const s2 = await t2.store.create({ ...podcast, catchUpHours: 12 });
  t2.setClock(Date.parse(TODAY_0600) + 11 * HOUR);
  await t2.runner.tick();
  expect((await get(t2.store, s2.id)).lastOutcome).toBe("started");
});

test("catchUpHours 0: a fire the tick finds a few seconds late still runs; one minutes late is stale", async () => {
  const onTime = setup();
  const a = await onTime.store.create({ ...podcast, catchUpHours: 0 });
  onTime.setClock(Date.parse(TODAY_0600) + SCHEDULE_TICK_MS);
  await onTime.runner.tick();
  expect((await get(onTime.store, a.id)).lastOutcome).toBe("started");

  const late = setup();
  const b = await late.store.create({ ...podcast, catchUpHours: 0 });
  late.setClock(Date.parse(TODAY_0600) + ON_TIME_GRACE_MS + 1000);
  await late.runner.tick();
  expect(late.pipelines.calls).toEqual([]);
  expect((await get(late.store, b.id)).lastOutcome).toBe("skipped-stale");
});

// ---------- overlap ----------

test("overlap: a pipeline root that isn't done or failed skips the next fire; once done the next one runs", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  const firstRun = (await get(t.store, s.id)).lastRunId!;

  t.setClock(Date.parse(TOMORROW_0600) + 5000);
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(1);
  expect(await get(t.store, s.id)).toMatchObject({ lastOutcome: "skipped-overlap", lastRunId: firstRun, nextRunAt: "2026-10-14T04:00:00.000Z" });
  expect(t.events.at(-1)).toMatchObject({ type: "schedule", outcome: "skipped-overlap", runId: firstRun });

  await t.board.move(firstRun, "done");
  t.setClock(Date.parse("2026-10-14T04:00:05.000Z"));
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(2);
  expect((await get(t.store, s.id)).lastOutcome).toBe("started");
});

test("overlap: a task card still open skips; archived (or done/failed) lets the next one run", async () => {
  const t = setup();
  const s = await t.store.create(retro);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  const first = (await get(t.store, s.id)).lastRunId!;

  t.setClock(Date.parse(TOMORROW_0600) + 5000);
  await t.runner.tick();
  expect((await get(t.store, s.id)).lastOutcome).toBe("skipped-overlap");
  expect((await t.board.list()).filter((c) => c.scheduleId === s.id)).toHaveLength(1);

  await t.board.archive(first);
  t.setClock(Date.parse("2026-10-14T04:00:05.000Z"));
  await t.runner.tick();
  expect((await get(t.store, s.id)).lastOutcome).toBe("started");
  expect((await t.board.list()).filter((c) => c.scheduleId === s.id && !c.archivedAt)).toHaveLength(1);
});

// ---------- task schedules ----------

test("a task schedule creates an inbox card from its template, with scheduleId and the schedule's repo", async () => {
  const t = setup();
  const s = await t.store.create(retro);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  const cards = (await t.board.list()).filter((c) => c.scheduleId === s.id);
  expect(cards).toHaveLength(1);
  expect(cards[0]).toMatchObject({ title: "Retro", body: "Write the retro", labels: ["research"], repo: "/r", status: "inbox", scheduleId: s.id });
  expect((await get(t.store, s.id)).lastRunId).toBe(cards[0]!.id);
  expect(t.pipelines.calls).toEqual([]);
});

test("a task template the deep checks now refuse is an error, the schedule stays enabled, and no card is made", async () => {
  const t = setup({ validateTaskTemplate: async () => ({ ok: false, error: 'unknown harnessOverride "gone"' }) });
  const s = await t.store.create(retro);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  expect(await get(t.store, s.id)).toMatchObject({ lastOutcome: "error", lastError: 'taskTemplate: unknown harnessOverride "gone"', enabled: true, nextRunAt: TOMORROW_0600 });
  expect(await t.board.list()).toEqual([]);
});

// ---------- errors ----------

test("a deleted pipeline is an error with the reason; the schedule stays enabled until disableForPipeline", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.pipelines.failBeforeRoot(new PipelineNotFoundError("pipeline not found: p1"));
  t.setClock(Date.parse(TODAY_0600) + 5000);
  await t.runner.tick();
  expect(await get(t.store, s.id)).toMatchObject({ lastOutcome: "error", lastError: "pipeline not found: p1", enabled: true });
  expect(t.errors).toContain('schedule: "AI news podcast" error: pipeline not found: p1');

  await t.store.disableForPipeline("p1", "pipeline deleted");
  t.setClock(Date.parse(TOMORROW_0600) + 5000);
  await t.runner.tick();
  expect(t.pipelines.calls).toHaveLength(1);
  expect(await get(t.store, s.id)).toMatchObject({ enabled: false, lastError: "pipeline deleted" });
  expect((await get(t.store, s.id)).nextRunAt).toBeUndefined();
});

// ---------- run now ----------

test("runNow fires through the same code and leaves nextRunAt alone", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  const result = await t.runner.runNow(s.id);
  const after = await get(t.store, s.id);
  expect(result).toEqual({ outcome: "started", runId: after.lastRunId });
  expect(after).toMatchObject({ nextRunAt: TODAY_0600, lastOutcome: "started", lastRunAt: new Date(START).toISOString() });
  expect(t.lines).toContain(`schedule: "AI news podcast" fired, run ${after.lastRunId}`);
});

test("runNow refuses with ScheduleOverlapError while the last run is open, and writes nothing", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  await t.runner.runNow(s.id);
  const before = await get(t.store, s.id);
  let err: unknown;
  try {
    await t.runner.runNow(s.id);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ScheduleOverlapError);
  expect(await get(t.store, s.id)).toEqual(before);
  expect(t.pipelines.calls).toHaveLength(1);
});

test("runNow on a disabled schedule runs and keeps it disabled with no nextRunAt", async () => {
  const t = setup();
  const s = await t.store.create({ ...podcast, enabled: false });
  await t.runner.runNow(s.id);
  expect(await get(t.store, s.id)).toMatchObject({ enabled: false, lastOutcome: "started" });
  expect((await get(t.store, s.id)).nextRunAt).toBeUndefined();
});

// ---------- enabled, start, stop, store changes ----------

test("a disabled schedule never fires", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  await t.store.update(s.id, { enabled: false });
  for (const at of [TODAY_0600, TOMORROW_0600, "2026-10-20T04:00:00.000Z"]) {
    t.setClock(Date.parse(at) + 5000);
    await t.runner.tick();
  }
  expect(t.pipelines.calls).toEqual([]);
  expect(t.events).toEqual([]);
});

test("start ticks at once, every 30 s, and right after a store change; stop clears the interval and the listener", async () => {
  const t = setup();
  const s = await t.store.create(podcast);
  t.setClock(Date.parse(TODAY_0600) + 5000);
  t.runner.start();
  expect(t.timers.intervals).toHaveLength(1);
  expect(t.timers.intervals[0]!.ms).toBe(30_000);
  await t.runner.tick(); // joins the start tick
  expect(t.pipelines.calls).toHaveLength(1);
  expect(t.lines[0]).toBe(`schedules: 1 enabled, next: AI news podcast at 2026-10-12 06:00 Europe/Madrid`);

  // The ticker's own write doesn't schedule a change tick.
  expect(t.timers.timeouts).toHaveLength(0);

  // A store change (switching it off and on, so nextRunAt counts from
  // now) arms an immediate tick on the next turn.
  await t.board.move((await get(t.store, s.id)).lastRunId!, "done");
  const other = await t.store.create({ ...podcast, name: "World news", pipelineId: "p2", cron: "*/10 * * * *" });
  expect(t.timers.timeouts).toHaveLength(1);
  expect(t.timers.timeouts[0]!.ms).toBe(0);
  t.setClock(Date.parse(other.nextRunAt!) + 1000);
  t.timers.flushTimeouts();
  await t.runner.tick();
  expect(t.pipelines.calls.map((c) => c.pipelineId)).toEqual(["p1", "p2"]);

  // The interval callback ticks too.
  await t.board.move((await get(t.store, other.id)).lastRunId!, "done");
  t.setClock(Date.parse((await get(t.store, other.id)).nextRunAt!) + 1000);
  t.timers.intervals[0]!.fn();
  await t.runner.tick();
  expect(t.pipelines.calls.map((c) => c.pipelineId)).toEqual(["p1", "p2", "p2"]);

  t.runner.stop();
  expect(t.timers.intervals[0]!.cleared).toBe(true);
  await t.store.update(s.id, { name: "renamed" });
  expect(t.timers.timeouts).toHaveLength(0);
});

test("start logs 0 enabled when nothing is scheduled", async () => {
  const t = setup();
  t.runner.start();
  await t.runner.tick();
  expect(t.lines).toEqual(["schedules: 0 enabled"]);
  t.runner.stop();
});

// ---------- trace ----------

test("every fire, skip and error writes one log line and one telemetry event", async () => {
  const t = setup();
  const fired = await t.store.create(podcast); // due 04:00Z today
  const stale = await t.store.create({ ...podcast, name: "Stale one", pipelineId: "p2", catchUpHours: 1 });
  const broken = await t.store.create({ ...retro, name: "Broken task" });
  // Hand-edit the rows: "Stale one" was due 3 h ago, "Broken task" lost
  // its template (the store would refuse both).
  t.board.db.run("UPDATE schedules SET nextRunAt = ? WHERE id = ?", ["2026-10-12T01:00:00.000Z", stale.id]);
  t.board.db.run("UPDATE schedules SET taskTemplate = NULL WHERE id = ?", [broken.id]);

  const at = "2026-10-12T04:00:05.000Z";
  t.setClock(at);
  await t.runner.tick();

  const runId = (await get(t.store, fired.id)).lastRunId!;
  expect(t.events).toEqual([
    { type: "schedule", scheduleId: fired.id, name: "AI news podcast", outcome: "started", runId, at },
    { type: "schedule", scheduleId: stale.id, name: "Stale one", outcome: "skipped-stale", at },
    { type: "schedule", scheduleId: broken.id, name: "Broken task", outcome: "error", error: "a task schedule needs a taskTemplate", at },
  ]);
  expect(t.lines).toEqual([`schedule: "AI news podcast" fired, run ${runId}`, 'schedule: "Stale one" skipped (stale)']);
  expect(t.errors).toEqual(['schedule: "Broken task" error: a task schedule needs a taskTemplate']);
  expect(await get(t.store, broken.id)).toMatchObject({ lastOutcome: "error", lastError: "a task schedule needs a taskTemplate", enabled: true });

  // Overlap is traced the same way.
  t.setClock(Date.parse(TOMORROW_0600) + 5000);
  await t.runner.tick();
  expect(t.lines.at(-2)).toBe('schedule: "AI news podcast" skipped (overlap)');
});

test("TelemetryLog keeps a schedule event's own `at` (the ticker's clock)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-schedule-telemetry-"));
  try {
    const log = new TelemetryLog(join(dir, "t.jsonl"));
    await log.record({ type: "schedule", scheduleId: "s1", name: "n", outcome: "skipped-overlap", runId: "r1", at: "2026-10-12T04:00:00.000Z" });
    await log.record({ type: "dispatch", taskId: "t", agentId: "a" });
    const [a, b] = (await readFile(join(dir, "t.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(a).toEqual({ type: "schedule", scheduleId: "s1", name: "n", outcome: "skipped-overlap", runId: "r1", at: "2026-10-12T04:00:00.000Z" });
    expect(Number.isNaN(Date.parse(b!.at as string))).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatScheduleTime shows the wall clock in the schedule's zone", () => {
  expect(formatScheduleTime(TOMORROW_0600, "Europe/Madrid")).toBe("2026-10-13 06:00 Europe/Madrid");
  expect(formatScheduleTime("2026-10-26T05:00:00.000Z", "Europe/Madrid")).toBe("2026-10-26 06:00 Europe/Madrid");
});
