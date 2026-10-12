import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PODCAST_CATCH_UP_HOURS,
  PODCAST_CRON,
  PODCAST_SCHEDULE_NAMES,
  PODCAST_TIMEZONE,
  seedPodcastSchedules,
} from "../scripts/seed-schedules.ts";
import type { PipelineGraph } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { SqliteScheduleStore } from "../src/services/schedules.ts";

// scripts/seed-schedules.ts, docs/SDD-schedules.md §7 step 1: the two
// podcast schedules are created disabled, once, and never touched again.

const ROOT = join(import.meta.dir, "..");
const graph: PipelineGraph = { steps: [{ id: "a", name: "Gather", agentId: "news-researcher", transition: "choose" }], edges: [] };

function setup() {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const schedules = new SqliteScheduleStore(board.db, { pipelineExists: async (id) => (await pipelines.get(id)) !== undefined });
  return { board, pipelines, schedules };
}

async function withBothPipelines() {
  const s = setup();
  const ai = await s.pipelines.create({ name: "AI news podcast", description: "", graph });
  const world = await s.pipelines.create({ name: "World news podcast", description: "", graph });
  return { ...s, ai, world };
}

test("creates both podcast schedules disabled, at 06:00 Europe/Madrid, catchUpHours 12, on the right pipelines", async () => {
  const { schedules, pipelines, ai, world } = await withBothPipelines();
  const results = await seedPodcastSchedules(schedules, pipelines);
  expect(results.map((r) => [r.name, r.outcome])).toEqual([
    ["AI news podcast", "created"],
    ["World news podcast", "created"],
  ]);
  const stored = await schedules.list();
  expect(stored).toHaveLength(2);
  for (const [s, p] of [
    [stored[0]!, ai],
    [stored[1]!, world],
  ] as const) {
    expect(s).toMatchObject({
      name: p.name,
      kind: "pipeline",
      pipelineId: p.id,
      cron: "0 6 * * *",
      timezone: "Europe/Madrid",
      catchUpHours: 12,
      enabled: false,
    });
    // Disabled means the ticker has nothing to fire.
    expect(s.nextRunAt).toBeUndefined();
    expect(s.input).toBeUndefined();
    expect(s.repo).toBeUndefined();
  }
});

test("a second run is a no-op: no duplicates, and a schedule a person enabled in between stays enabled", async () => {
  const { schedules, pipelines } = await withBothPipelines();
  await seedPodcastSchedules(schedules, pipelines);
  const ai = (await schedules.getByName("AI news podcast"))!;
  const enabled = await schedules.update(ai.id, { enabled: true, cron: "0 7 * * *" });
  const before = await schedules.list();

  const results = await seedPodcastSchedules(schedules, pipelines);
  expect(results.map((r) => r.outcome)).toEqual(["unchanged", "unchanged"]);
  const after = await schedules.list();
  expect(after).toEqual(before);
  expect(after).toHaveLength(2);
  expect(after.find((s) => s.id === ai.id)).toMatchObject({ enabled: true, cron: "0 7 * * *", nextRunAt: enabled.nextRunAt });
});

test("a second run never enables a disabled schedule", async () => {
  const { schedules, pipelines } = await withBothPipelines();
  await seedPodcastSchedules(schedules, pipelines);
  await seedPodcastSchedules(schedules, pipelines);
  expect((await schedules.list()).map((s) => s.enabled)).toEqual([false, false]);
});

test("a missing pipeline is reported and skipped; the other one is still created", async () => {
  const { schedules, pipelines } = setup();
  const world = await pipelines.create({ name: "World news podcast", description: "", graph });
  const results = await seedPodcastSchedules(schedules, pipelines);
  expect(results.map((r) => [r.name, r.outcome])).toEqual([
    ["AI news podcast", "missing-pipeline"],
    ["World news podcast", "created"],
  ]);
  expect(results[0]).toMatchObject({ matches: 0 });
  expect((await schedules.list()).map((s) => [s.name, s.pipelineId])).toEqual([["World news podcast", world.id]]);

  // Once the pipeline exists, the next run fills the gap and leaves the other alone.
  await pipelines.create({ name: "AI news podcast", description: "", graph });
  expect((await seedPodcastSchedules(schedules, pipelines)).map((r) => r.outcome)).toEqual(["created", "unchanged"]);
  expect(await schedules.list()).toHaveLength(2);
});

test("two pipelines sharing a name are refused like run-pipelines.ts refuses them, not guessed", async () => {
  const { schedules, pipelines } = await withBothPipelines();
  await pipelines.create({ name: "AI news podcast", description: "copy", graph });
  const results = await seedPodcastSchedules(schedules, pipelines);
  expect(results[0]).toMatchObject({ name: "AI news podcast", outcome: "missing-pipeline", matches: 2 });
  expect((await schedules.list()).map((s) => s.name)).toEqual(["World news podcast"]);
});

test("the names, cron and timezone match the systemd units they replace", () => {
  const service = readFileSync(join(ROOT, "ops/systemd/wissel-morning-podcasts.service"), "utf8");
  const timer = readFileSync(join(ROOT, "ops/systemd/wissel-morning-podcasts.timer"), "utf8");
  for (const name of PODCAST_SCHEDULE_NAMES) expect(service).toContain(`"${name}"`);
  expect(timer).toContain("06:00:00 Europe/Madrid");
  expect([PODCAST_CRON, PODCAST_TIMEZONE, PODCAST_CATCH_UP_HOURS]).toEqual(["0 6 * * *", "Europe/Madrid", 12]);
});

test("the CLI on a temp DB: creates, then says nothing to do; a missing pipeline exits non-zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-seed-schedules-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const run = () => {
      const p = Bun.spawnSync(["bun", "run", join(ROOT, "scripts/seed-schedules.ts")], { env: { ...process.env, WISSEL_DB_PATH: dbPath } });
      return { code: p.exitCode, out: p.stdout.toString() };
    };

    const empty = run();
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('No pipeline named "AI news podcast"');
    expect(empty.out).toContain('No pipeline named "World news podcast"');

    const board = new SqliteBoard(dbPath);
    const pipelines = new SqlitePipelineStore(board.db);
    await pipelines.create({ name: "AI news podcast", description: "", graph });
    await pipelines.create({ name: "World news podcast", description: "", graph });
    board.db.close();

    const first = run();
    expect(first.code).toBe(0);
    expect(first.out).toContain('Created schedule "AI news podcast"');
    expect(first.out).toContain('Created schedule "World news podcast"');
    expect(first.out).toContain("disabled");

    const second = run();
    expect(second.code).toBe(0);
    expect(second.out).toContain("left unchanged");
    expect(second.out).toContain("Nothing to do");
    expect(second.out).not.toContain("Created");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
