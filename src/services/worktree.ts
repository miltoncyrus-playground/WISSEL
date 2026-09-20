import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { TaskCard } from "../core/types.ts";

export interface TaskWorktree {
  path: string;
  branch: string;
}

export interface WorktreeOptions {
  runner: CommandRunner;
  /** Injectable so tests never touch the real filesystem or $HOME. */
  homeDir?: string;
}

function worktreesRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".wissel", "worktrees");
}

function branchName(taskId: string): string {
  return `wissel/${taskId}`;
}

/**
 * Creates an isolated git worktree for a write-tier task, on its own
 * branch off the repo's current HEAD, under `~/.wissel/worktrees/<taskId>`
 * — deliberately outside any repo directory, mirroring the existing
 * `~/.wissel/board.sqlite` convention. Exists so a write-tier subprocess
 * never edits `task.repo`'s own live working tree directly: when `repo`
 * is wissel's own source (a self-hosted task), that tree is also what
 * `bun run dev`'s `--watch` restarts the server on, and an in-place edit
 * was confirmed live to orphan the in-flight subprocess mid-run — see
 * docs/SDD-worktree-isolation.md.
 *
 * Idempotent: if the worktree already exists (a retried task via
 * `POST /tasks/:id/run`), reuses it instead of failing — `git worktree
 * add` on an already-existing path/branch would otherwise error on every
 * retry, and a retry is exactly the case that needs this most.
 */
export async function createTaskWorktree(repo: string, taskId: string, opts: WorktreeOptions): Promise<TaskWorktree | { error: string }> {
  const root = worktreesRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, taskId);
  const branch = branchName(taskId);

  const existing = await opts.runner(["git", "worktree", "list", "--porcelain"], { cwd: repo });
  if (existing.exitCode === 0 && existing.stdout.includes(`worktree ${path}`)) {
    return { path, branch };
  }

  const result = await opts.runner(["git", "worktree", "add", "-b", branch, path, "HEAD"], { cwd: repo });
  if (result.exitCode !== 0) {
    return { error: `failed to create worktree for task ${taskId}: ${(result.stderr || result.stdout).trim()}` };
  }
  return { path, branch };
}

/**
 * Removes a task's worktree and its branch, discarding whatever's in it
 * — used by the board's Discard action, and by `mergeTaskWorktree` once
 * a merge lands. Never throws: a worktree that's already gone (a
 * double-discard, manual cleanup) isn't an error here, it's the end
 * state this function exists to reach either way.
 */
export async function removeTaskWorktree(repo: string, worktree: TaskWorktree, runner: CommandRunner): Promise<void> {
  await runner(["git", "worktree", "remove", "--force", worktree.path], { cwd: repo });
  await runner(["git", "branch", "-D", worktree.branch], { cwd: repo });
}

/**
 * Commits whatever the subprocess left in the worktree (if anything —
 * a no-op when it's clean) and merges that branch into whatever's
 * currently checked out in `repo`, then removes the worktree. The only
 * place a worktree's changes ever reach the live repo — always this one
 * explicit, human-triggered call (the board's Merge action), never
 * automatic. Committing happens here, not right after the run, so
 * `GET /tasks/:id/diff` can keep reading the worktree as plain
 * uncommitted changes via the existing `getRepoDiff` — identical to how
 * it already reads task.repo for a non-worktree run, no special-casing
 * needed there.
 */
export async function mergeTaskWorktree(
  repo: string,
  worktree: TaskWorktree,
  task: TaskCard,
  runner: CommandRunner,
): Promise<{ ok: boolean; message: string }> {
  const status = await runner(["git", "status", "--porcelain"], { cwd: worktree.path });
  if (status.stdout.trim()) {
    await runner(["git", "add", "-A"], { cwd: worktree.path });
    const commit = await runner(["git", "commit", "-m", `${task.title}\n\ntask: ${task.id}`], { cwd: worktree.path });
    if (commit.exitCode !== 0) {
      return { ok: false, message: `failed to commit worktree changes: ${(commit.stderr || commit.stdout).trim()}` };
    }
  }

  const merge = await runner(["git", "merge", "--no-ff", worktree.branch, "-m", `Merge ${worktree.branch}: ${task.title}`], { cwd: repo });
  if (merge.exitCode !== 0) {
    return { ok: false, message: (merge.stderr || merge.stdout).trim() || "merge failed" };
  }

  await removeTaskWorktree(repo, worktree, runner);
  return { ok: true, message: `merged ${worktree.branch} into ${repo}` };
}
