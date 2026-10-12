import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { DEFAULT_CATCH_UP_HOURS, ScheduleValidationError, SqliteScheduleStore, type ScheduleEvent, type ScheduleStoreOptions } from "../src/services/schedules.ts";
import { taskTemplateValidator, validateNewTask } from "../src/services/task-input.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";

// SqliteScheduleStore, docs/SDD-schedules.md §3.2.

// 12:00 in Madrid (CEST), so `0 6 * * *` next fires tomorrow 04:00Z.
const NOW = new Date("2026-10-12T10:00:00.000Z");
const TOMORROW_0600_MADRID = "2026-10-13T04:00:00.000Z";

function setup(opts: ScheduleStoreOptions = {}) {
  const board = new SqliteBoard();
  let now = NOW;
  const schedules = new SqliteScheduleStore(board.db, { now: () => now, ...opts });
  return { board, schedules, setNow: (d: Date) => (now = d) };
}

const pipelineInput = { name: "AI news podcast", kind: "pipeline" as const, pipelineId: "p1", input: "today", repo: "/r", cron: "0 6 * * *", timezone: "Europe/Madrid" };
const taskInput = {
  name: "Weekly retro",
  kind: "task" as const,
  taskTemplate: { title: "Retro", body: "Write the retro", labels: ["research"] },
  cron: "30 7 * * 1-5",
  timezone: "Europe/Madrid",
};

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a rejection");
}

// ---------- round trip ----------

test("a pipeline schedule round trips with defaults and a computed nextRunAt", async () => {
  const { schedules } = setup();
  const created = await schedules.create(pipelineInput);
  expect(created).toMatchObject({
    name: "AI news podcast",
    kind: "pipeline",
    pipelineId: "p1",
    input: "today",
    repo: "/r",
    cron: "0 6 * * *",
    timezone: "Europe/Madrid",
    enabled: true,
    catchUpHours: DEFAULT_CATCH_UP_HOURS,
    nextRunAt: TOMORROW_0600_MADRID,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  expect(DEFAULT_CATCH_UP_HOURS).toBe(12);
  expect(created.taskTemplate).toBeUndefined();
  expect(created.lastRunAt).toBeUndefined();
  expect(await schedules.get(created.id)).toEqual(created);
  expect(await schedules.getByName("AI news podcast")).toEqual(created);
  expect(await schedules.list()).toEqual([created]);
});

test("a task schedule round trips its template, and a disabled one has no nextRunAt", async () => {
  const { schedules } = setup();
  const created = await schedules.create({ ...taskInput, enabled: false, catchUpHours: 0, repo: "/repo" });
  expect(created.taskTemplate).toEqual({ title: "Retro", body: "Write the retro", labels: ["research"] });
  expect(created.enabled).toBe(false);
  expect(created.catchUpHours).toBe(0);
  expect(created.nextRunAt).toBeUndefined();
  expect(created.pipelineId).toBeUndefined();
  expect(await schedules.get(created.id)).toEqual(created);
});

test("get and getByName return undefined for unknown ones; list keeps creation order", async () => {
  const { schedules } = setup();
  expect(await schedules.get("nope")).toBeUndefined();
  expect(await schedules.getByName("nope")).toBeUndefined();
  const a = await schedules.create(pipelineInput);
  const b = await schedules.create(taskInput);
  expect((await schedules.list()).map((s) => s.id)).toEqual([a.id, b.id]);
});

// ---------- update ----------

test("update recomputes nextRunAt from now when the cron changes", async () => {
  const { schedules, setNow } = setup();
  const created = await schedules.create(pipelineInput);
  setNow(new Date("2026-10-13T05:00:00.000Z")); // 07:00 Madrid, past today's 06:00
  const moved = await schedules.update(created.id, { cron: "0 8 * * *" });
  expect(moved.nextRunAt).toBe("2026-10-13T06:00:00.000Z"); // today 08:00 Madrid
  expect(moved.updatedAt).toBe("2026-10-13T05:00:00.000Z");
  expect(await schedules.get(created.id)).toEqual(moved);
});

test("update recomputes nextRunAt when the timezone changes", async () => {
  const { schedules } = setup();
  const created = await schedules.create(pipelineInput);
  const moved = await schedules.update(created.id, { timezone: "UTC" });
  expect(moved.nextRunAt).toBe("2026-10-13T06:00:00.000Z");
});

test("disabling clears nextRunAt; enabling counts from now", async () => {
  const { schedules, setNow } = setup();
  const created = await schedules.create(pipelineInput);
  const off = await schedules.update(created.id, { enabled: false });
  expect(off.enabled).toBe(false);
  expect(off.nextRunAt).toBeUndefined();
  expect((await schedules.get(created.id))!.nextRunAt).toBeUndefined();

  setNow(new Date("2026-10-20T12:00:00.000Z"));
  const on = await schedules.update(created.id, { enabled: true });
  expect(on.nextRunAt).toBe("2026-10-21T04:00:00.000Z");
});

test("an update that leaves cron, timezone and enabled alone keeps a pending nextRunAt", async () => {
  const { schedules, setNow } = setup();
  const created = await schedules.create(pipelineInput);
  setNow(new Date("2026-10-13T04:00:10.000Z")); // overdue by 10 s, not yet ticked
  const renamed = await schedules.update(created.id, { name: "AI news, 06:00", input: null, repo: "/other", catchUpHours: 2, cron: "0 6 * * *", enabled: true });
  expect(renamed.nextRunAt).toBe(TOMORROW_0600_MADRID);
  expect(renamed.name).toBe("AI news, 06:00");
  expect(renamed.input).toBeUndefined();
  expect(renamed.repo).toBe("/other");
  expect(renamed.catchUpHours).toBe(2);
  expect(await schedules.get(created.id)).toEqual(renamed);
});

test("update and delete throw on an unknown id; delete removes it", async () => {
  const { schedules } = setup();
  await expect(schedules.update("nope", { name: "x" })).rejects.toThrow("schedule not found: nope");
  await expect(schedules.delete("nope")).rejects.toThrow("schedule not found: nope");
  const created = await schedules.create(pipelineInput);
  await schedules.delete(created.id);
  expect(await schedules.get(created.id)).toBeUndefined();
});

// ---------- recordRun ----------

test("recordRun writes the run in one go, clears lastError, and keeps lastRunId when none is given", async () => {
  const { schedules } = setup();
  const created = await schedules.create(pipelineInput);
  const failed = await schedules.recordRun(created.id, {
    nextRunAt: "2026-10-14T04:00:00.000Z",
    lastRunAt: TOMORROW_0600_MADRID,
    lastOutcome: "error",
    lastError: "repo is required",
  });
  expect(failed).toMatchObject({ nextRunAt: "2026-10-14T04:00:00.000Z", lastRunAt: TOMORROW_0600_MADRID, lastOutcome: "error", lastError: "repo is required" });
  expect(failed.lastRunId).toBeUndefined();
  expect(failed.updatedAt).toBe(created.updatedAt);

  const started = await schedules.recordRun(created.id, { nextRunAt: "2026-10-15T04:00:00.000Z", lastRunAt: "2026-10-14T04:00:05.000Z", lastOutcome: "started", lastRunId: "root-1" });
  expect(started.lastError).toBeUndefined();
  expect(started.lastRunId).toBe("root-1");

  const skipped = await schedules.recordRun(created.id, { nextRunAt: "2026-10-16T04:00:00.000Z", lastRunAt: "2026-10-15T04:00:05.000Z", lastOutcome: "skipped-overlap" });
  expect(skipped.lastOutcome).toBe("skipped-overlap");
  expect(skipped.lastRunId).toBe("root-1");
  expect(await schedules.get(created.id)).toEqual(skipped);
});

test("recordRun refuses an unknown id and an unknown outcome", async () => {
  const { schedules } = setup();
  await expect(schedules.recordRun("nope", { nextRunAt: null, lastRunAt: NOW.toISOString(), lastOutcome: "started" })).rejects.toThrow("schedule not found: nope");
  const created = await schedules.create(pipelineInput);
  const bad = await rejection(schedules.recordRun(created.id, { nextRunAt: null, lastRunAt: NOW.toISOString(), lastOutcome: "maybe" as never }));
  expect(bad).toBeInstanceOf(ScheduleValidationError);
});

// ---------- disableForPipeline ----------

test("disableForPipeline disables only that pipeline's schedules, with the error", async () => {
  const { schedules } = setup();
  const a = await schedules.create(pipelineInput);
  const b = await schedules.create({ ...pipelineInput, name: "World news podcast" });
  const other = await schedules.create({ ...pipelineInput, name: "Other", pipelineId: "p2" });
  const task = await schedules.create(taskInput);

  const touched = await schedules.disableForPipeline("p1", "pipeline deleted");
  expect(touched.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  for (const s of touched) {
    expect(s).toMatchObject({ enabled: false, lastError: "pipeline deleted" });
    expect(s.nextRunAt).toBeUndefined();
    expect(await schedules.get(s.id)).toEqual(s);
  }
  expect((await schedules.get(other.id))!).toMatchObject({ enabled: true, nextRunAt: TOMORROW_0600_MADRID });
  expect((await schedules.get(task.id))!.enabled).toBe(true);
  expect(await schedules.disableForPipeline("none", "pipeline deleted")).toEqual([]);
});

// ---------- onChange ----------

test("onChange sees create, update, ran and delete, and unsubscribes", async () => {
  const { schedules } = setup();
  const seen: ScheduleEvent["type"][] = [];
  const off = schedules.onChange((e) => seen.push(e.type));
  const s = await schedules.create(pipelineInput);
  await schedules.update(s.id, { name: "renamed" });
  await schedules.recordRun(s.id, { nextRunAt: null, lastRunAt: NOW.toISOString(), lastOutcome: "skipped-stale" });
  await schedules.disableForPipeline("p1", "pipeline deleted");
  await schedules.delete(s.id);
  off();
  await schedules.create(pipelineInput);
  expect(seen).toEqual(["schedule.created", "schedule.updated", "schedule.ran", "schedule.updated", "schedule.deleted"]);
});

// ---------- validation ----------

async function refusal(p: Promise<unknown>): Promise<string> {
  const err = await rejection(p);
  expect(err).toBeInstanceOf(ScheduleValidationError);
  return err.message;
}

test("create refuses bad kind, missing fields, wrong-kind fields, bad cron and timezone, too-frequent cron", async () => {
  const { schedules } = setup();
  expect(await refusal(schedules.create({ ...pipelineInput, kind: "job" as never }))).toBe('kind must be "pipeline" or "task"');
  expect(await refusal(schedules.create({ ...pipelineInput, name: " " }))).toBe("name is required");
  expect(await refusal(schedules.create({ ...pipelineInput, pipelineId: undefined }))).toBe("a pipeline schedule needs a pipelineId");
  expect(await refusal(schedules.create({ ...pipelineInput, taskTemplate: taskInput.taskTemplate }))).toBe("a pipeline schedule has no taskTemplate");
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: undefined }))).toBe("a task schedule needs a taskTemplate");
  expect(await refusal(schedules.create({ ...taskInput, pipelineId: "p1" }))).toBe("a task schedule has no pipelineId");
  expect(await refusal(schedules.create({ ...pipelineInput, cron: "0 0 6 * * *" }))).toContain("exactly 5 fields");
  expect(await refusal(schedules.create({ ...pipelineInput, timezone: "Nowhere" }))).toContain('unknown timezone "Nowhere"');
  expect(await refusal(schedules.create({ ...pipelineInput, cron: "* * * * *" }))).toContain("at least 5 minutes apart");
  expect(await refusal(schedules.create({ ...pipelineInput, catchUpHours: -1 }))).toContain("catchUpHours");
  expect(await refusal(schedules.create({ ...pipelineInput, enabled: "yes" as never }))).toBe("enabled must be true or false");
  expect(await schedules.list()).toEqual([]);
});

test("names are unique, on create and on rename", async () => {
  const { schedules } = setup();
  const a = await schedules.create(pipelineInput);
  const b = await schedules.create({ ...pipelineInput, name: "B" });
  expect(await refusal(schedules.create(pipelineInput))).toBe('a schedule named "AI news podcast" already exists');
  expect(await refusal(schedules.update(b.id, { name: a.name }))).toBe('a schedule named "AI news podcast" already exists');
  expect((await schedules.update(a.id, { name: a.name })).name).toBe(a.name);
});

test("a refused update changes nothing", async () => {
  const { schedules } = setup();
  const created = await schedules.create(pipelineInput);
  expect(await refusal(schedules.update(created.id, { cron: "*/2 * * * *" }))).toContain("at least 5 minutes apart");
  expect(await schedules.get(created.id)).toEqual(created);
});

test("taskTemplate shape: title, body, labels required; unknown fields refused; empty optionals dropped", async () => {
  const { schedules } = setup();
  const t = taskInput.taskTemplate;
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, title: "" } }))).toBe("taskTemplate.title is required");
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, body: undefined as never } }))).toBe("taskTemplate.body must be a string");
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, labels: [1] as never } }))).toBe("taskTemplate.labels must be a list of strings");
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, notBefore: "2026-10-13T00:00:00Z" } as never }))).toBe('taskTemplate has an unknown field "notBefore"');
  expect(await refusal(schedules.create({ ...taskInput, taskTemplate: "do it" as never }))).toContain("taskTemplate must be an object");
  expect(await refusal(schedules.create({ ...taskInput, input: "x" }))).toContain("a task schedule has no input");
  const ok = await schedules.create({ ...taskInput, taskTemplate: { ...t, repo: "", model: "" } });
  expect(ok.taskTemplate).toEqual(t);
});

test("pipelineExists refuses a pipeline that isn't stored", async () => {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const p = await pipelines.create({ name: "News", description: "", graph: { steps: [], edges: [] } });
  const schedules = new SqliteScheduleStore(board.db, { now: () => NOW, pipelineExists: async (id) => (await pipelines.get(id)) !== undefined });
  expect((await schedules.create({ ...pipelineInput, pipelineId: p.id })).pipelineId).toBe(p.id);
  expect(await refusal(schedules.create({ ...pipelineInput, name: "x", pipelineId: "gone" }))).toBe("pipeline not found: gone");
});

// ---------- taskTemplate: the same rules as POST /tasks ----------

test("taskTemplate is refused by the POST /tasks rules: unknown harness, unknown model, repo required", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-schedules-template-"));
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(modelsCachePath, JSON.stringify({ a: { models: ["claude-opus-5"], fetchedAt: NOW.toISOString() } }));
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const deps = { board, registry, router: new Router(registry), harnesses: HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]), modelsCachePath };
    const schedules = new SqliteScheduleStore(board.db, { now: () => NOW, validateTaskTemplate: taskTemplateValidator(deps) });
    const t = taskInput.taskTemplate;

    expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, harnessOverride: "nope" } }))).toBe('taskTemplate: unknown harnessOverride "nope"');
    expect(await refusal(schedules.create({ ...taskInput, taskTemplate: { ...t, harnessOverride: "a", model: "fake" } }))).toBe(
      'taskTemplate: model "fake" is not in the known model list for harness "a"',
    );
    const noRepo = await refusal(schedules.create({ ...taskInput, taskTemplate: { title: "fix the bug", body: "", labels: ["code", "typescript"] } }));
    expect(noRepo).toStartWith("taskTemplate: repo is required");
    expect(noRepo).toContain("implementer");

    // The same template passes with a repo, on the template or the schedule.
    const coding = { title: "fix the bug", body: "", labels: ["code", "typescript"] };
    expect((await schedules.create({ ...taskInput, name: "c1", taskTemplate: { ...coding, repo: "/r" } })).taskTemplate!.repo).toBe("/r");
    expect((await schedules.create({ ...taskInput, name: "c2", repo: "/r", taskTemplate: coding })).repo).toBe("/r");
    expect((await schedules.create({ ...taskInput, name: "c3", taskTemplate: { ...t, repo: "/r", harnessOverride: "a", model: "claude-opus-5" } })).taskTemplate!.model).toBe("claude-opus-5");

    // And POST /tasks's own function says the same words for the same body.
    const direct = await validateNewTask({ ...t, harnessOverride: "nope" }, { ...deps, now: NOW });
    expect(direct).toEqual({ ok: false, error: 'unknown harnessOverride "nope"' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- TaskCard.scheduleId ----------

test("board round trips scheduleId", async () => {
  const board = new SqliteBoard();
  const card = await board.create({ title: "t", body: "", labels: [], repo: "r", scheduleId: "s1" });
  expect(card.scheduleId).toBe("s1");
  expect((await board.get(card.id))!.scheduleId).toBe("s1");
  const plain = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect((await board.get(plain.id))!.scheduleId).toBeUndefined();
});

test("opens and heals a real pre-existing on-disk DB from before scheduleId existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        routedTo TEXT,
        dependsOn TEXT NOT NULL DEFAULT '[]'
      );
    `);
    legacy.run("INSERT INTO tasks (id, title, body, labels, repo, status) VALUES ('old', 'old card', '', '[]', 'r', 'inbox')");
    legacy.close();

    const board = new SqliteBoard(dbPath);
    expect((await board.get("old"))!.scheduleId).toBeUndefined();
    const card = await board.create({ title: "t", body: "", labels: [], repo: "r", scheduleId: "s1" });
    expect((await board.get(card.id))!.scheduleId).toBe("s1");

    // The schedules table lives in the same file and survives a reopen.
    const schedules = new SqliteScheduleStore(board.db, { now: () => NOW });
    const s = await schedules.create(pipelineInput);
    board.db.close();
    const reopened = new SqliteScheduleStore(new SqliteBoard(dbPath).db, { now: () => NOW });
    expect(await reopened.get(s.id)).toEqual(s);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
