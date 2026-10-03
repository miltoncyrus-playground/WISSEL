import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Board } from "../services/board.ts";
import { checkDanglingMerges, resolveReposToCheck, type DanglingMerge } from "../services/merge-health.ts";
import type { ProjectStore } from "../services/projects.ts";
import { DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS } from "./archive-scheduler.ts";

export interface MergeHealthSchedulerOptions {
  board: Pick<Board, "list">;
  projects: Pick<ProjectStore, "list">;
  runner: CommandRunner;
  /** Hours between scheduler checks. Defaults to
   *  DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS (imported straight from
   *  archive-scheduler.ts's own default rather than a separately
   *  hardcoded number, so the two can never silently drift apart). */
  checkIntervalHours?: number;
}

export interface MergeHealthScheduler {
  stop(): void;
  /** The most recent tick's result — `[]` before the first tick resolves
   *  (startMergeHealthScheduler fires one immediately, so this window is
   *  brief) or whenever nothing's actually dangling. `GET /merge-health`
   *  (src/api/server.ts) reads this directly rather than re-running the
   *  check per request — an in-process cache of "last state," the same
   *  role the model-refresh scheduler's on-disk cache plays for its own
   *  endpoint, just not file-backed since nothing here needs to survive
   *  a restart. */
  getLast(): DanglingMerge[];
}

/** Matches archive-scheduler's own default exactly — see
 *  MergeHealthSchedulerOptions.checkIntervalHours. */
export const DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS = DEFAULT_ARCHIVE_CHECK_INTERVAL_HOURS;

/**
 * Wires `checkDanglingMerges` to an in-process `setInterval`, gated
 * behind WISSEL_MERGE_HEALTH (see src/api/server.ts) — off by default,
 * same pattern WISSEL_AUTO_ARCHIVE/WISSEL_MODEL_REFRESH already use.
 * Checks once immediately, then on the timer, same "don't sit idle for
 * a full interval on a fresh install" reasoning startArchiveScheduler's
 * own comment documents. The repo set is re-resolved fresh on every
 * tick (not fixed at construction) — a newly registered project or a
 * freshly created task's repo should get covered by the very next
 * check, not just ones that existed when the scheduler started.
 */
export function startMergeHealthScheduler(opts: MergeHealthSchedulerOptions): MergeHealthScheduler {
  const checkIntervalHours = opts.checkIntervalHours ?? DEFAULT_MERGE_HEALTH_CHECK_INTERVAL_HOURS;
  let last: DanglingMerge[] = [];
  const tick = () =>
    void resolveReposToCheck(opts.board, opts.projects)
      .then((repos) => checkDanglingMerges(repos, opts.runner))
      .then((result) => {
        last = result;
      })
      .catch((e) => console.error(`merge-health-scheduler: tick failed: ${(e as Error).message}`));
  tick();
  const handle = setInterval(tick, checkIntervalHours * 60 * 60 * 1000);
  return { stop: () => clearInterval(handle), getLast: () => last };
}
