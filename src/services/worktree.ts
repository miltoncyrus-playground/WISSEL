import { existsSync, mkdirSync, symlinkSync } from "node:fs";
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

function branchName(worktreeKey: string): string {
  return `wissel/${worktreeKey}`;
}

/**
 * Creates an isolated git worktree on its own branch off the repo's
 * current HEAD, under `~/.wissel/worktrees/<worktreeKey>` — deliberately
 * outside any repo directory, mirroring the existing
 * `~/.wissel/board.sqlite` convention. Exists so a write-tier subprocess
 * never edits `task.repo`'s own live working tree directly: when `repo`
 * is wissel's own source (a self-hosted task), that tree is also what
 * `bun run dev`'s `--watch` restarts the server on, and an in-place edit
 * was confirmed live to orphan the in-flight subprocess mid-run — see
 * docs/SDD-worktree-isolation.md.
 *
 * `worktreeKey` is normally just the task id — one worktree per task.
 * The one deliberate exception: a write-tier task that's a pushback
 * re-attempt in a review lineage (TaskCard.reviewLineageId set) passes
 * the *lineage* id instead, so every re-attempt after a
 * `changes_requested` verdict lands back in the exact same worktree/
 * branch the reviewer just looked at, instead of a fresh one off HEAD
 * that would lose the very diff under review. See
 * WriteExecutor.run/CodexWriteExecutor.run, the only callers.
 *
 * Idempotent: if the worktree already exists (a retried task via
 * `POST /tasks/:id/run`, or exactly this lineage-reuse case), reuses it
 * instead of failing — `git worktree add` on an already-existing
 * path/branch would otherwise error every time, and both a retry and a
 * pushback re-attempt are exactly the cases that need this most.
 *
 * Also symlinks the source repo's own `node_modules` into the new
 * worktree, when there is one — see `linkNodeModules` below for why:
 * without it, every implementer/reviewer/integrator pass on the same
 * subtask paid for its own `bun install` before it could run anything.
 */
export async function createTaskWorktree(repo: string, worktreeKey: string, opts: WorktreeOptions): Promise<TaskWorktree | { error: string }> {
  const root = worktreesRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, worktreeKey);
  const branch = branchName(worktreeKey);

  const existing = await opts.runner(["git", "worktree", "list", "--porcelain"], { cwd: repo });
  if (existing.exitCode === 0 && existing.stdout.includes(`worktree ${path}`)) {
    linkNodeModules(repo, path);
    return { path, branch };
  }

  const result = await opts.runner(["git", "worktree", "add", "-b", branch, path, "HEAD"], { cwd: repo });
  if (result.exitCode !== 0) {
    return { error: `failed to create worktree for ${worktreeKey}: ${(result.stderr || result.stdout).trim()}` };
  }
  linkNodeModules(repo, path);
  return { path, branch };
}

/**
 * Symlinks the source repo's own `node_modules` into a freshly created
 * worktree, when the repo has one and the worktree doesn't already —
 * `git worktree add` never populates `node_modules` (gitignored, never
 * part of what a checkout brings along), so every implementer/reviewer/
 * integrator pass that needed to run anything had to `bun install`
 * first, on every single subtask, every time — confirmed live, directly
 * in this project's own real reviewer output ("Ran bun install
 * (node_modules was missing in this worktree — pre-existing gap,
 * unrelated to this diff)"), repeated across nearly every subtask this
 * project's own review-handoff feature went through. Pure avoidable
 * cost: the dependency tree doesn't change between subtasks, only the
 * source files being reviewed do.
 *
 * Silently skipped, never an error, when the repo has no `node_modules`
 * of its own (not every `task.repo` is a Node/Bun project) — this is a
 * convenience, not a contract any caller depends on. Never overwrites
 * anything already at that path in the worktree (a real directory from
 * a worktree that ran its own `bun install` anyway, or an existing
 * symlink from a prior call) — `existsSync` follows symlinks, so a
 * live, working symlink already in place is left alone rather than
 * needlessly recreated.
 */
function linkNodeModules(repo: string, worktreePath: string): void {
  const source = join(repo, "node_modules");
  const target = join(worktreePath, "node_modules");
  if (!existsSync(source) || existsSync(target)) return;
  try {
    symlinkSync(source, target, "dir");
  } catch {
    // Best-effort — a worktree without node_modules still works, it
    // just needs its own `bun install` the way it always has.
  }
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
