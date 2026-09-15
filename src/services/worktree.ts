import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Worktree lifecycle. Resolves the ORIGIN repo path, never the worktree
 * path — this is what keeps per-repo memory scoping correct.
 *
 * The git plumbing (branch/create/remove) is ported from agetor's
 * `worktree.ts`. Deliberately dropped from that port: agetor's collision
 * recovery for branch names (`ensureUniqueBranch`) existed because its
 * branch names are derived from human-typed task titles, which can
 * collide; wissel's `taskId` is already a UUID from `SqliteBoard`, so a
 * branch named after it can't collide and the recovery path has nothing
 * to do. Also dropped: agetor's idempotent "reuse an existing worktree"
 * path — wissel's `create()` always makes a fresh one, matching its
 * simpler one-shot interface.
 */
export interface WorktreeHandle {
  id: string;
  path: string;
  originRepo: string;
  branch: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const GIT_TIMEOUT_MS = 30_000;

/** Thin `git` wrapper. Never throws for a non-zero exit — `ok` reflects
 *  that — but CAN throw synchronously via Bun.spawn if `git` isn't on
 *  PATH or `cwd` doesn't exist; callers that need a true non-throwing
 *  contract wrap their own call. A hard kill after `timeoutMs` stops a
 *  hung credential prompt from blocking wissel indefinitely. */
async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } finally {
    clearTimeout(timer);
  }
}

async function repoRoot(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const res = await git(["rev-parse", "--show-toplevel"], dir);
  return res.ok ? res.stdout : null;
}

async function hasUncommittedChanges(dir: string): Promise<boolean | null> {
  if (!existsSync(dir)) return null;
  const res = await git(["status", "--porcelain"], dir);
  if (!res.ok) return null;
  return res.stdout.length > 0;
}

async function resolveDefaultBranchRef(dir: string): Promise<string | null> {
  const originHead = await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], dir);
  if (originHead.ok && originHead.stdout.length > 0 && originHead.stdout !== "origin/HEAD") {
    return originHead.stdout;
  }
  for (const candidate of ["main", "master"]) {
    const ref = await git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], dir);
    if (ref.ok) return candidate;
  }
  return null;
}

/**
 * Whether `dir`'s HEAD is an ancestor of the origin repo's default branch —
 * i.e. already landed, so the worktree is safe to discard. `null` means
 * "couldn't determine" and must never be treated as merged.
 *
 * This is the safety check `gc()` actually needs, not a push-based ahead
 * count: `create()` never configures a remote upstream for the branches it
 * makes, so "has this been pushed" isn't a meaningful question for a
 * wissel-managed branch — "has this landed on the trunk" is, and it's
 * answerable purely locally via merge-base.
 */
async function isMergedIntoDefaultBranch(dir: string): Promise<boolean | null> {
  if (!existsSync(dir)) return null;
  const defaultBranch = await resolveDefaultBranchRef(dir);
  if (!defaultBranch || defaultBranch.startsWith("-")) return null;
  const res = await git(["merge-base", "--is-ancestor", "HEAD", defaultBranch], dir);
  if (res.exitCode === 0) return true;
  if (res.exitCode === 1) return false;
  return null;
}

function branchName(taskId: string): string {
  return `wissel/${taskId}`;
}

/** Best-effort parse of a linked worktree's `.git` pointer file (`gitdir:
 *  <repo>/.git/worktrees/<id>`) to recover the origin repo for a worktree
 *  directory with no in-memory handle — the case `gc()` is in, since
 *  handles aren't persisted between process restarts. Plain fs, no git
 *  subprocess. */
function originRepoFromGitPointer(worktreeDir: string): string | null {
  try {
    const contents = readFileSync(path.join(worktreeDir, ".git"), "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(contents);
    if (!match) return null;
    const gitdir = match[1]!;
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const idx = gitdir.indexOf(marker);
    return idx < 0 ? null : gitdir.slice(0, idx);
  } catch {
    return null;
  }
}

export class WorktreeService {
  constructor(private root: string) {}

  async create(repo: string, taskId: string): Promise<WorktreeHandle> {
    const originRepo = await repoRoot(repo);
    if (!originRepo) throw new Error(`create: "${repo}" is not inside a git repo`);

    await mkdir(this.root, { recursive: true });
    const worktreePath = path.join(this.root, taskId);
    const branch = branchName(taskId);

    // Prune first: git refuses `worktree add` on a path it still tracks as
    // a missing-but-registered worktree without this.
    await git(["worktree", "prune"], originRepo, 10_000);
    const created = await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], originRepo);
    if (!created.ok) {
      throw new Error(`worktree creation failed: ${created.stderr || created.stdout}`);
    }

    return { id: taskId, path: worktreePath, originRepo, branch };
  }

  async destroy(handle: WorktreeHandle): Promise<void> {
    await git(["worktree", "remove", "--force", handle.path], handle.originRepo);
    await git(["branch", "-D", handle.branch], handle.originRepo);
    // Clears any stale .git/worktrees/<id>/ registration a partial remove
    // (e.g. the dir was deleted out from under git) left behind.
    await git(["worktree", "prune"], handle.originRepo, 10_000);

    // Only ever rm -rf a path inside our own owned root — never trust
    // handle.path blindly, since a bug upstream could otherwise turn this
    // into an arbitrary-directory delete.
    const ownedPrefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (handle.path.startsWith(ownedPrefix) && existsSync(handle.path)) {
      await rm(handle.path, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Remove worktrees with no live session and no unpushed work.
   *
   * The "no live session" half is the caller's to prove: this service has
   * no visibility into `SessionSupervisor` (that's a separate concern per
   * its own constructor), so `gc()` takes the set of worktree ids the
   * caller currently considers live and never touches those. The "no
   * unpushed work" half is checked here directly against git.
   */
  async gc(liveIds: Iterable<string> = []): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const live = new Set(liveIds);
    const removed: string[] = [];

    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || live.has(entry.name)) continue;
      const worktreePath = path.join(this.root, entry.name);
      const originRepo = originRepoFromGitPointer(worktreePath);
      if (!originRepo) continue; // not a worktree we recognize — leave it alone

      const [dirty, merged] = await Promise.all([hasUncommittedChanges(worktreePath), isMergedIntoDefaultBranch(worktreePath)]);
      // Only remove when we can positively confirm both: clean (dirty ===
      // false, not null-unknown) and landed (merged === true). Any
      // "couldn't tell" collapses to "leave it" — never guess a task's
      // work is disposable.
      if (dirty !== false || merged !== true) continue;

      const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath, 5_000);
      await git(["worktree", "remove", "--force", worktreePath], originRepo);
      if (branch.ok) await git(["branch", "-D", branch.stdout], originRepo);
      await git(["worktree", "prune"], originRepo, 10_000);
      if (existsSync(worktreePath)) await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      removed.push(entry.name);
    }

    return removed;
  }
}
