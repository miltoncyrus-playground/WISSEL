import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { reconcileInterruptedReviewVerdicts } from "../src/core/crash-recovery.ts";
import { createTaskWorktree, mergeTaskWorktree, removeTaskWorktree, type TaskWorktree } from "../src/services/worktree.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import type { TaskCard } from "../src/core/types.ts";

/**
 * Real `git` everywhere a worktree/merge is involved — same "real git,
 * not a hand-faked fixture" discipline test/orchestrator-review-
 * lifecycle.test.ts and test/merge-health.test.ts already hold. What's
 * under test here (reconcileInterruptedReviewVerdicts, and the
 * determineWorktreeMergeState gate it relies on through
 * resumeAfterApproval) is entirely about real on-disk git state left
 * behind mid-crash, which a mocked runner couldn't produce faithfully.
 */
function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function realRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-crash-review-repo-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-test@example.com"], dir);
  git(["config", "user.name", "wissel test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "seed"], dir);
  return dir;
}

function setRoutedTo(board: SqliteBoard, taskId: string, routedTo: string): void {
  board.db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", [routedTo, taskId]);
}

/**
 * Builds exactly the board state `handleReviewVerdict` leaves behind the
 * instant after `board.move(reviewerTask.id, "done")` returns, but
 * before anything that function does next (`resumeAfterApproval`,
 * `spawnPushbackImplementer`, or the escalation branch) ever runs — the
 * crash window docs/SDD-crash-recovery.md's interrupted-review-verdict
 * section is about. Never calls `handleReviewVerdict`/
 * `resumeAfterReviewVerdict` itself; that's exactly the thing a crash
 * prevented from happening, and exactly what `reconcileInterruptedReview
 * Verdicts` must re-drive on its own.
 */
async function seedInterruptedVerdict(
  board: SqliteBoard,
  repo: string,
  opts: { verdict: "approve" | "changes_requested"; withWorktree: boolean; writeContent?: string },
): Promise<{ implementer: TaskCard; reviewer: TaskCard; worktree?: TaskWorktree }> {
  const implementer = await board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo });
  setRoutedTo(board, implementer.id, "implementer");

  let worktree: TaskWorktree | undefined;
  if (opts.withWorktree) {
    const created = await createTaskWorktree(repo, implementer.id, { runner: runViaBun });
    if ("error" in created) throw new Error(`test fixture bug: ${created.error}`);
    worktree = created;
    if (opts.writeContent !== undefined) {
      writeFileSync(join(worktree.path, "feature.txt"), opts.writeContent);
    }
  }

  await board.recordResult({ taskId: implementer.id, agentId: "implementer", ok: true, summary: "implemented", worktree });
  await board.move(implementer.id, "pending-review");

  const reviewer = await board.create({
    title: `Review: ${implementer.title}`,
    body: implementer.body,
    labels: ["review"],
    repo: worktree?.path ?? repo,
    parentTaskId: implementer.id,
    reviewLineageId: implementer.id,
    pushbackCount: 0,
  });
  setRoutedTo(board, reviewer.id, "reviewer");

  await board.recordResult({
    taskId: reviewer.id,
    agentId: "reviewer",
    ok: true,
    summary: opts.verdict === "approve" ? "approved" : "requested changes",
    verdict: opts.verdict,
    reviewFeedback: opts.verdict === "approve" ? "looks good" : "missing error handling",
  });
  // The one call handleReviewVerdict always makes before anything else —
  // the crash hit immediately after this, per this function's own doc
  // comment above.
  await board.move(reviewer.id, "done");

  return { implementer, reviewer, worktree };
}

async function cleanup(...dirs: string[]): Promise<void> {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

test("approve verdict, branch already merged pre-crash: moves to done, no second merge commit, and unblocks a dependsOn follower", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const { implementer, worktree } = await seedInterruptedVerdict(board, repo, { verdict: "approve", withWorktree: true, writeContent: "line from implementer\n" });

    // Simulate the merge having already landed for real before the
    // crash — mergeTaskWorktree commits the worktree's content, merges
    // it into repo, and removes the worktree/branch, exactly as
    // tryAutoMerge would have, just never followed by
    // board.move(implementer.id, "done").
    const preMerge = await mergeTaskWorktree(repo, worktree!, implementer, runViaBun);
    expect(preMerge.ok).toBe(true);
    const mergeCommitsBefore = Bun.spawnSync(["git", "log", "--oneline", "--grep=Merge"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim().split("\n");
    expect(mergeCommitsBefore).toHaveLength(1);

    const dependent = await board.create({ title: "Build on top", body: "", labels: ["code"], repo, dependsOn: [implementer.id] });

    const recovered = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(recovered).toBe(1);

    expect((await board.get(implementer.id))!.status).toBe("done");

    // No second merge commit was ever created.
    const mergeCommitsAfter = Bun.spawnSync(["git", "log", "--oneline", "--grep=Merge"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim().split("\n");
    expect(mergeCommitsAfter).toEqual(mergeCommitsBefore);

    // The dependsOn follower, previously blocked on a permanently
    // pending-review implementer, becomes eligible on the next sweep().
    const orchestrator = new Orchestrator(board, registry, new Router(registry), []);
    await orchestrator.sweep();
    const after = await board.get(dependent.id);
    expect(after!.status).not.toBe("inbox");
    expect(after!.routedTo).toBeDefined();
  } finally {
    await cleanup(repo);
  }
});

test("approve verdict, branch NOT merged yet: gets merged for real and moved to done", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const { implementer, worktree } = await seedInterruptedVerdict(board, repo, { verdict: "approve", withWorktree: true, writeContent: "line from implementer\n" });

    expect(existsSync(worktree!.path)).toBe(true);

    const recovered = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(recovered).toBe(1);

    expect((await board.get(implementer.id))!.status).toBe("done");

    // The merge actually happened for real: worktree gone, branch gone,
    // content landed in repo.
    expect(existsSync(worktree!.path)).toBe(false);
    const branches = Bun.spawnSync(["git", "branch", "--list"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8");
    expect(branches).not.toContain(worktree!.branch);
    expect(Bun.file(join(repo, "feature.txt")).size).toBeGreaterThan(0);
  } finally {
    await cleanup(repo);
  }
});

test("changes_requested verdict with no pushback card yet: creates exactly one pushback attempt; a second reconciliation run creates no duplicate", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const { implementer } = await seedInterruptedVerdict(board, repo, { verdict: "changes_requested", withWorktree: false });

    const recovered = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(recovered).toBe(1);

    const supersededOriginal = await board.get(implementer.id);
    expect(supersededOriginal!.supersededBy).toBeDefined();
    const reattempt = await board.get(supersededOriginal!.supersededBy!);
    expect(reattempt).toBeDefined();
    expect(reattempt!.pushbackCount).toBe(1);
    expect(reattempt!.body).toContain("missing error handling");

    const pushbackAttempts = (await board.list()).filter((t) => t.title === implementer.title && !t.labels.includes("review"));
    expect(pushbackAttempts).toHaveLength(2); // the original + exactly one re-attempt

    const secondRun = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(secondRun).toBe(0);

    const pushbackAttemptsAfter = (await board.list()).filter((t) => t.title === implementer.title && !t.labels.includes("review"));
    expect(pushbackAttemptsAfter).toHaveLength(2);
  } finally {
    await cleanup(repo);
  }
});

test("untouched cases: reviewer still running, reviewer still in inbox, a superseded implementer, and an archived implementer", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();

    // Reviewer still running — no verdict recorded yet.
    const implA = await board.create({ title: "A", body: "", labels: ["code"], repo });
    setRoutedTo(board, implA.id, "implementer");
    await board.recordResult({ taskId: implA.id, agentId: "implementer", ok: true, summary: "implemented" });
    await board.move(implA.id, "pending-review");
    const reviewerA = await board.create({ title: "Review: A", body: "", labels: ["review"], repo, parentTaskId: implA.id, reviewLineageId: implA.id, pushbackCount: 0 });
    setRoutedTo(board, reviewerA.id, "reviewer");
    await board.move(reviewerA.id, "running");

    // Reviewer still in inbox — never even dispatched.
    const implB = await board.create({ title: "B", body: "", labels: ["code"], repo });
    setRoutedTo(board, implB.id, "implementer");
    await board.recordResult({ taskId: implB.id, agentId: "implementer", ok: true, summary: "implemented" });
    await board.move(implB.id, "pending-review");
    await board.create({ title: "Review: B", body: "", labels: ["review"], repo, parentTaskId: implB.id, reviewLineageId: implB.id, pushbackCount: 0 });

    // A superseded implementer — already recovered (or never crashed),
    // must never be reconsidered.
    const implC = await board.create({ title: "C", body: "", labels: ["code"], repo });
    setRoutedTo(board, implC.id, "implementer");
    await board.recordResult({ taskId: implC.id, agentId: "implementer", ok: true, summary: "implemented" });
    await board.move(implC.id, "pending-review");
    const reviewerC = await board.create({ title: "Review: C", body: "", labels: ["review"], repo, parentTaskId: implC.id, reviewLineageId: implC.id, pushbackCount: 0 });
    setRoutedTo(board, reviewerC.id, "reviewer");
    await board.recordResult({ taskId: reviewerC.id, agentId: "reviewer", ok: true, summary: "requested changes", verdict: "changes_requested", reviewFeedback: "fix it" });
    await board.move(reviewerC.id, "done");
    const replacementC = await board.create({ title: "C", body: "", labels: ["code"], repo, parentTaskId: reviewerC.id, reviewLineageId: implC.id, pushbackCount: 1 });
    await board.setSupersededBy(implC.id, replacementC.id);

    // An archived implementer — stuck at pending-review but a human
    // already archived it; must never be resurrected.
    const implD = await board.create({ title: "D", body: "", labels: ["code"], repo });
    setRoutedTo(board, implD.id, "implementer");
    await board.recordResult({ taskId: implD.id, agentId: "implementer", ok: true, summary: "implemented" });
    await board.move(implD.id, "pending-review");
    const reviewerD = await board.create({ title: "Review: D", body: "", labels: ["review"], repo, parentTaskId: implD.id, reviewLineageId: implD.id, pushbackCount: 0 });
    setRoutedTo(board, reviewerD.id, "reviewer");
    await board.recordResult({ taskId: reviewerD.id, agentId: "reviewer", ok: true, summary: "approved", verdict: "approve", reviewFeedback: "lgtm" });
    await board.move(reviewerD.id, "done");
    await board.archive(implD.id);

    const recovered = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(recovered).toBe(0);

    expect((await board.get(implA.id))!.status).toBe("pending-review");
    expect((await board.get(implB.id))!.status).toBe("pending-review");
    expect((await board.get(implC.id))!.status).toBe("pending-review"); // supersededBy is set, but status itself is untouched by design
    expect((await board.get(implC.id))!.supersededBy).toBe(replacementC.id);
    expect((await board.get(implD.id))!.status).toBe("pending-review");
    expect((await board.get(implD.id))!.archivedAt).toBeDefined();
  } finally {
    await cleanup(repo);
  }
});

test("running reconciliation twice in a row changes nothing the second time", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const { implementer } = await seedInterruptedVerdict(board, repo, { verdict: "approve", withWorktree: true, writeContent: "line from implementer\n" });

    const first = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(first).toBe(1);
    expect((await board.get(implementer.id))!.status).toBe("done");

    const second = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    expect(second).toBe(0);
    expect((await board.get(implementer.id))!.status).toBe("done");
  } finally {
    await cleanup(repo);
  }
});

test("unprovable state (worktree and branch both gone, no matching merge commit): left as pending-review, never moved to done, logged", async () => {
  const repo = await realRepo();
  try {
    const board = new SqliteBoard();
    const registry = await Registry.load();
    const { implementer, worktree } = await seedInterruptedVerdict(board, repo, { verdict: "approve", withWorktree: true, writeContent: "line from implementer\n" });

    // Discarded, never merged — removeTaskWorktree deletes both the
    // worktree directory and the branch, same as a real Discard action,
    // leaving no merge commit behind anywhere in history.
    await removeTaskWorktree(repo, worktree!, runViaBun);
    expect(existsSync(worktree!.path)).toBe(false);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    let recovered: number;
    try {
      recovered = await reconcileInterruptedReviewVerdicts(board, registry, runViaBun);
    } finally {
      console.error = originalError;
    }

    expect(recovered).toBe(0);
    expect((await board.get(implementer.id))!.status).toBe("pending-review");
    expect(errors.some((line) => line.includes(implementer.id) && line.includes("unresolved"))).toBe(true);
  } finally {
    await cleanup(repo);
  }
});
