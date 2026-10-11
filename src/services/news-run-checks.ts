import { readFile } from "node:fs/promises";
import {
  checkAiNewsRun,
  checkAudio,
  checkRetroRun,
  checkWorldNewsRun,
  countWords,
  mp3Info,
  type AiNewsCheck,
} from "../../eval/ai-news-checks.ts";
import type { PipelineDef, TaskCard } from "../core/types.ts";
import { parsePipelineHandoff } from "../executors/parse-pipeline-handoff.ts";
import { audioFilePath } from "../executors/tts.ts";
import type { Board } from "./board.ts";
import type { PipelineStore } from "./pipelines.ts";

/**
 * The eval checks (eval/ai-news-checks.ts) applied to a podcast run
 * that already happened on a board. Moved here from
 * scripts/check-news-run.ts so the server can call it for the feed's
 * `checks` items (docs/SDD-wissel-app.md §3.2); the script imports it
 * from here and keeps its CLI.
 *
 * Which checks apply follows from the pipeline's steps, not its name:
 * a `world-news-gatherer` step means checkWorldNewsRun, `ai-news-gatherer`
 * means checkAiNewsRun, `wissel-digest` means checkRetroRun; plus
 * checkAudio when there is an audio step. Dates are judged against the
 * run's first telemetry event, so an old run isn't failed for being old
 * today. Read-only.
 */

export type NewsRunKind = "ai" | "world" | "retro";

const GATHER_KIND: Record<string, NewsRunKind> = {
  "ai-news-gatherer": "ai",
  "world-news-gatherer": "world",
  "wissel-digest": "retro",
};
const EXPLAIN_AGENTS = new Set(["ai-news-explainer", "world-news-explainer", "wissel-retro-analyst"]);
const SCRIPT_AGENT = "podcast-scriptwriter";
export const AUDIO_AGENT = "podcast-audio";

/** The podcast kind a pipeline's steps make it, or undefined when it
 *  has no gather step the checks know. */
export function newsRunKind(def: Pick<PipelineDef, "graph">): NewsRunKind | undefined {
  return def.graph.steps.map((s) => GATHER_KIND[s.agentId]).find((k) => k !== undefined);
}

/** True when a pipeline has a "Make audio" step: a podcast (SDD-wissel-app §3.3). */
export function isPodcastPipeline(def: Pick<PipelineDef, "graph">): boolean {
  return def.graph.steps.some((s) => s.agentId === AUDIO_AGENT);
}

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

/** One telemetry.jsonl line, as far as these checks read it. */
export interface TelemetryLine {
  type?: string;
  taskId?: string;
  actualCost?: number;
  harnessId?: string;
  at?: string;
}

/** telemetry.jsonl parsed, skipping blank and malformed lines; [] when
 *  the file is missing. */
export async function readTelemetryLines(path: string): Promise<TelemetryLine[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: TelemetryLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as unknown;
      if (e && typeof e === "object" && !Array.isArray(e)) out.push(e as TelemetryLine);
    } catch {
      // malformed: skip
    }
  }
  return out;
}

/** Cost and first event time for these task ids from parsed telemetry. */
export function runTelemetryFrom(lines: readonly TelemetryLine[], taskIds: Set<string>): RunTelemetry {
  let costUsd: number | undefined;
  let firstAt: string | undefined;
  for (const e of lines) {
    if (!e.taskId || !taskIds.has(e.taskId)) continue;
    if (typeof e.at === "string" && (firstAt === undefined || e.at < firstAt)) firstAt = e.at;
    if (e.type === "result" && typeof e.actualCost === "number") costUsd = (costUsd ?? 0) + e.actualCost;
  }
  return { costUsd, firstAt };
}

/** Cost and first event time for these task ids from telemetry.jsonl.
 *  Tasks carry no creation time, so the first event dates the run. */
export async function runTelemetry(path: string, taskIds: Set<string>): Promise<RunTelemetry> {
  const lines = await readTelemetryLines(path);
  if (lines.length === 0) return { costUsd: undefined, firstAt: undefined };
  return runTelemetryFrom(lines, taskIds);
}

/** Sums actualCost over telemetry `result` events for these task ids;
 *  undefined when none reported one (or there is no telemetry file). */
export async function costFromTelemetry(path: string, taskIds: Set<string>): Promise<number | undefined> {
  return (await runTelemetry(path, taskIds)).costUsd;
}

export interface CheckDeps {
  board: Board;
  pipelines: PipelineStore;
  telemetryPath: string;
  audioDir: string;
  /** Already-parsed telemetry: when given, used instead of reading
   *  telemetryPath (the feed checks many runs per request). */
  telemetry?: readonly TelemetryLine[];
  /** board.list() already in hand: when given, used instead of listing again. */
  tasks?: readonly TaskCard[];
}

/** A stored run's step cards and handoff data, found by agent. */
export interface StoredRun {
  root: TaskCard;
  def: PipelineDef;
  steps: TaskCard[];
  gather?: Record<string, unknown>;
  explain?: Record<string, unknown>;
  final?: Record<string, unknown>;
  audioCard?: TaskCard;
}

/** The run's root, definition, step cards and each step's latest
 *  handoff data, or a string saying why it isn't a pipeline run. */
export async function loadStoredRun(deps: CheckDeps, runId: string): Promise<StoredRun | string> {
  const root = await deps.board.get(runId);
  if (!root || !root.pipelineId || root.pipelineRunId) return `${runId} is not a pipeline run on this board`;
  const def = await deps.pipelines.get(root.pipelineId);
  if (!def) return `run ${runId}: its pipeline ${root.pipelineId} no longer exists`;

  const steps = (deps.tasks ?? (await deps.board.list())).filter((t) => t.pipelineRunId === root.id);
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
  return {
    root,
    def,
    steps,
    gather: await dataOf(latestFor((a) => GATHER_KIND[a] !== undefined)),
    explain: await dataOf(latestFor((a) => EXPLAIN_AGENTS.has(a))),
    final: await dataOf(latestFor((a) => a === SCRIPT_AGENT)),
    audioCard: latestFor((a) => a === AUDIO_AGENT),
  };
}

/** The checks for one stored run, or a string saying why it can't be
 *  checked (unknown run, not a podcast pipeline, definition deleted). */
export async function checkStoredRun(deps: CheckDeps, runId: string): Promise<NewsRunReport | string> {
  const run = await loadStoredRun(deps, runId);
  if (typeof run === "string") return run;
  const { root, def, steps, gather, explain, final, audioCard } = run;
  const kind = newsRunKind(def);
  if (!kind) return `run ${runId}: "${def.name}" is not a podcast pipeline`;

  const ids = new Set([root.id, ...steps.map((t) => t.id)]);
  const { costUsd, firstAt } = deps.telemetry ? runTelemetryFrom(deps.telemetry, ids) : await runTelemetry(deps.telemetryPath, ids);
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
    const audioResult = await deps.board.getResult(audioCard.id);
    const audio = audioResult ? parsePipelineHandoff(audioResult.summary)?.data : undefined;
    checks.push(checkAudio({ audio, file: file ? new Uint8Array(file) : null, words: countWords(script) }));
  }
  return { runId: root.id, pipelineName: def.name, kind, startedAt: firstAt, checks, pass: checks.every((c) => c.pass) };
}

/** The first quick-read headline of a run's script step, trimmed;
 *  undefined when there is none. */
export function firstHeadline(final: Record<string, unknown> | undefined): string | undefined {
  const quickRead = final?.quickRead;
  if (!Array.isArray(quickRead)) return undefined;
  for (const item of quickRead) {
    const h = item && typeof item === "object" ? (item as { headline?: unknown }).headline : undefined;
    if (typeof h === "string" && h.trim()) return h.trim();
  }
  return undefined;
}

/** Seconds of audio in an MP3 (CBR estimate, the same arithmetic as
 *  checkAudio), rounded; undefined when the bytes aren't an MP3. */
export function mp3DurationSeconds(bytes: Uint8Array, totalBytes = bytes.byteLength): number | undefined {
  const info = mp3Info(bytes);
  if (!info || info.kbps <= 0) return undefined;
  return Math.round(((totalBytes - info.offset) * 8) / (info.kbps * 1000));
}
