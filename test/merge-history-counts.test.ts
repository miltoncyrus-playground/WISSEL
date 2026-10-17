// The merge path changed how a card lands (a landing commit built in the
// object store, then a fast-forward) but not what history says: one
// `Merge wissel/<id>: <title>` merge commit per card, first parent the
// repo's previous HEAD. The digest, the streak and Wrapped read exactly
// that, so their numbers must come out identical to the old path's
// (`git merge --no-ff <branch>` in the user's checkout) for the same
// fixture: some cards landing on an unmoved HEAD, one after a human
// commit moved it.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { buildWisselDigest } from "../src/services/wissel-digest.ts";
import { readStreak } from "../src/services/streaks.ts";
import { buildWrapped } from "../src/services/wrapped.ts";
import { createTaskWorktree, landingCommitMessage, mergeTaskWorktree, type TaskWorktree } from "../src/services/worktree.ts";
import type { TaskCard } from "../src/core/types.ts";

const root = mkdtempSync(join(tmpdir(), "wissel-merge-counts-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

type Shape = "old" | "new";

/** The pre-2026-10-17 merge path, verbatim: commit in the worktree, then
 *  `git merge --no-ff` in the user's checkout, then cleanup. */
function oldMerge(repo: string, wt: TaskWorktree, task: TaskCard): void {
  git(["add", "-A"], wt.path);
  git(["commit", "-q", "-m", `${task.title}\n\ntask: ${task.id}`], wt.path);
  git(["merge", "-q", "--no-ff", wt.branch, "-m", landingCommitMessage(wt, task)], repo);
  git(["worktree", "remove", "--force", wt.path], repo);
  git(["branch", "-D", wt.branch], repo);
}

async function world(shape: Shape) {
  const dir = join(root, shape);
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@example.com"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "shared.txt"), "1\n2\n3\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "start"], repo);
  const board = new SqliteBoard();
  const worktreesRoot = join(home, ".wissel", "worktrees");

  const land = async (title: string, files: Record<string, string>, before?: () => void) => {
    const task = await board.create({ title, body: "", labels: ["code"], repo });
    const wt = await createTaskWorktree(repo, task.id, { runner: runViaBun, homeDir: home });
    if ("error" in wt) throw new Error(wt.error);
    for (const [f, c] of Object.entries(files)) writeFileSync(join(wt.path, f), c);
    await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "ok", worktree: wt });
    before?.();
    if (shape === "old") oldMerge(repo, wt, task);
    else {
      const res = await mergeTaskWorktree(repo, wt, task, runViaBun);
      if (!res.ok) throw new Error(`${title}: ${res.message}`);
    }
    await board.move(task.id, "done");
    return { task, wt };
  };

  // Lands on an unmoved HEAD.
  await land("Card one", { "one.txt": "1\n" });
  // A human commits first: the landing merges a moved HEAD.
  await land("Card two", { "two.txt": "2\n" }, () => {
    writeFileSync(join(repo, "human.txt"), "h\n");
    git(["add", "human.txt"], repo);
    git(["commit", "-q", "-m", "human work"], repo);
  });
  // Two in a row on the same file region, non-conflicting lines.
  await land("Card three", { "shared.txt": "1 three\n2\n3\n" });
  await land("Card four", { "four.txt": "4\n", "notes.md": "# four\n" });

  return { board, repo, worktreesRoot };
}

test("digest merges/commits/stories, the streak and Wrapped's cards-merged are identical for the old and new merge shapes", async () => {
  const now = new Date(Date.now() + 60_000);
  const results: Record<Shape, unknown> = { old: undefined, new: undefined };
  const shapes: Record<Shape, { subjects: string[]; firstParents: string }> = { old: { subjects: [], firstParents: "" }, new: { subjects: [], firstParents: "" } };

  for (const shape of ["old", "new"] as Shape[]) {
    const { board, repo, worktreesRoot } = await world(shape);
    const digest = await buildWisselDigest({ board, runner: runViaBun, now, input: "last 7 days", worktreesRoot });
    const streak = await readStreak({ cards: await board.list(), runner: runViaBun, now, worktreesRoot });
    const wrapped = await buildWrapped({ board, pipelines: new SqlitePipelineStore(board.db), runner: runViaBun, worktreesRoot }, "last 7 days", now);
    results[shape] = {
      merges: digest.stats.merges,
      commits: digest.stats.commits,
      done: digest.stats.done,
      cards: digest.stats.cards,
      stories: digest.stories.length,
      streak,
      cardsMerged: wrapped.cardsMerged,
      wrappedCommits: wrapped.commits,
    };
    shapes[shape].subjects = git(["log", "--merges", "--format=%s"], repo)
      .split("\n")
      .map((s) => s.replace(/wissel\/[0-9a-f-]+/, "wissel/<id>"));
    // Every landing's first parent is the previous main commit: the
    // first-parent line is one commit per card plus the human's.
    shapes[shape].firstParents = git(["log", "--first-parent", "--format=%s", "HEAD"], repo).replace(/wissel\/[0-9a-f-]+/g, "wissel/<id>");
  }

  expect(results.new).toEqual(results.old);
  expect((results.new as { merges: number }).merges).toBe(4);
  expect((results.new as { cardsMerged: number }).cardsMerged).toBe(4);
  expect(shapes.new.subjects).toEqual(shapes.old.subjects);
  expect(shapes.new.firstParents).toEqual(shapes.old.firstParents);
});

test("the digest counts merge attempts by outcome from the merge path's telemetry, in the window only", async () => {
  const now = new Date("2026-10-17T12:00:00Z");
  const telemetryPath = join(root, "telemetry.jsonl");
  const ev = (outcome: string, at: string) => JSON.stringify({ type: "merge", taskId: "t", repo: "/r", branch: "wissel/t", outcome, gate: "passed", gateRuns: [], gateMs: 0, lockWaitMs: 0, lockHoldMs: 0, at });
  writeFileSync(
    telemetryPath,
    [
      ev("landed", "2026-10-16T10:00:00Z"),
      ev("landed", "2026-10-16T11:00:00Z"),
      ev("gate-failed", "2026-10-16T12:00:00Z"),
      ev("conflict", "2026-10-15T12:00:00Z"),
      ev("blocked-local-changes", "2026-10-15T13:00:00Z"),
      ev("head-moved", "2026-10-15T14:00:00Z"),
      ev("error", "2026-10-15T15:00:00Z"),
      ev("landed", "2026-09-01T00:00:00Z"), // outside the window
      "not json",
    ].join("\n") + "\n",
  );

  const digest = await buildWisselDigest({ board: new SqliteBoard(), runner: runViaBun, now, input: "last 7 days", telemetryPath, worktreesRoot: join(root, "none") });

  expect(digest.stats.mergeAttempts).toEqual({ total: 7, landed: 2, gateFailed: 1, conflict: 1, blockedLocalChanges: 1, headMoved: 1, error: 1 });
});
