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
 * Which checks apply follows from the pipeline's steps, not its name:
 * a `world-news-gatherer` step means checkWorldNewsRun, `ai-news-gatherer`
 * means checkAiNewsRun, `wissel-digest` means checkRetroRun; plus
 * checkAudio when there is an audio step. Dates are judged against the
 * run's first telemetry event, so an old run isn't failed for being old
 * today. Reads a snapshot of the board, never the live file.
 *
 * Exits 1 when any checked run fails a check, 2 on bad usage.
 * WISSEL_DB_PATH, WISSEL_TELEMETRY_PATH, WISSEL_AUDIO_DIR as for the server.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAiNewsRun,
  checkAudio,
  checkRetroRun,
  checkWorldNewsRun,
  countWords,
  type AiNewsCheck,
} from "../eval/ai-news-checks.ts";
import type { TaskCard } from "../src/core/types.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { audioFilePath, defaultAudioDir } from "../src/executors/tts.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";

export type NewsRunKind = "ai" | "world" | "retro";

const GATHER_KIND: Record<string, NewsRunKind> = {
  "ai-news-gatherer": "ai",
  "world-news-gatherer": "world",
  "wissel-digest": "retro",
};
const EXPLAIN_AGENTS = new Set(["ai-news-explainer", "world-news-explainer", "wissel-retro-analyst"]);
const SCRIPT_AGENT = "podcast-scriptwriter";
const AUDIO_AGENT = "podcast-audio";

export interface NewsRunReport {
  runId: string;
  pipelineName: string;
  kind: NewsRunKind;
  /** First telemetry event of the run; undefined when it has none. */
  startedAt: string | undefined;
  checks: AiNewsCheck[];
  pass: boolean;
}

export interface RunTelemetry {
  /** Sum of actualCost over `result` events; undefined when none had one. */
  costUsd: number | undefined;
  /** The earliest event's `at`; undefined when there were no events. */
  firstAt: string | undefined;
}

/** Cost and first event time for these task ids from telemetry.jsonl.
 *  Tasks carry no creation time, so the first event dates the run. */
export async function runTelemetry(path: string, taskIds: Set<string>): Promise<RunTelemetry> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { costUsd: undefined, firstAt: undefined };
  }
  let costUsd: number | undefined;
  let firstAt: string | undefined;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; taskId?: string; actualCost?: number; at?: string };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (!e.taskId || !taskIds.has(e.taskId)) continue;
    if (typeof e.at === "string" && (firstAt === undefined || e.at < firstAt)) firstAt = e.at;
    if (e.type === "result" && typeof e.actualCost === "number") costUsd = (costUsd ?? 0) + e.actualCost;
  }
  return { costUsd, firstAt };
}

/** Sums actualCost over telemetry `result` events for these task ids;
 *  undefined when none reported one (or there is no telemetry file). */
export async function costFromTelemetry(path: string, taskIds: Set<string>): Promise<number | undefined> {
  return (await runTelemetry(path, taskIds)).costUsd;
}

/** A read-only snapshot of a board: the file and its WAL copied into
 *  `dir` and opened there, so nothing (not even the schema healing
 *  SqliteBoard runs on open) touches the live database. */
export async function snapshotBoard(realPath: string, dir: string): Promise<SqliteBoard> {
  const copy = join(dir, "board.sqlite");
  await copyFile(realPath, copy);
  if (existsSync(`${realPath}-wal`)) await copyFile(`${realPath}-wal`, `${copy}-wal`);
  return new SqliteBoard(copy);
}

export interface CheckDeps {
  board: SqliteBoard;
  pipelines: SqlitePipelineStore;
  telemetryPath: string;
  audioDir: string;
}

/** The checks for one stored run, or a string saying why it can't be
 *  checked (unknown run, not a podcast pipeline, definition deleted). */
export async function checkStoredRun(deps: CheckDeps, runId: string): Promise<NewsRunReport | string> {
  const root = await deps.board.get(runId);
  if (!root || !root.pipelineId || root.pipelineRunId) return `${runId} is not a pipeline run on this board`;
  const def = await deps.pipelines.get(root.pipelineId);
  if (!def) return `run ${runId}: its pipeline ${root.pipelineId} no longer exists`;
  const kind = def.graph.steps.map((s) => GATHER_KIND[s.agentId]).find((k) => k !== undefined);
  if (!kind) return `run ${runId}: "${def.name}" is not a podcast pipeline`;

  const steps = (await deps.board.list()).filter((t) => t.pipelineRunId === root.id);
  // A retried step has several cards; the latest one is what the run used.
  const latestFor = (match: (agentId: string) => boolean): TaskCard | undefined => {
    const ids = new Set(def.graph.steps.filter((s) => match(s.agentId)).map((s) => s.id));
    // board.list() is in insertion order, so the last match is the newest.
    return steps.filter((t) => t.pipelineStepId && ids.has(t.pipelineStepId)).at(-1);
  };
  const dataOf = async (card: TaskCard | undefined): Promise<Record<string, unknown> | undefined> => {
    if (!card) return undefined;
    const result = await deps.board.getResult(card.id);
    return result ? parsePipelineHandoff(result.summary)?.data : undefined;
  };
  const gather = await dataOf(latestFor((a) => GATHER_KIND[a] !== undefined));
  const explain = await dataOf(latestFor((a) => EXPLAIN_AGENTS.has(a)));
  const final = await dataOf(latestFor((a) => a === SCRIPT_AGENT));
  const audioCard = latestFor((a) => a === AUDIO_AGENT);
  const { costUsd, firstAt } = await runTelemetry(deps.telemetryPath, new Set([root.id, ...steps.map((t) => t.id)]));
  const now = firstAt ? new Date(firstAt) : new Date();

  const checks: AiNewsCheck[] = [
    {
      name: "run-status",
      pass: root.status === "done",
      detail: `run ${root.status}; steps: ${steps.map((t) => `${t.pipelineStepId}=${t.status}`).join(", ")}`,
    },
    ...(kind === "retro"
      ? checkRetroRun({ gather, analysis: explain, final, costUsd })
      : (kind === "world" ? checkWorldNewsRun : checkAiNewsRun)({ gather, explain, final, costUsd, now })),
  ];
  if (audioCard) {
    const file = await readFile(audioFilePath(deps.audioDir, root.id)).catch(() => null);
    const script = final && typeof final.script === "string" ? final.script : "";
    checks.push(checkAudio({ audio: await dataOf(audioCard), file: file ? new Uint8Array(file) : null, words: countWords(script) }));
  }
  return { runId: root.id, pipelineName: def.name, kind, startedAt: firstAt, checks, pass: checks.every((c) => c.pass) };
}

/** Run ids to check for a CLI argument: a run id as given, a pipeline
 *  name's latest run, or (no argument) the latest run of every podcast
 *  pipeline. A string is a usage error. */
export async function resolveRunIds(deps: CheckDeps, arg: string | undefined): Promise<string[] | string> {
  const all = await deps.pipelines.list();
  const roots = (await deps.board.list()).filter((t) => t.pipelineId && !t.pipelineRunId);
  const latestRunOf = (pipelineId: string) => roots.filter((t) => t.pipelineId === pipelineId).at(-1)?.id;

  if (arg && (await deps.board.get(arg))) return [arg];
  const pipelines = arg
    ? all.filter((p) => p.name === arg)
    : all.filter((p) => p.graph.steps.some((s) => GATHER_KIND[s.agentId] !== undefined));
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
