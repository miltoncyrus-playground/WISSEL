import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { worktreeHasChanges } from "../src/services/worktree.ts";
import { closeReport } from "../src/services/board-actions.ts";
import { SqliteBoard } from "../src/services/board.ts";

// worktreeHasChanges and POST /tasks/:id/close: a review report's
// worktree holds nothing, so Needs you offers Close instead of Merge.

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** A repo on main plus a worktree on its own branch, like a card's. */
async function repoWithWorktree(): Promise<{ dir: string; repo: string; wt: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-close-report-"));
  const repo = join(dir, "repo");
  const wt = join(dir, "wt");
  await git(dir, "init", "-q", "-b", "main", repo);
  await git(repo, "config", "user.email", "t@example.invalid");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "worktree", "add", "-q", "-b", "wissel/card", wt);
  return { dir, repo, wt };
}

test("worktreeHasChanges: false only when nothing is uncommitted, untracked or committed past the base", async () => {
  const { dir, wt } = await repoWithWorktree();
  try {
    expect(await worktreeHasChanges(runViaBun, wt, "main")).toBe(false);
    // No base: an empty tree can't be told from committed work.
    expect(await worktreeHasChanges(runViaBun, wt, undefined)).toBeUndefined();
    expect(await worktreeHasChanges(runViaBun, wt, "no-such-branch")).toBeUndefined();

    writeFileSync(join(wt, "new.txt"), "x\n");
    expect(await worktreeHasChanges(runViaBun, wt, "main")).toBe(true);
    expect(await worktreeHasChanges(runViaBun, wt, undefined)).toBe(true);

    await git(wt, "add", "-A");
    await git(wt, "commit", "-q", "-m", "work");
    expect(await worktreeHasChanges(runViaBun, wt, "main")).toBe(true);
    expect(await worktreeHasChanges(runViaBun, join(dir, "nowhere"), "main")).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("closeReport closes an empty worktree's card and refuses one with changes", async () => {
  const { dir, repo, wt } = await repoWithWorktree();
  try {
    const board = new SqliteBoard();
    const report = await board.create({ title: "Review: PR 1", body: "", labels: [], repo, mergeTarget: "main" });
    await board.move(report.id, "review");
    await board.recordResult({ taskId: report.id, agentId: "fixer", ok: true, summary: "VERDICT: PASS", worktree: { path: wt, branch: "wissel/card" } });

    writeFileSync(join(wt, "stray.txt"), "x\n");
    const refused = await closeReport(board, report.id, runViaBun);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect((await board.get(report.id))!.status).toBe("review");

    await rm(join(wt, "stray.txt"));
    const closed = await closeReport(board, report.id, runViaBun);
    expect(closed.ok).toBe(true);
    expect((await board.get(report.id))!.status).toBe("done");
    expect(existsSync(wt)).toBe(false);

    const notReview = await closeReport(board, report.id, runViaBun);
    expect(notReview).toMatchObject({ ok: false, status: 409 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
