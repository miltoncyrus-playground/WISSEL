import type { Board } from "../services/board.ts";
import type { TaskCard } from "./types.ts";

/** Fixed, not configurable — Milton asked for 24 hours specifically, not
 *  a tunable default (see docs/SDD-task-archiving.md §3.3). The only
 *  operational knob is how often the scheduler *checks*
 *  (ArchiveSchedulerOptions.checkIntervalHours), not the business rule
 *  itself. */
export const AUTO_ARCHIVE_AFTER_HOURS = 24;

/**
 * Pure, deterministic (per CLAUDE.md's latent-vs-deterministic-space
 * rule): which root tasks are eligible for auto-archive right now.
 * Auto-archive only ever evaluates root tasks (no parentTaskId) — a
 * non-root task reaching `done` on its own never independently
 * auto-archives; only its lineage root does, once the root itself has
 * been done for 24h AND every descendant is settled (done, superseded
 * or already archived). Archiving the root then cascades to the whole
 * subtree. See docs/SDD-task-archiving.md §3.4.
 *
 * Why the settled check: a planner root is `done` minutes after it
 * plans, while its subtasks run for days. Without the check, its 24h
 * mark swept subtasks that were in review or queued off the board
 * (2026-10-30: four live cards, two of them waiting on Milton's review,
 * archived on the first tick after WISSEL_AUTO_ARCHIVE was turned on).
 */
export function findArchivableRoots(tasks: TaskCard[], now: Date = new Date()): TaskCard[] {
  const children = new Map<string, TaskCard[]>();
  for (const t of tasks) {
    if (!t.parentTaskId) continue;
    const siblings = children.get(t.parentTaskId) ?? [];
    siblings.push(t);
    children.set(t.parentTaskId, siblings);
  }
  return tasks.filter((t) => {
    if (t.parentTaskId) return false;
    if (t.status !== "done") return false;
    if (!t.doneAt) return false;
    if (t.archivedAt) return false;
    const elapsedMs = now.getTime() - new Date(t.doneAt).getTime();
    if (elapsedMs < AUTO_ARCHIVE_AFTER_HOURS * 60 * 60 * 1000) return false;
    return subtreeSettled(t, children);
  });
}

/** A card the board no longer needs to show: done, replaced by a later
 *  attempt, or already archived. Anything else (queued, running, in
 *  review, failed, escalated) still has work or a decision pending. */
function settled(t: TaskCard): boolean {
  return t.status === "done" || !!t.supersededBy || !!t.archivedAt;
}

/** Every descendant of `root` (by parentTaskId) is settled. */
function subtreeSettled(root: TaskCard, children: Map<string, TaskCard[]>): boolean {
  const stack = [...(children.get(root.id) ?? [])];
  const seen = new Set<string>([root.id]);
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    if (!settled(t)) return false;
    stack.push(...(children.get(t.id) ?? []));
  }
  return true;
}

/**
 * One tick: lists every task, finds archivable roots, archives each via
 * `board.archive` (which cascades to the whole subtree — see
 * Board.archive), and returns every card actually archived this tick so
 * a caller/test can tell a no-op tick from one that fired.
 */
export async function runAutoArchiveTick(board: Pick<Board, "list" | "archive">): Promise<TaskCard[]> {
  const tasks = await board.list();
  const roots = findArchivableRoots(tasks);
  const archived: TaskCard[] = [];
  for (const root of roots) {
    archived.push(...(await board.archive(root.id)));
  }
  return archived;
}

export interface ArchiveSchedulerOptions {
  board: Board;
  /** Hours between scheduler checks — default 1 (docs/SDD-task-archiving.md
   *  §3.3). Distinct from AUTO_ARCHIVE_AFTER_HOURS, the fixed 24h
   *  business rule this scheduler checks against on every tick. */
  checkIntervalHours?: number;
}

export interface ArchiveScheduler {
  stop(): void;
}

/** Default frequency the scheduler checks at — how often, not the 24h
 *  threshold itself. See ArchiveSchedulerOptions.checkIntervalHours. */
export const DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS = 1;

/**
 * Wires `runAutoArchiveTick` to an in-process `setInterval`, gated
 * behind WISSEL_AUTO_ARCHIVE (see src/api/server.ts) — off by default,
 * same pattern WISSEL_MEMORY_CURATION already uses (see
 * startMemoryScheduler, src/core/memory-scheduler.ts). Checks once
 * immediately, then on the timer, same "don't sit idle for a full
 * interval on a fresh install" reasoning startMemoryScheduler's own
 * comment documents — a task that became archivable while wissel wasn't
 * running shouldn't wait up to another full checkIntervalHours before
 * its first check.
 */
export function startArchiveScheduler(opts: ArchiveSchedulerOptions): ArchiveScheduler {
  const checkIntervalHours = opts.checkIntervalHours ?? DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS;
  const tick = () => void runAutoArchiveTick(opts.board).catch((e) => console.error(`archive-scheduler: tick failed: ${(e as Error).message}`));
  tick();
  const handle = setInterval(tick, checkIntervalHours * 60 * 60 * 1000);
  return { stop: () => clearInterval(handle) };
}
