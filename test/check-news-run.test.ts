import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStoredRun, costFromTelemetry, resolveRunIds, runTelemetry, snapshotBoard, type CheckDeps } from "../scripts/check-news-run.ts";
import { seedAiNewsPipeline, seedWorldNewsPipeline } from "../scripts/seed-ai-news-pipeline.ts";
import { Registry } from "../src/core/registry.ts";
import type { TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";

// `bun run check:news-run`: the eval checks applied to a run already on
// the live board (docs/SDD-ai-news-podcast.md §3.9 follow-up).

const FIXTURES = join(import.meta.dir, "fixtures", "ai-news");
const GATHER = await readFile(join(FIXTURES, "gather-summary.md"), "utf8");
const EXPLAIN = await readFile(join(FIXTURES, "explain-summary.md"), "utf8");
const SCRIPT = await readFile(join(FIXTURES, "script-summary.md"), "utf8");
// The gather fixture's stories are dated 2026-10-02 to 10-05 (generatedAt 10-07).
const RUN_AT = "2026-10-07T04:00:00.000Z";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "wissel-check-news-run-test-"));
  dirs.push(d);
  return d;
}

const registry = await Registry.load();

function card(over: Partial<TaskCard>): Omit<TaskCard, "id" | "status"> {
  return { title: "t", body: "b", labels: [], repo: "", dependsOn: [], ...over };
}

/** A board with one finished AI news run whose explain step was retried
 *  (an old failed card, then the good one), and its telemetry. */
async function aiRun(opts: { telemetry?: string | null } = {}) {
  const dir = await tempDir();
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const { pipeline } = await seedAiNewsPipeline(pipelines, registry);
  const root = await board.create(card({ title: "AI news podcast", pipelineId: pipeline.id }));
  await board.move(root.id, "done");
  const step = async (stepId: string, agentId: string, summary: string, ok = true) => {
    const t = await board.create(card({ pipelineId: pipeline.id, pipelineRunId: root.id, pipelineStepId: stepId, parentTaskId: root.id }));
    await board.move(t.id, ok ? "done" : "failed");
    await board.recordResult({ taskId: t.id, agentId, ok, summary });
    return t;
  };
  const gather = await step("gather", "ai-news-gatherer", GATHER);
  await step("explain", "ai-news-explainer", "no handoff here", false);
  const explain = await step("explain", "ai-news-explainer", EXPLAIN);
  const script = await step("script", "podcast-scriptwriter", SCRIPT);
  const telemetryPath = join(dir, "telemetry.jsonl");
  const lines =
    opts.telemetry !== undefined
      ? opts.telemetry
      : [
          { type: "dispatch", taskId: gather.id, at: "2026-10-07T04:00:05.000Z" },
          { type: "result", taskId: gather.id, actualCost: 0.5, at: "2026-10-07T04:02:00.000Z" },
          { type: "result", taskId: explain.id, actualCost: 0.1, at: "2026-10-07T04:03:00.000Z" },
          { type: "result", taskId: script.id, actualCost: 0.1, at: "2026-10-07T04:04:00.000Z" },
          { type: "result", taskId: "someone-else", actualCost: 9, at: "2026-10-01T00:00:00.000Z" },
          { type: "dispatch", taskId: root.id, at: RUN_AT },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\nnot json\n";
  if (lines !== null) await writeFile(telemetryPath, lines);
  const deps: CheckDeps = { board, pipelines, telemetryPath, audioDir: join(dir, "audio") };
  return { deps, root, pipeline, board, pipelines };
}

test("runTelemetry sums result costs and finds the first event for the run's tasks only", async () => {
  const dir = await tempDir();
  const path = join(dir, "t.jsonl");
  await writeFile(
    path,
    [
      '{"type":"dispatch","taskId":"a","at":"2026-10-07T04:00:10Z"}',
      '{"type":"result","taskId":"a","actualCost":0.25,"at":"2026-10-07T04:01:00Z"}',
      "garbage",
      '{"type":"result","taskId":"b","actualCost":0.5,"at":"2026-10-07T03:59:00Z"}',
      '{"type":"result","taskId":"x","actualCost":5,"at":"2026-01-01T00:00:00Z"}',
    ].join("\n"),
  );
  expect(await runTelemetry(path, new Set(["a", "b"]))).toEqual({ costUsd: 0.75, firstAt: "2026-10-07T03:59:00Z" });
  expect(await costFromTelemetry(path, new Set(["a"]))).toBe(0.25);
  expect(await runTelemetry(path, new Set(["nobody"]))).toEqual({ costUsd: undefined, firstAt: undefined });
  expect(await runTelemetry(join(dir, "missing.jsonl"), new Set(["a"]))).toEqual({ costUsd: undefined, firstAt: undefined });
});

test("an AI news run gets the AI checks, from the latest card of a retried step, cost from telemetry", async () => {
  const { deps, root } = await aiRun();
  const report = await checkStoredRun(deps, root.id);
  if (typeof report === "string") throw new Error(report);
  expect(report.kind).toBe("ai");
  expect(report.pipelineName).toBe("AI news podcast");
  expect(report.startedAt).toBe(RUN_AT);
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  expect(byName["run-status"]!.pass).toBe(true);
  // The retried explain step's latest card is the one with a handoff.
  expect(byName["explain-shape"]!.pass).toBe(true);
  expect(byName["explain-shape"]!.detail).not.toContain("no stories array");
  expect(byName["cost"]!.detail).toContain("$0.7000");
  // No audio step card in this run, so no audio check.
  expect(byName["audio"]).toBeUndefined();
  // checkAiNewsRun's own checks are all present.
  for (const name of ["gather-shape", "final-shape", "sources-from-gather", "dates-recent", "facts-retained", "depth"]) expect(byName[name]).toBeDefined();
});

test("dates are judged at the run's first telemetry event, not today", async () => {
  const { deps, root } = await aiRun();
  const report = await checkStoredRun(deps, root.id);
  if (typeof report === "string") throw new Error(report);
  expect(report.checks.find((c) => c.name === "dates-recent")!.pass).toBe(true);

  // Without telemetry it falls back to now, where the 2026-10-02 fixture
  // story is long out of the 7 day window.
  const bare = await aiRun({ telemetry: null });
  const late = await checkStoredRun(bare.deps, bare.root.id);
  if (typeof late === "string") throw new Error(late);
  expect(late.startedAt).toBeUndefined();
  if (Date.now() > Date.parse("2026-10-10T00:00:00Z")) expect(late.checks.find((c) => c.name === "dates-recent")!.pass).toBe(false);
});

test("an audio step adds the audio check, failing clearly when the MP3 is missing", async () => {
  const { deps, root, pipeline, board } = await aiRun();
  const t = await board.create(card({ pipelineId: pipeline.id, pipelineRunId: root.id, pipelineStepId: "audio", parentTaskId: root.id }));
  await board.recordResult({ taskId: t.id, agentId: "podcast-audio", ok: true, summary: "no block" });
  const report = await checkStoredRun(deps, root.id);
  if (typeof report === "string") throw new Error(report);
  const audio = report.checks.find((c) => c.name === "audio")!;
  expect(audio.pass).toBe(false);
  expect(report.pass).toBe(false);
});

test("a world news run gets the world checks (regions)", async () => {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const { pipeline } = await seedWorldNewsPipeline(pipelines, registry);
  const root = await board.create(card({ pipelineId: pipeline.id }));
  const report = await checkStoredRun({ board, pipelines, telemetryPath: "/nonexistent", audioDir: "/nonexistent" }, root.id);
  if (typeof report === "string") throw new Error(report);
  expect(report.kind).toBe("world");
  expect(report.checks.some((c) => c.name === "regions")).toBe(true);
  expect(report.pass).toBe(false);
});

test("a non-run, a step card, a non-podcast pipeline and a deleted pipeline are reported, not checked", async () => {
  const { deps, root, board, pipelines } = await aiRun();
  expect(await checkStoredRun(deps, "nope")).toBe("nope is not a pipeline run on this board");
  const stepId = (await board.list()).find((t) => t.pipelineRunId === root.id)!.id;
  expect(await checkStoredRun(deps, stepId)).toBe(`${stepId} is not a pipeline run on this board`);

  const other = await pipelines.create({
    name: "Just a review",
    description: "",
    graph: { steps: [{ id: "r", name: "Review", agentId: "pipeline-reviewer", transition: "all" }], edges: [] },
  });
  const otherRun = await board.create(card({ pipelineId: other.id }));
  expect(await checkStoredRun(deps, otherRun.id)).toBe(`run ${otherRun.id}: "Just a review" is not a podcast pipeline`);

  const orphan = await board.create(card({ pipelineId: "gone" }));
  expect(await checkStoredRun(deps, orphan.id)).toBe(`run ${orphan.id}: its pipeline gone no longer exists`);
});

test("resolveRunIds: a run id, a pipeline name's latest run, every podcast pipeline's latest run, and usage errors", async () => {
  const { deps, root, pipeline, board, pipelines } = await aiRun();
  expect(await resolveRunIds(deps, root.id)).toEqual([root.id]);
  const newer = await board.create(card({ pipelineId: pipeline.id }));
  expect(await resolveRunIds(deps, "AI news podcast")).toEqual([newer.id]);
  expect(await resolveRunIds(deps, undefined)).toEqual([newer.id]);

  await seedWorldNewsPipeline(pipelines, registry);
  expect(await resolveRunIds(deps, "World news podcast")).toBe('"World news podcast" has no runs yet');
  // The world pipeline with no runs is skipped, not an error, when checking all.
  expect(await resolveRunIds(deps, undefined)).toEqual([newer.id]);
  expect(await resolveRunIds(deps, "Nope")).toBe('no run id or pipeline named "Nope"');

  const empty = new SqliteBoard();
  expect(await resolveRunIds({ ...deps, board: empty, pipelines: new SqlitePipelineStore(empty.db) }, undefined)).toBe("no podcast pipeline has run yet");
});

test("snapshotBoard reads a copy and never changes the live file", async () => {
  const dir = await tempDir();
  const live = join(dir, "live.sqlite");
  const real = new SqliteBoard(live);
  const t = await real.create(card({ title: "on the live board" }));
  const before = await stat(live);
  const liveBytes = await readFile(live);

  const snapDir = join(dir, "snap");
  await Bun.write(join(snapDir, ".keep"), "");
  const snap = await snapshotBoard(live, snapDir);
  expect((await snap.get(t.id))?.title).toBe("on the live board");
  await snap.create(card({ title: "only in the snapshot" }));
  snap.db.close();

  expect((await stat(live)).mtimeMs).toBe(before.mtimeMs);
  expect(Buffer.compare(await readFile(live), liveBytes)).toBe(0);
  expect((await real.list()).map((c) => c.title)).toEqual(["on the live board"]);
  real.db.close();
});
