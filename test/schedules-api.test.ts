import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { previewSchedule, type ScheduleView, type SchedulePreview } from "../src/services/board-actions.ts";
import { Registry } from "../src/core/registry.ts";
import { PipelineNotFoundError, PipelineRepoRequiredError, runPipelineNow } from "../src/core/pipeline-runner.ts";
import type { AgentDef, Executor, PipelineGraph, TaskCard } from "../src/core/types.ts";

// The /schedules API (docs/SDD-schedules.md §3.5), its wiring in
// createApp (§3.4), and the shared runPipelineNow. Fake clock and timers,
// fake executors: no network, no LLM.

// 05:00 in Madrid: `0 6 * * *` is due at 04:00Z today.
const START = Date.parse("2026-10-12T03:00:00.000Z");

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "reader",
    name: "Reader",
    kind: "agent",
    tier: "readonly",
    description: "reads",
    whenToUse: "test only",
    tags: ["test-read"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-opus-5-5", estUsdPerTask: 0.01 },
    ...overrides,
  };
}

const writer = agentDef({ id: "writer", tier: "write", executor: "handoff", toolAccess: ["read", "write", "bash"], tags: ["test-write"] });
const readGraph: PipelineGraph = { steps: [{ id: "a", name: "Read", agentId: "reader", transition: "all" }], edges: [] };
const mixedGraph: PipelineGraph = {
  steps: [
    { id: "a", name: "Read", agentId: "reader", transition: "all" },
    { id: "b", name: "Write code", agentId: "writer", transition: "all" },
  ],
  edges: [{ id: "e", from: "a", to: "b" }],
};

function recordingExecutor(seen: TaskCard[]): Executor {
  return { id: "rec", canHandle: (a) => a.id !== "concierge", run: async (t, a) => (seen.push(t), { taskId: t.id, agentId: a.id, ok: true, summary: "ok" }) };
}

interface FakeTimer {
  fn: () => void;
  ms: number;
}

async function setup(opts: { schedulesEnabled?: boolean } = {}) {
  const board = new SqliteBoard();
  const registry = Registry.from([agentDef(), writer]);
  let clock = START;
  const seen: TaskCard[] = [];
  const intervals: FakeTimer[] = [];
  const lines: string[] = [];
  const pipelines = new SqlitePipelineStore(board.db);
  const app = createApp(board, registry, undefined, {
    manualExecutors: [recordingExecutor(seen)],
    pipelines,
    schedulesEnabled: opts.schedulesEnabled,
    scheduleClock: {
      now: () => new Date(clock),
      setInterval: (fn, ms) => {
        const t = { fn, ms };
        intervals.push(t);
        return t;
      },
      clearInterval: () => {},
      setTimeout: () => undefined,
      clearTimeout: () => {},
      logger: { log: (l) => lines.push(l), error: (l) => lines.push(l) },
    },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app(
      new Request(`http://localhost${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // plain "not found"
    }
    return { status: res.status, data: data as any };
  };
  const readPipeline = await pipelines.create({ name: "Reader run", description: "", graph: readGraph });
  const mixedPipeline = await pipelines.create({ name: "Mixed", description: "", graph: mixedGraph });
  return { board, app, call, seen, intervals, lines, readPipeline, mixedPipeline, setClock: (ms: number) => (clock = ms) };
}

const taskBody = { name: "Daily retro", kind: "task", taskTemplate: { title: "Retro", body: "Write it", labels: ["no-such-label"] }, cron: "0 6 * * *" };

// ---------- CRUD ----------

test("POST /schedules creates a schedule (201) with the default timezone, cadence and lastRunStatus null", async () => {
  const t = await setup();
  const res = await t.call("POST", "/schedules", taskBody);
  expect(res.status).toBe(201);
  const s = res.data as ScheduleView;
  expect(s).toMatchObject({ name: "Daily retro", kind: "task", timezone: "Europe/Madrid", enabled: true, catchUpHours: 12, cadence: "every day at 06:00", lastRunStatus: null, nextRunAt: "2026-10-12T04:00:00.000Z" });

  const list = await t.call("GET", "/schedules");
  expect(list.status).toBe(200);
  expect((list.data as ScheduleView[]).map((x) => [x.id, x.cadence, x.lastRunStatus])).toEqual([[s.id, "every day at 06:00", null]]);
  expect((await t.call("GET", `/schedules/${s.id}`)).data).toEqual(s);
});

test("POST /schedules: every validation failure is a 400 with a plain message", async () => {
  const t = await setup();
  const cases: [unknown, string][] = [
    [{ ...taskBody, cron: "0 6 * *" }, 'cron must have exactly 5 fields (minute hour day-of-month month day-of-week), "0 6 * *" has 4'],
    [{ ...taskBody, cron: "* * * * *" }, 'runs must be at least 5 minutes apart; "* * * * *" runs 1 minute apart'],
    [{ ...taskBody, timezone: "Mars/Olympus" }, 'unknown timezone "Mars/Olympus", use an IANA name like Europe/Madrid'],
    [{ ...taskBody, name: "" }, "name is required"],
    [{ ...taskBody, kind: "cron" }, 'kind must be "pipeline" or "task"'],
    [{ ...taskBody, color: "red" }, 'unknown field "color"'],
    [{ ...taskBody, catchUpHours: -1 }, "catchUpHours must be a number of hours, 0 or more (0 = never catch up)"],
    [{ ...taskBody, taskTemplate: { title: "x" } }, "taskTemplate.body must be a string"],
    [{ name: "P", kind: "pipeline", pipelineId: "nope", cron: "0 6 * * *" }, "pipeline not found: nope"],
    [[1, 2], "body must be a JSON object"],
    ["not json", "body must be a JSON object"],
  ];
  for (const [body, error] of cases) {
    const res = await t.call("POST", "/schedules", body);
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(res.data, JSON.stringify(body)).toEqual({ error });
  }
  expect((await t.call("GET", "/schedules")).data).toEqual([]);
});

test("PATCH /schedules/:id updates fields and recomputes nextRunAt; fixed fields and bad values are 400; unknown id 404", async () => {
  const t = await setup();
  const s = (await t.call("POST", "/schedules", taskBody)).data as ScheduleView;

  const moved = await t.call("PATCH", `/schedules/${s.id}`, { cron: "0 7 * * 1-5", name: "Weekday retro" });
  expect(moved.status).toBe(200);
  expect(moved.data).toMatchObject({ name: "Weekday retro", cron: "0 7 * * 1-5", cadence: "weekdays at 07:00", nextRunAt: "2026-10-12T05:00:00.000Z" });

  const off = await t.call("PATCH", `/schedules/${s.id}`, { enabled: false });
  expect(off.data.enabled).toBe(false);
  expect(off.data.nextRunAt).toBeUndefined();

  expect(await t.call("PATCH", `/schedules/${s.id}`, { kind: "pipeline" })).toEqual({ status: 400, data: { error: "kind can't be changed; make a new schedule instead" } });
  expect(await t.call("PATCH", `/schedules/${s.id}`, { timezone: "Nowhere/Land" })).toEqual({ status: 400, data: { error: 'unknown timezone "Nowhere/Land", use an IANA name like Europe/Madrid' } });
  expect(await t.call("PATCH", `/schedules/${s.id}`, { enabled: "yes" })).toEqual({ status: 400, data: { error: "enabled must be true or false" } });
  expect((await t.call("PATCH", "/schedules/missing", { name: "x" })).status).toBe(404);
});

test("DELETE /schedules/:id is 204, then 404", async () => {
  const t = await setup();
  const s = (await t.call("POST", "/schedules", taskBody)).data as ScheduleView;
  expect((await t.call("DELETE", `/schedules/${s.id}`)).status).toBe(204);
  expect((await t.call("GET", `/schedules/${s.id}`)).status).toBe(404);
  expect((await t.call("DELETE", `/schedules/${s.id}`)).status).toBe(404);
});

// ---------- run-now ----------

test("POST /schedules/:id/run-now on a task schedule makes a card; lastRunStatus follows it; a second run-now is 409", async () => {
  const t = await setup();
  const s = (await t.call("POST", "/schedules", taskBody)).data as ScheduleView;
  const run = await t.call("POST", `/schedules/${s.id}/run-now`);
  expect(run.status).toBe(200);
  const card = (await t.board.get(run.data.runId))!;
  expect(card).toMatchObject({ title: "Retro", scheduleId: s.id, status: "inbox" });

  const after = (await t.call("GET", `/schedules/${s.id}`)).data as ScheduleView;
  expect(after).toMatchObject({ lastRunId: card.id, lastOutcome: "started", lastRunStatus: "inbox", nextRunAt: s.nextRunAt });

  const again = await t.call("POST", `/schedules/${s.id}/run-now`);
  expect(again.status).toBe(409);
  expect(again.data.error).toContain("is still on its last run");

  await t.board.move(card.id, "done");
  expect(((await t.call("GET", "/schedules")).data as ScheduleView[])[0]!.lastRunStatus).toBe("done");
  expect((await t.call("POST", `/schedules/${s.id}/run-now`)).status).toBe(200);
  expect((await t.call("POST", "/schedules/missing/run-now")).status).toBe(404);
});

test("run-now on a pipeline schedule runs it on the shared path; the root carries scheduleId", async () => {
  const t = await setup();
  const s = (await t.call("POST", "/schedules", { name: "Reader", kind: "pipeline", pipelineId: t.readPipeline.id, input: "go", cron: "0 6 * * *" })).data as ScheduleView;
  const run = await t.call("POST", `/schedules/${s.id}/run-now`);
  expect(run.status).toBe(200);
  const root = (await t.board.get(run.data.runId))!;
  expect(root).toMatchObject({ pipelineId: t.readPipeline.id, scheduleId: s.id, body: "go" });
  // The executor ran the step (the run continues past the response).
  await Bun.sleep(10);
  expect(t.seen.map((c) => c.pipelineStepId)).toEqual(["a"]);
  expect((await t.board.get(root.id))!.status).toBe("done");
});

test("run-now on a pipeline that needs a repo and has none is a 400, recorded as an error, and makes no card", async () => {
  const t = await setup();
  const s = (await t.call("POST", "/schedules", { name: "Mixed", kind: "pipeline", pipelineId: t.mixedPipeline.id, cron: "0 6 * * *" })).data as ScheduleView;
  const run = await t.call("POST", `/schedules/${s.id}/run-now`);
  const error = 'repo is required: pipeline "Mixed" has steps with file/bash access: "Write code" (writer)';
  expect(run).toEqual({ status: 400, data: { error } });
  expect((await t.call("GET", `/schedules/${s.id}`)).data).toMatchObject({ lastOutcome: "error", lastError: error, enabled: true });
  expect(await t.board.list()).toEqual([]);
});

// ---------- preview ----------

test("GET /schedules/preview gives cadence and the next 5 runs; invalid is valid:false with the reason", async () => {
  const t = await setup();
  const ok = await t.call("GET", "/schedules/preview?cron=0%206%20*%20*%20*&timezone=Europe/Madrid");
  expect(ok).toEqual({
    status: 200,
    data: {
      valid: true,
      cadence: "every day at 06:00",
      next: ["2026-10-12T04:00:00.000Z", "2026-10-13T04:00:00.000Z", "2026-10-14T04:00:00.000Z", "2026-10-15T04:00:00.000Z", "2026-10-16T04:00:00.000Z"],
    },
  });
  // No timezone: the default one. Across the 2026-10-25 DST change.
  const dst = (await t.call("GET", "/schedules/preview?cron=0%206%2024-26%2010%20*")).data as SchedulePreview;
  expect(dst.next.slice(0, 3)).toEqual(["2026-10-24T04:00:00.000Z", "2026-10-25T05:00:00.000Z", "2026-10-26T05:00:00.000Z"]);

  const bad = await t.call("GET", "/schedules/preview?cron=*%20*%20*%20*%20*");
  expect(bad).toEqual({ status: 200, data: { valid: false, error: 'runs must be at least 5 minutes apart; "* * * * *" runs 1 minute apart', cadence: "* * * * *", next: [] } });
  expect((await t.call("GET", "/schedules/preview")).data).toEqual({ valid: false, error: "cron is required, e.g. 0 6 * * *", cadence: "", next: [] });
  expect((await t.call("GET", "/schedules/preview?cron=0%206%20*%20*%20*&timezone=Bad/Zone")).data.valid).toBe(false);
});

test("previewSchedule is pure: same inputs, same answer", () => {
  const now = new Date(START);
  expect(previewSchedule("30 7 * * 1-5", "UTC", now)).toEqual(previewSchedule("30 7 * * 1-5", "UTC", now));
  expect(previewSchedule("30 7 * * 1-5", "UTC", now).next[0]).toBe("2026-10-12T07:30:00.000Z");
});

// ---------- pipeline deleted ----------

test("DELETE /pipelines/:id disables its schedules with lastError 'pipeline deleted'; other schedules untouched", async () => {
  const t = await setup();
  const doomed = (await t.call("POST", "/schedules", { name: "Reader", kind: "pipeline", pipelineId: t.readPipeline.id, cron: "0 6 * * *" })).data as ScheduleView;
  const kept = (await t.call("POST", "/schedules", taskBody)).data as ScheduleView;
  expect((await t.call("DELETE", `/pipelines/${t.readPipeline.id}`)).status).toBe(204);
  const after = (await t.call("GET", `/schedules/${doomed.id}`)).data as ScheduleView;
  expect(after).toMatchObject({ enabled: false, lastError: "pipeline deleted" });
  expect(after.nextRunAt).toBeUndefined();
  expect((await t.call("GET", `/schedules/${kept.id}`)).data).toMatchObject({ enabled: true, nextRunAt: kept.nextRunAt });
});

// ---------- wiring ----------

test("schedulesEnabled starts the ticker: a start log line, a 30 s interval, and a due schedule fires on its tick", async () => {
  const t = await setup({ schedulesEnabled: true });
  expect(t.intervals.map((i) => i.ms)).toEqual([30_000]);
  const s = (await t.call("POST", "/schedules", taskBody)).data as ScheduleView;
  t.setClock(Date.parse("2026-10-12T04:00:05.000Z"));
  t.intervals[0]!.fn();
  // Ticks are queued: a GET after the tick reads the result.
  await Bun.sleep(10);
  const after = (await t.call("GET", `/schedules/${s.id}`)).data as ScheduleView;
  expect(after).toMatchObject({ lastOutcome: "started", lastRunStatus: "inbox", nextRunAt: "2026-10-13T04:00:00.000Z" });
  expect(t.lines[0]).toBe("schedules: 0 enabled");
  expect(t.lines).toContain(`schedule: "Daily retro" fired, run ${after.lastRunId}`);
});

test("without schedulesEnabled no timer is armed", async () => {
  const t = await setup();
  expect(t.intervals).toEqual([]);
});

// ---------- runPipelineNow ----------

test("runPipelineNow: typed errors before any card; scheduleId and onRootCreated on a real run", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([agentDef(), writer]);
  const pipelines = new SqlitePipelineStore(board.db);
  const seen: TaskCard[] = [];
  const deps = { board, registry, pipelines, executors: [recordingExecutor(seen)] };
  const read = await pipelines.create({ name: "Reader run", description: "", graph: readGraph });
  const mixed = await pipelines.create({ name: "Mixed", description: "", graph: mixedGraph });

  await expect(runPipelineNow(deps, "missing", undefined, "")).rejects.toBeInstanceOf(PipelineNotFoundError);
  await expect(runPipelineNow(deps, mixed.id, undefined, "go")).rejects.toThrow('repo is required: pipeline "Mixed" has steps with file/bash access: "Write code" (writer)');
  const withInput = runPipelineNow(deps, mixed.id, "/tmp/r", undefined, { requireInput: true });
  await expect(withInput).rejects.toBeInstanceOf(PipelineRepoRequiredError);
  await expect(withInput).rejects.toThrow('repo and input are required: this pipeline has steps with file/bash access: "Write code" (writer)');
  expect(await board.list()).toEqual([]);

  let created: TaskCard | undefined;
  const root = await runPipelineNow(deps, read.id, undefined, "hi", { scheduleId: "sched-1", onRootCreated: (r) => (created = r) });
  expect(created!.id).toBe(root.id);
  expect(root).toMatchObject({ status: "done", scheduleId: "sched-1", body: "hi" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.scheduleId).toBeUndefined();
});
