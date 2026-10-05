import type { Board } from "../services/board.ts";
import type { Registry } from "./registry.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { resumeAfterReviewVerdict } from "./orchestrator.ts";

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

/**
 * Startup-only recovery for an implementer task stuck at
 * `"pending-review"` whose reviewer already reported a verdict before a
 * crash interrupted whatever `handleReviewVerdict` was about to do next
 * (`resumeAfterApproval`'s merge, `spawnPushbackImplementer`, or the
 * escalation branch — see docs/SDD-crash-recovery.md's interrupted-
 * review-verdict section for the real incident this covers: an approved
 * card merged into the repo for real, then the process restarted before
 * `board.move(implementerTask.id, "done")` ever ran, stranding both the
 * card and every `dependsOn` follower).
 *
 * A candidate is any task that's still `"pending-review"`, not already
 * superseded (a pushback re-attempt already replaced it — the crash
 * already got reconciled by an earlier pass, or never happened on this
 * one) and not archived, whose own reviewer child (found via its review
 * lineage, filtered to `parentTaskId === implementerTask.id` and
 * `routedTo === "reviewer"`) is `"done"` with a recorded verdict.
 * Re-drives exactly what `handleReviewVerdict` would have done next via
 * `resumeAfterReviewVerdict` — the same function the live path uses,
 * never a parallel copy — which is itself what makes this idempotent:
 * on approve it already refuses to re-run a merge that landed before the
 * crash (`resumeAfterApproval`'s own `determineWorktreeMergeState`
 * gate), and either outcome (approve or pushback/escalate) always moves
 * the implementer out of `"pending-review"` (or leaves it there only
 * when the merge state truly can't be proven), so a second run over the
 * same board finds nothing left to do.
 *
 * Fails closed, never a silent `"done"`, whenever the merge state can't
 * be proven (worktree and branch both already gone, no matching merge
 * commit in history either — see `determineWorktreeMergeState`) — left
 * at `"pending-review"` exactly as found, logged for a human to look at,
 * never counted in the returned recovery count. One failing candidate
 * (a repo that no longer exists on disk, say) never takes the rest of
 * the sweep down with it.
 *
 * Called once, before the first `sweep()`, from `createApp` (see
 * src/api/server.ts), right after `reconcileOrphanedTasks` above —
 * unconditionally, same reasoning: this is cleanup of existing state,
 * not automation of new work.
 */
export async function reconcileInterruptedReviewVerdicts(board: Board, registry: Registry, runner: CommandRunner): Promise<number> {
  const candidates = await board.list({ status: "pending-review" });
  let recovered = 0;

  for (const implementerTask of candidates) {
    if (implementerTask.supersededBy !== undefined) continue;
    if (implementerTask.archivedAt !== undefined) continue;

    try {
      const lineageId = implementerTask.reviewLineageId ?? implementerTask.id;
      const lineage = await board.getLineage(lineageId);
      const reviewerTask = lineage.filter((t) => t.parentTaskId === implementerTask.id && t.routedTo === "reviewer" && t.status === "done").pop();
      if (!reviewerTask) continue; // reviewer still running/in inbox, or never existed — not this case

      const result = await board.getResult(reviewerTask.id);
      if (!result || result.verdict === undefined) continue; // done for some other reason, not a recorded verdict

      const outcome = await resumeAfterReviewVerdict(board, registry, reviewerTask, result, runner);
      if (outcome === "unresolved") {
        console.error(
          `crash recovery: pending-review task ${implementerTask.id} ("${implementerTask.title}") left unresolved — can't prove whether its worktree branch already merged into ${implementerTask.repo}; needs a human`,
        );
        continue;
      }

      console.log(`crash recovery: recovered interrupted review verdict for task ${implementerTask.id} ("${implementerTask.title}") — ${outcome}`);
      recovered++;
    } catch (e) {
      console.error(`crash recovery: failed to reconcile pending-review task ${implementerTask.id}: ${(e as Error).message}`);
    }
  }

  return recovered;
}
