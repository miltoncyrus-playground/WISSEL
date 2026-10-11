#!/usr/bin/env bun
/**
 * Applies the eval checks (eval/ai-news-checks.ts) to a run that already
 * happened on the live board: a 06:00 timer run, or one started from the
 * drawer. Free: no claude, no web, read-only on the board. The paid
 * evals (`bun run eval:ai-news` etc.) start fresh runs on a throwaway
 * board; this checks the run you actually got.
 *
 *   bun run check:news-run                       # latest run of each podcast pipeline
 *   bun run check:news-run "World news podcast"  # latest run of that pipeline
 *   bun run check:news-run <runId>               # that run
 *
 * The checks themselves (checkStoredRun) live in
 * src/services/news-run-checks.ts, where the server's feed calls them
 * too (docs/SDD-wissel-app.md §3.2). This script is the CLI: it picks
 * the runs, reads a snapshot of the board (never the live file) and
 * prints the report.
 *
 * Exits 1 when any checked run fails a check, 2 on bad usage.
 * WISSEL_DB_PATH, WISSEL_TELEMETRY_PATH, WISSEL_AUDIO_DIR as for the server.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAudioDir } from "../src/executors/tts.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { checkStoredRun, newsRunKind, type CheckDeps } from "../src/services/news-run-checks.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";

// Re-exported so the evals and tests that import them from here keep working.
export {
  checkStoredRun,
  costFromTelemetry,
  runTelemetry,
  type CheckDeps,
  type NewsRunKind,
  type NewsRunReport,
  type RunTelemetry,
} from "../src/services/news-run-checks.ts";

/** A read-only snapshot of a board: the file and its WAL copied into
 *  `dir` and opened there, so nothing (not even the schema healing
 *  SqliteBoard runs on open) touches the live database. */
export async function snapshotBoard(realPath: string, dir: string): Promise<SqliteBoard> {
  const copy = join(dir, "board.sqlite");
  await copyFile(realPath, copy);
  if (existsSync(`${realPath}-wal`)) await copyFile(`${realPath}-wal`, `${copy}-wal`);
  return new SqliteBoard(copy);
}

/** Run ids to check for a CLI argument: a run id as given, a pipeline
 *  name's latest run, or (no argument) the latest run of every podcast
 *  pipeline. A string is a usage error. */
export async function resolveRunIds(deps: CheckDeps, arg: string | undefined): Promise<string[] | string> {
  const all = await deps.pipelines.list();
  const roots = (await deps.board.list()).filter((t) => t.pipelineId && !t.pipelineRunId);
  const latestRunOf = (pipelineId: string) => roots.filter((t) => t.pipelineId === pipelineId).at(-1)?.id;

  if (arg && (await deps.board.get(arg))) return [arg];
  const pipelines = arg ? all.filter((p) => p.name === arg) : all.filter((p) => newsRunKind(p) !== undefined);
  if (arg && pipelines.length === 0) return `no run id or pipeline named "${arg}"`;
  const ids = pipelines.map((p) => latestRunOf(p.id)).filter((id): id is string => id !== undefined);
  return ids.length > 0 ? ids : arg ? `"${arg}" has no runs yet` : "no podcast pipeline has run yet";
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const snapDir = await mkdtemp(join(tmpdir(), "wissel-check-news-run-"));
  const board = await snapshotBoard(dbPath, snapDir);
  const deps: CheckDeps = {
    board,
    pipelines: new SqlitePipelineStore(board.db),
    telemetryPath: process.env.WISSEL_TELEMETRY_PATH ?? join(homedir(), ".wissel", "telemetry.jsonl"),
    audioDir: process.env.WISSEL_AUDIO_DIR || defaultAudioDir(),
  };
  const ids = await resolveRunIds(deps, process.argv[2]);
  if (typeof ids === "string") {
    console.error(`check-news-run: ${ids}`);
    process.exit(2);
  }
  let allPass = true;
  for (const id of ids) {
    const report = await checkStoredRun(deps, id);
    if (typeof report === "string") {
      console.error(`check-news-run: ${report}`);
      allPass = false;
      continue;
    }
    console.log(`${report.pass ? "PASS" : "FAIL"}  "${report.pipelineName}" run ${report.runId} (${report.startedAt ?? "no telemetry"})`);
    for (const c of report.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
    allPass &&= report.pass;
  }
  board.db.close();
  await rm(snapDir, { recursive: true, force: true });
  process.exit(allPass ? 0 : 1);
}
