import { readFile } from "node:fs/promises";
import type { Board } from "../services/board.ts";
import { DEFAULT_MEMORY_PATH, readMemoryLessons } from "../services/memory.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "./types.ts";
import type { Orchestrator } from "./orchestrator.ts";

/** Default frequency, per docs/SDD-memory-curator.md §8.2. */
export const DEFAULT_MEMORY_INTERVAL_HOURS = 24;

/** Must match agents/manifest.yaml's memory-curator entry exactly — both
 *  the agent whose telemetry "last ran" is read for, and the id every
 *  auto-created curation task is expected to route to via tag overlap
 *  (see MEMORY_TASK_LABELS below, which mirrors memory-curator's own
 *  declared `tags`). */
const MEMORY_CURATOR_AGENT_ID = "memory-curator";

/** Labels the auto-created curation task carries — must overlap
 *  memory-curator's declared tags in agents/manifest.yaml for the router
 *  to dispatch it with confidence via normal tag-overlap scoring, the
 *  same mechanism spawnReviewerTask/maybeSpawnIntegrator already rely on
 *  in orchestrator.ts. No special-casing of the agent id anywhere here. */
const MEMORY_TASK_LABELS = ["memory", "housekeeping"];

interface RawResultEvent {
  type?: string;
  taskId?: string;
  agentId?: string;
  actualCost?: number;
  harnessId?: string;
  at?: string;
}

export interface ResultEvent {
  taskId: string;
  agentId: string;
  at: string;
  actualCost?: number;
  harnessId?: string;
}

/** Tolerant JSONL read, same "skip what doesn't parse or doesn't fit the
 *  shape" contract TelemetryLog.sumCostSince already holds for this same
 *  file — a missing file (nothing recorded yet) reads as no events, not
 *  an error. */
async function readResultEvents(telemetryPath: string): Promise<ResultEvent[]> {
  let contents: string;
  try {
    contents = await readFile(telemetryPath, "utf8");
  } catch {
    return [];
  }
  const events: ResultEvent[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RawResultEvent;
    try {
      parsed = JSON.parse(line) as RawResultEvent;
    } catch {
      continue;
    }
    if (parsed.type !== "result" || typeof parsed.taskId !== "string" || typeof parsed.agentId !== "string" || typeof parsed.at !== "string") continue;
    events.push({ taskId: parsed.taskId, agentId: parsed.agentId, at: parsed.at, actualCost: parsed.actualCost, harnessId: parsed.harnessId });
  }
  return events;
}

/**
 * The timestamp of the most recent memory-curator run, read fresh from
 * telemetry every time — no separate "last ran" persistence exists or
 * is needed (see docs/SDD-memory-curator.md §9). Undefined means it has
 * never run, which `isMemoryCurationDue` treats as due right now.
 */
export async function getLastMemoryCurationAt(telemetryPath: string, agentId: string = MEMORY_CURATOR_AGENT_ID): Promise<Date | undefined> {
  const events = await readResultEvents(telemetryPath);
  let latest: Date | undefined;
  for (const event of events) {
    if (event.agentId !== agentId) continue;
    const at = new Date(event.at);
    if (!latest || at.getTime() > latest.getTime()) latest = at;
  }
  return latest;
}

/**
 * Every past memory-curator run, most recent first — what the board
 * UI's Memory tab shows as curation history. Each run's own
 * `TaskResult.summary` (read separately, via `board.getResult`, by the
 * caller) is the exact curated content that run wrote to
 * `memory/lessons.md` at the time — durable per-run history that
 * survives even though the file itself is always wholesale-replaced
 * (see writeMemoryLessons), since task_results is never overwritten.
 */
export async function getMemoryCurationHistory(telemetryPath: string, agentId: string = MEMORY_CURATOR_AGENT_ID): Promise<ResultEvent[]> {
  const events = await readResultEvents(telemetryPath);
  return events.filter((e) => e.agentId === agentId).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Pure due-ness check: never run reads as due now; otherwise due once
 *  `intervalHours` has elapsed since `lastRanAt`. */
export function isMemoryCurationDue(lastRanAt: Date | undefined, intervalHours: number, now: Date = new Date()): boolean {
  if (!lastRanAt) return true;
  return now.getTime() - lastRanAt.getTime() >= intervalHours * 60 * 60 * 1000;
}

function formatSessionEntry(task: TaskCard | undefined, result: TaskResult | undefined, decision: RoutingDecision | undefined): string {
  const title = task?.title ?? "(unknown task)";
  const outcome = result ? (result.ok ? `ok — ${result.summary}` : `failed — ${result.summary}`) : "(no recorded result)";
  const details: string[] = [];
  if (decision?.reason) details.push(`routing: ${decision.reason}`);
  if (result?.actualCost !== undefined) details.push(`cost: $${result.actualCost.toFixed(4)}`);
  if (result?.harnessId) details.push(`harness: ${result.harnessId}`);
  const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
  return `- ${title}: ${outcome}${suffix}`;
}

/**
 * The deterministic gather step memory-curator's task body is built
 * from — no LLM call here, per CLAUDE.md's latent-vs-deterministic-space
 * rule. Parses telemetry.jsonl for "result" events newer than `since`
 * (or every one ever recorded, when `since` is undefined — never run
 * before), collects their distinct taskIds, and looks each one up via
 * `board` for its title/outcome/routing reason/cost/harness. Also reads
 * the *current* memory/lessons.md, when one exists, and includes it
 * verbatim — memory-curator's job is to dedup/consolidate against what's
 * already there, not append blindly (docs/SDD-memory-curator.md §8.3),
 * so it needs to see the existing file to do that.
 */
export async function gatherSessionLessons(
  telemetryPath: string,
  board: Pick<Board, "get" | "getResult" | "getDecision">,
  since: Date | undefined,
  memoryPath: string = DEFAULT_MEMORY_PATH,
): Promise<string> {
  const events = await readResultEvents(telemetryPath);
  const relevant = since ? events.filter((e) => new Date(e.at).getTime() > since.getTime()) : events;

  const taskIds: string[] = [];
  const seen = new Set<string>();
  for (const event of relevant) {
    if (seen.has(event.taskId)) continue;
    seen.add(event.taskId);
    taskIds.push(event.taskId);
  }

  const entries: string[] = [];
  for (const taskId of taskIds) {
    const [task, result, decision] = await Promise.all([board.get(taskId), board.getResult(taskId), board.getDecision(taskId)]);
    entries.push(formatSessionEntry(task, result, decision));
  }

  const sections: string[] = [];
  const existing = await readMemoryLessons(memoryPath);
  if (existing) sections.push("Current memory/lessons.md:", existing.trim());

  sections.push(
    entries.length > 0
      ? `Sessions since ${since ? since.toISOString() : "the beginning (memory-curator has never run before)"}:\n${entries.join("\n")}`
      : "No new sessions since the last curation run.",
  );

  return sections.join("\n\n");
}

export interface MemorySchedulerOptions {
  board: Board;
  orchestrator: Orchestrator;
  /** The manual executor pool memory-curator actually runs on — the
   *  same one server.ts's board UI "Run" button already uses (see
   *  Orchestrator.runNow, the exact path this reuses). */
  executors: Executor[];
  telemetryPath: string;
  /** Hours between curation runs — default 24 (docs/SDD-memory-curator.md
   *  §8.2). */
  intervalHours?: number;
  memoryPath?: string;
  /** Where the auto-created curation task's `repo` points — memory-curator
   *  is readonly-tier and never edits it, but a TaskCard needs one.
   *  Defaults to the current working directory, which is also where the
   *  relative `memoryPath` resolves from. */
  repo?: string;
}

/**
 * Runs one due-check-and-maybe-curate cycle. Pure enough to unit test on
 * its own: reads "last ran" fresh from telemetry, does nothing if not
 * due yet, otherwise gathers session lessons, creates a
 * `[memory, housekeeping]`-tagged task carrying them as its body, and
 * hands it to the exact same `orchestrator.runNow` path a human's board
 * "Run now" click already uses — no new execution mechanism. Returns
 * whether it actually ran, so a caller/test can tell a skipped tick from
 * a fired one.
 */
export async function runMemoryCurationIfDue(opts: MemorySchedulerOptions): Promise<boolean> {
  const intervalHours = opts.intervalHours ?? DEFAULT_MEMORY_INTERVAL_HOURS;
  const memoryPath = opts.memoryPath ?? DEFAULT_MEMORY_PATH;

  const lastRanAt = await getLastMemoryCurationAt(opts.telemetryPath);
  if (!isMemoryCurationDue(lastRanAt, intervalHours)) return false;

  const body = await gatherSessionLessons(opts.telemetryPath, opts.board, lastRanAt, memoryPath);
  const task = await opts.board.create({
    title: "Curate session memory",
    body,
    labels: [...MEMORY_TASK_LABELS],
    repo: opts.repo ?? process.cwd(),
  });
  await opts.orchestrator.runNow(task.id, opts.executors);
  return true;
}

export interface MemoryScheduler {
  stop(): void;
}

/**
 * Wires `runMemoryCurationIfDue` to an in-process `setInterval`, gated
 * behind WISSEL_MEMORY_CURATION (see src/api/server.ts) — off by default,
 * same pattern WISSEL_ORCHESTRATOR/WISSEL_EXECUTE_WRITE_TIER already use.
 * Checks once immediately (same "run an initial pass, then re-check on
 * a timer" shape as Orchestrator.start()'s own `sweep()` call) — without
 * this, a brand-new "never run" install would sit idle for a full
 * `intervalHours` before its first, immediately-due check ever fires.
 * After that, the due-check inside each tick is what actually decides
 * whether to act, so a tick landing slightly early (e.g. right after a
 * restart) is a correct no-op, not a bug.
 */
export function startMemoryScheduler(opts: MemorySchedulerOptions): MemoryScheduler {
  const intervalHours = opts.intervalHours ?? DEFAULT_MEMORY_INTERVAL_HOURS;
  const tick = () => void runMemoryCurationIfDue(opts).catch((e) => console.error(`memory-scheduler: tick failed: ${(e as Error).message}`));
  tick();
  const handle = setInterval(tick, intervalHours * 60 * 60 * 1000);
  return { stop: () => clearInterval(handle) };
}
