// Merge-forward on a dirty PR (docs/SDD-coordinator.md §4.7, phase 2
// card 10).
//
// When the PR watcher sees a delivered card's PR go DIRTY (main moved on
// and now conflicts with it), one merge-forward card is started for it,
// never two. The card delivers the original card again through the merge
// path, which fetches main and builds the landing against it:
// - It may merge cleanly. Then it is gated, pushed to the same branch as a
//   fast-forward (never forced), the open PR is reused, and the card's PR
//   head moves on.
// - It may conflict. Then the conflict is left in the card's worktree and
//   the existing conflict integrator card is started (afterMergeAttempt).
//   The merge-forward card waits in review. On a later look, once the
//   integrator has finished, it runs again: the merge path commits the
//   resolution and delivers it.
// - A red gate goes back through the usual pushback; anything else fails
//   the merge-forward card with the reason.
import { existsSync } from "node:fs";
import type { Board } from "./board.ts";
import type { Registry } from "../core/registry.ts";
import type { TaskCard } from "../core/types.ts";
import { mergeTaskWorktree, type MergeContext } from "./worktree.ts";
import { afterMergeAttempt, conflictIntegratorState, startReReview, withConflictIntegratorCheck } from "../core/orchestrator.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { keepsPass } from "./review-tiers.ts";

export const MERGE_FORWARD_LABEL = "merge-forward";
/** Set as routedTo so the sweep never routes a merge-forward card. */
export const MERGE_FORWARD_OWNER = "wissel-merge-forward";

export function mergeForwardTitle(card: Pick<TaskCard, "title">): string {
  return `Merge forward: ${card.title}`;
}

export type MergeForwardOutcome = "delivered" | "waiting" | "busy" | "failed" | "pushback";

export interface MergeForwardDeps {
  board: Board;
  registry: Registry;
  merge: MergeContext;
  log?: (line: string) => void;
}

/** The live merge-forward card for `card` (not done, failed or archived). */
export async function liveMergeForward(board: Board, card: Pick<TaskCard, "id">): Promise<TaskCard | undefined> {
  return (await board.list()).find((t) => t.parentTaskId === card.id && t.labels.includes(MERGE_FORWARD_LABEL) && !t.archivedAt && t.status !== "done" && t.status !== "failed");
}

/** The files the card's own commits from `from` to `to` change, beyond
 *  what main brought in: each first-parent commit's files, and for a
 *  merge commit only the files that differ from every parent (the
 *  conflict resolution). Undefined when git can't say. */
export async function forwardChangedFiles(runner: CommandRunner, cwd: string, from: string, to: string): Promise<string[] | undefined> {
  const list = await runner(["git", "rev-list", "--first-parent", "--parents", `${from}..${to}`], { cwd });
  if (list.exitCode !== 0) return undefined;
  const files = new Set<string>();
  for (const line of list.stdout.split("\n").filter(Boolean)) {
    const [sha, ...parents] = line.trim().split(/\s+/);
    const args = parents.length > 1 ? ["diff-tree", "-r", "--cc", "--name-only", "--no-commit-id", sha!] : ["diff-tree", "-r", "--name-only", "--no-commit-id", sha!];
    const out = await runner(["git", ...args], { cwd });
    if (out.exitCode !== 0) return undefined;
    for (const f of out.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) files.add(f);
  }
  return [...files].sort();
}

/** After a merge-forward delivered: keep the PASS when the forward
 *  changed nothing of the card's own (a clean merge) or only what the
 *  policy's keepPass allows; else start a narrow re-review. What it did,
 *  in a line, or undefined when the PR's head didn't move. */
export async function afterForward(deps: MergeForwardDeps, card: TaskCard, worktreePath: string): Promise<string | undefined> {
  const now = await deps.board.get(card.id);
  const pr = now?.pr;
  const from = card.pr?.reviewedHead ?? card.pr?.head;
  if (!now || !pr || !from || pr.head === from) return undefined;
  const files = await forwardChangedFiles(deps.merge.runner, worktreePath, from, pr.head);
  const policy = card.repo ? (await deps.merge.reviewPolicyFor?.(card.repo).catch(() => undefined))?.policy : undefined;
  if (files !== undefined && keepsPass(files, policy?.keepPass)) {
    await deps.merge.recordPullRequest?.(card.id, { ...pr, reviewedHead: pr.head });
    return files.length ? `The review's PASS carries to ${pr.head.slice(0, 12)}: the merge changed only ${files.join(", ")}, which the review policy's keepPass allows.` : `The review's PASS carries to ${pr.head.slice(0, 12)}: main merged in cleanly.`;
  }
  const rr = await startReReview(deps.board, now, { from, to: pr.head, files: files ?? [] }, worktreePath);
  return rr ? `The merge changed ${files?.length ? files.join(", ") : "files git couldn't list"}, so a re-review (${rr.id.slice(0, 8)}) checks it before the PR can be armed.` : "A re-review of this head is already open.";
}

/** Brings a delivered card's PR up to date with main. Safe to call on
 *  every look at a dirty PR: it starts at most one card, and it re-runs
 *  only once the conflict integrator it waits on has finished. */
export async function mergeForward(deps: MergeForwardDeps, card: TaskCard): Promise<MergeForwardOutcome> {
  const { board } = deps;
  const log = deps.log ?? console.log;
  let mf = await liveMergeForward(board, card);
  if (mf && mf.status !== "review") return "busy";
  if (mf) {
    const integrator = await conflictIntegratorState(board, card);
    if (!integrator.finished) return "waiting";
  }
  const worktree = (await board.getResult(card.id))?.worktree;
  if (!mf) {
    mf = await board.create({
      title: mergeForwardTitle(card),
      body: `The PR for "${card.title}"${card.pr ? ` (#${card.pr.number})` : ""} conflicts with main. Wissel merges main into it again; a conflict goes to a conflict integrator card first.`,
      labels: [MERGE_FORWARD_LABEL],
      ...(card.repo ? { repo: card.repo } : {}),
      parentTaskId: card.id,
      routedTo: MERGE_FORWARD_OWNER,
      ...(card.key ? { key: card.key } : {}),
    });
    log(`merge forward: started ${mf.id} for ${card.title}`);
  }
  await board.move(mf.id, "running");
  const finish = async (status: "done" | "review" | "failed", ok: boolean, summary: string) => {
    await board.recordResult({ taskId: mf!.id, agentId: MERGE_FORWARD_OWNER, ok, summary });
    await board.move(mf!.id, status);
  };

  if (!card.repo || !worktree || !existsSync(worktree.path)) {
    await finish("failed", false, "The card's worktree is gone, so there is nothing to merge main into. Deliver the card again from a fresh attempt.");
    return "failed";
  }
  // Bringing main in keeps the reviewed head (§4.7): the PR can't be
  // armed at the new head until keepPass or a re-review says so.
  const res = await mergeTaskWorktree(card.repo, worktree, card, withConflictIntegratorCheck(board, { ...deps.merge, keepReviewedHead: true }));
  if (res.outcome === "delivered") {
    const after = await afterForward(deps, card, worktree.path);
    await finish("done", true, after ? `${res.message}\n\n${after}` : res.message);
    return "delivered";
  }
  if (res.outcome === "conflict") {
    await afterMergeAttempt(board, deps.registry, card, worktree, res);
    await finish("review", false, `Main conflicts with this PR; a conflict integrator card resolves it in the worktree, then this runs again.\n\n${res.message}`);
    return "waiting";
  }
  if (res.outcome === "gate-failed") {
    await afterMergeAttempt(board, deps.registry, card, worktree, res);
    await finish("failed", false, `The gates failed on main merged in; the card went back for another attempt.\n\n${res.message}`);
    return "pushback";
  }
  await finish("failed", false, res.message);
  return "failed";
}
