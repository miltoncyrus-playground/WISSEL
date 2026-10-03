import type { Board } from "../services/board.ts";

/**
 * Startup-only cleanup for tasks crash-orphaned at `status: "running"`.
 *
 * `HarnessPool`'s in-flight map and `Orchestrator`'s own in-flight set
 * are both pure in-process state, confirmed empty on a fresh process
 * start — a task's "run" *is* this process's own subprocess call, never
 * something a separate supervisor tracks. That makes every task found at
 * `"running"` here unambiguously a crash/restart orphan: there's no
 * heartbeat/lease needed to distinguish a real long-runner from a dead
 * one. See docs/SDD-crash-recovery.md §3.1.
 *
 * `"dispatched"` tasks are deliberately never touched — those are
 * handed off to an external runner (agetor), not something this process
 * itself was driving, so wissel has no basis for reclaiming them.
 *
 * Called once, before the first `sweep()`, from `createApp` (see
 * src/api/server.ts) — unconditionally, regardless of whether the
 * automatic orchestrator loop (`WISSEL_ORCHESTRATOR`) is on, since this
 * is cleanup of existing state, not automation of new work.
 */
export async function reconcileOrphanedTasks(board: Pick<Board, "list" | "resetToInbox">): Promise<number> {
  const orphaned = await board.list({ status: "running" });
  for (const task of orphaned) {
    await board.resetToInbox(task.id);
  }
  return orphaned.length;
}
