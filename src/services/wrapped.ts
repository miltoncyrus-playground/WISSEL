import type { PipelineDef, TaskCard } from "../core/types.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Board } from "./board.ts";
import { loadStoredRun, newsRunKind } from "./news-run-checks.ts";
import type { PipelineStore } from "./pipelines.ts";
import { readStreak, type Streak } from "./streaks.ts";
import { buildWisselDigest, parsePeriod, type DigestInputs, type WisselDigest } from "./wissel-digest.ts";

/**
 * `GET /wrapped?period=` (docs/SDD-wissel-app.md §3.6): the numbers on
 * the You tab's Wrapped cards. Every count that the retrospective digest
 * also reports comes from buildWisselDigest itself (no second
 * implementation): cards merged, commits, agent runs, spend and the top
 * agent are `digest.stats` read back. Only what the digest has no notion
 * of is added here: pipelines created in the period (the pipeline
 * store's createdAt), the streak (streaks.ts, same git reading) and the
 * lesson of the week (the latest retrospective run's first `learnings`
 * item). test/wrapped.test.ts checks the numbers equal the digest's.
 */

export const WRAPPED_DEFAULT_PERIOD = "last 7 days";
/** A period text longer than this is refused (400): parsePeriod only
 *  reads `last N days` and `since YYYY-MM-DD` out of it. */
export const WRAPPED_PERIOD_MAX_CHARS = 100;
const LESSON_TITLE_MAX = 200;
const LESSON_TEXT_MAX = 600;

export interface WrappedLesson {
  title: string;
  /** The item's explanation; "" when it had none. */
  text: string;
  runId: string;
  /** YYYY-MM-DD the analyst gave it. */
  date?: string;
}

export interface Wrapped {
  /** As parsed by the digest: `from` and `to` are YYYY-MM-DD. `input` is
   *  the text asked for. */
  period: { input: string; from: string; to: string; days: number };
  cardsMerged: number;
  commits: number;
  agentRuns: number;
  spendUsd: number;
  topAgent: { id: string; runs: number; spendUsd: number } | null;
  pipelinesAdded: { id: string; name: string }[];
  streak: Streak;
  lesson: WrappedLesson | null;
}

/** Wrapped from a digest and the three things it has no notion of. Pure. */
export function wrappedFrom(
  input: string,
  digest: Pick<WisselDigest, "period" | "stats">,
  extra: { pipelinesAdded: Wrapped["pipelinesAdded"]; streak: Streak; lesson: WrappedLesson | null },
): Wrapped {
  const s = digest.stats;
  return {
    period: { input, ...digest.period },
    cardsMerged: s.merges,
    commits: s.commits,
    agentRuns: s.agentRuns,
    spendUsd: s.spendUsd,
    topAgent: s.topAgent,
    pipelinesAdded: extra.pipelinesAdded,
    streak: extra.streak,
    lesson: extra.lesson,
  };
}

/** Pipelines created within [from, to], oldest first. */
export function pipelinesAddedIn(defs: readonly Pick<PipelineDef, "id" | "name" | "createdAt">[], from: Date, to: Date): { id: string; name: string }[] {
  return defs
    .filter((d) => {
      const t = Date.parse(d.createdAt);
      return !Number.isNaN(t) && t >= from.getTime() && t <= to.getTime();
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((d) => ({ id: d.id, name: d.name }));
}

function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3).trimEnd() + "..." : flat;
}

/** The first `learnings` item of a retro analyst's handoff data, or
 *  null when it has none. Pure. */
export function firstLearning(analysis: Record<string, unknown> | undefined, runId: string): WrappedLesson | null {
  const stories = analysis?.stories;
  if (!Array.isArray(stories)) return null;
  for (const s of stories) {
    if (!s || typeof s !== "object") continue;
    const item = s as Record<string, unknown>;
    if (item.group !== "learnings" || typeof item.title !== "string" || !item.title.trim()) continue;
    return {
      title: cap(item.title, LESSON_TITLE_MAX),
      text: typeof item.explanation === "string" ? cap(item.explanation, LESSON_TEXT_MAX) : "",
      runId,
      ...(typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? { date: item.date } : {}),
    };
  }
  return null;
}

/** The lesson of the week: the latest retrospective run that got as far
 *  as its analysis, and that analysis's first `learnings` item (none
 *  when it has none). Runs still collecting or failed before the
 *  analysis are skipped, so a run in progress doesn't hide last week's. */
export async function latestLesson(board: Board, pipelines: PipelineStore, tasks: readonly TaskCard[]): Promise<WrappedLesson | null> {
  const retro = new Set((await pipelines.list()).filter((p) => newsRunKind(p) === "retro").map((p) => p.id));
  if (retro.size === 0) return null;
  const roots = tasks.filter((t) => t.pipelineId && !t.pipelineRunId && retro.has(t.pipelineId));
  // board.list() is in insertion order: the last root is the newest run.
  for (const root of [...roots].reverse()) {
    const stored = await loadStoredRun({ board, pipelines, telemetryPath: "", audioDir: "", tasks }, root.id);
    if (typeof stored === "string" || !stored.explain) continue;
    return firstLearning(stored.explain, root.id);
  }
  return null;
}

export interface WrappedDeps {
  board: Board;
  pipelines: PipelineStore;
  telemetryPath?: string;
  /** Only ever given read-only git commands (assertReadOnlyGit). */
  runner: CommandRunner;
  agentModel?: DigestInputs["agentModel"];
  worktreesRoot?: string;
}

/** The digest inputs Wrapped uses for a period: exactly what the
 *  retrospective's collect step passes, minus lessons and docs, which no
 *  stat reads. Exported so the equality test builds the same digest. */
export function wrappedDigestInputs(deps: WrappedDeps, input: string, now: Date): DigestInputs {
  return {
    board: deps.board,
    telemetryPath: deps.telemetryPath,
    runner: deps.runner,
    now,
    input,
    worktreesRoot: deps.worktreesRoot,
    agentModel: deps.agentModel,
  };
}

export async function buildWrapped(deps: WrappedDeps, input: string, now: Date): Promise<Wrapped> {
  const tasks = await deps.board.list();
  const period = parsePeriod(input, now);
  const [digest, defs, streak, lesson] = await Promise.all([
    buildWisselDigest(wrappedDigestInputs(deps, input, now)),
    deps.pipelines.list(),
    readStreak({ cards: tasks, runner: deps.runner, now, worktreesRoot: deps.worktreesRoot }),
    latestLesson(deps.board, deps.pipelines, tasks),
  ]);
  return wrappedFrom(input, digest, { pipelinesAdded: pipelinesAddedIn(defs, period.from, period.to), streak, lesson });
}
