import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { TaskCard } from "../core/types.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { withRepoLock } from "./repo-lock.ts";
import { runMergeGate, type GateCommandRunner, type GateReport, type MergeGateConfig, type MergeGateResolver } from "./merge-gate.ts";

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

/** Where a write-tier run of `task` works: the same `reviewLineageId ??
 *  id` key WriteExecutor/CodexWriteExecutor pass to createTaskWorktree.
 *  Used by crash recovery to find a still-live orphan in that directory. */
export function taskWorktreePath(task: Pick<TaskCard, "id" | "reviewLineageId">, homeDir?: string): string {
  return join(worktreesRoot(homeDir), task.reviewLineageId ?? task.id);
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
export function linkNodeModules(repo: string, worktreePath: string): void {
  linkOne(join(repo, "node_modules"), join(worktreePath, "node_modules"));
  // Nested packages too (wissel's own app/ and pipeline-editor/): their
  // tests run under the root `bun test`, so a worktree missing
  // app/node_modules failed the merge gate on every card (2026-10-17:
  // app/test/feed.test.ts, "Cannot find module 'react/jsx-dev-runtime'").
  let entries: string[];
  try {
    entries = readdirSync(repo, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return;
  }
  for (const dir of entries) {
    if (!existsSync(join(worktreePath, dir))) continue; // not part of the checkout
    linkOne(join(repo, dir, "node_modules"), join(worktreePath, dir, "node_modules"));
  }
}

function linkOne(source: string, target: string): void {
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

/** Every way one merge attempt can end. Only `landed` reached the
 *  user's checkout; nothing else touched it. */
export type MergeOutcome = "landed" | "gate-failed" | "conflict" | "blocked-local-changes" | "head-moved" | "error";

export interface MergeResult {
  ok: boolean;
  outcome: MergeOutcome;
  message: string;
  /** The commit `repo`'s HEAD fast-forwarded to. Set only when landed. */
  mergedSha?: string;
  gate: GateReport;
  /** Uncommitted files in `repo` that the landing would overwrite. Set
   *  only on blocked-local-changes. */
  blockedFiles?: string[];
  lockWaitMs: number;
  lockHoldMs: number;
}

/** Where the merge path's telemetry goes (TelemetryLog in production). */
export interface MergeTelemetry {
  record(event: TelemetryEvent): Promise<void>;
}

/** Everything the merge path needs besides the task itself. Built once
 *  in createApp (src/api/server.ts) and handed to every caller: the
 *  orchestrator's auto-merge, the board's Merge button, Ask's merge. A
 *  bare CommandRunner still works and means: no gate, no telemetry. */
export interface MergeContext {
  runner: CommandRunner;
  /** The repo's gate (Project.mergeGate); absent means none. */
  gateFor?: MergeGateResolver;
  gateRunner?: GateCommandRunner;
  telemetry?: MergeTelemetry;
  /** Test seam: runs after the gate passes, right before the HEAD
   *  check that guards landing. */
  beforeLand?: () => Promise<void>;
}

export function toMergeContext(m: CommandRunner | MergeContext): MergeContext {
  return typeof m === "function" ? { runner: m } : m;
}

/** The subject of the commit that lands a card: `Merge <branch>:
 *  <title>`. The digest, streaks and Wrapped count landed cards by it
 *  (wissel-digest.ts MERGE_SUBJECT); keep it exactly this shape. */
export function landingCommitMessage(worktree: TaskWorktree, task: Pick<TaskCard, "title">): string {
  return `Merge ${worktree.branch}: ${task.title}`;
}

const NO_GATE: GateReport = { status: "none", runs: [], durationMs: 0 };

/**
 * The merge path: the only place a worktree's changes reach the user's
 * checkout (`repo`). Called by the board's Merge button, Ask's merge,
 * and the orchestrator's auto-merge. Four rules, each from a real
 * failure (docs/SDD-worktree-isolation.md §7):
 *
 * 1. **Gate in the worktree.** The landing commit (`Merge <branch>:
 *    <title>`, parents [repo HEAD, branch tip], the same shape `git merge
 *    --no-ff <branch>` in `repo` always made) is built from git objects
 *    alone: `git merge-tree --write-tree` for the merged tree, `git
 *    commit-tree` for the commit. The worktree is then checked out at
 *    that commit, detached, and the repo's gate commands run there. Any
 *    failure stops here; the branch itself is never moved.
 * 2. **Fast-forward only into `repo`.** After the gate passes: HEAD must
 *    still be the commit the landing was built on (a human may have
 *    committed meanwhile — then the whole thing runs once more against
 *    the new HEAD, and a second miss fails as `head-moved`), no
 *    uncommitted file in `repo` may be one the landing changes
 *    (`blocked-local-changes`, listed), and then `git merge --ff-only`.
 *    No merge ever runs in the user's checkout, so a conflict can never
 *    leave MERGE_HEAD there, and nothing here can discard local edits:
 *    no `merge --abort`, no `reset`, no `checkout -f`, anywhere.
 * 3. **One merge per repo at a time** (withRepoLock), from the first git
 *    call through cleanup.
 * 4. **The landed sha is recorded** through `onLanded`, before cleanup,
 *    so crash recovery reads it instead of guessing from the commit log.
 *
 * A conflict merging `repo`'s HEAD into the branch is left in the
 * worktree, on the branch, with the landing message waiting in
 * MERGE_MSG: resolving it and `git commit --no-edit` there produces the
 * landing commit itself, and the next merge lands it as is. A worktree
 * with an unfinished merge is refused rather than committed as-is.
 *
 * Committing the worktree's uncommitted changes still happens here, not
 * right after the run, so `GET /tasks/:id/diff` keeps reading the
 * worktree as plain uncommitted changes (getRepoDiff).
 *
 * Emits one `merge` telemetry event per call, whatever the outcome.
 */
export async function mergeTaskWorktree(
  repo: string,
  worktree: TaskWorktree,
  task: TaskCard,
  context: CommandRunner | MergeContext,
  onLanded?: (sha: string) => Promise<void>,
): Promise<MergeResult> {
  const ctx = toMergeContext(context);
  const result = await withRepoLock(repo, async ({ waitMs }) => {
    const start = performance.now();
    let r: Unlocked;
    try {
      r = await mergeLocked(repo, worktree, task, ctx, onLanded);
    } catch (e) {
      // A runner that throws (a repo path gone from disk) is still one
      // attempt with an answer, and still gets its telemetry event.
      r = { ok: false, outcome: "error", message: `merge failed: ${(e as Error).message}`, gate: NO_GATE };
    }
    return { ...r, lockWaitMs: waitMs, lockHoldMs: Math.round(performance.now() - start) };
  });
  await ctx.telemetry
    ?.record({
      type: "merge",
      taskId: task.id,
      repo,
      branch: worktree.branch,
      outcome: result.outcome,
      gate: result.gate.status,
      gateRuns: result.gate.runs,
      gateMs: result.gate.durationMs,
      lockWaitMs: result.lockWaitMs,
      lockHoldMs: result.lockHoldMs,
      ...(result.mergedSha ? { landedSha: result.mergedSha } : {}),
      ...(result.blockedFiles ? { blockedFiles: result.blockedFiles } : {}),
      ...(result.ok ? {} : { message: result.message.slice(0, 500) }),
    })
    .catch((e) => console.error(`merge: telemetry write failed for ${task.id}: ${(e as Error).message}`));
  return result;
}

type Unlocked = Omit<MergeResult, "lockWaitMs" | "lockHoldMs">;

async function mergeLocked(
  repo: string,
  worktree: TaskWorktree,
  task: TaskCard,
  ctx: MergeContext,
  onLanded?: (sha: string) => Promise<void>,
): Promise<Unlocked> {
  const git = gitIn(ctx.runner);
  const fail = (outcome: MergeOutcome, message: string, gate: GateReport = NO_GATE, extra: Partial<Unlocked> = {}): Unlocked => ({
    ok: false,
    outcome,
    message,
    gate,
    ...extra,
  });

  // Gone already: a second Merge that waited on the lock behind the one
  // that landed it, or a Discard.
  if (!existsSync(worktree.path)) {
    return fail("error", `the worktree ${worktree.path} is gone: this card was already merged or discarded`);
  }

  // An unfinished merge in the worktree (a conflict from an earlier
  // attempt, not yet resolved): committing it now would commit the
  // conflict markers.
  if ((await git(worktree.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok) {
    return fail(
      "conflict",
      `${worktree.path} has an unfinished merge of ${repo}'s HEAD into ${worktree.branch}. Resolve the conflicts there, then \`git commit --no-edit\`, then merge again.`,
    );
  }

  const status = await git(worktree.path, ["status", "--porcelain"]);
  if (status.stdout.trim()) {
    await git(worktree.path, ["add", "-A"]);
    const commit = await git(worktree.path, ["commit", "-m", `${task.title}\n\ntask: ${task.id}`]);
    if (!commit.ok) return fail("error", `failed to commit worktree changes: ${commit.text}`);
  }

  let gateConfig: MergeGateConfig | undefined;
  try {
    gateConfig = await ctx.gateFor?.(repo);
  } catch (e) {
    return fail("error", `couldn't read the merge gate for ${repo}: ${(e as Error).message}`);
  }

  const message = landingCommitMessage(worktree, task);
  const tipRes = await git(repo, ["rev-parse", "--verify", `refs/heads/${worktree.branch}^{commit}`]);
  if (!tipRes.ok) return fail("error", `branch ${worktree.branch} not found in ${repo}: ${tipRes.text}`);
  let tip = tipRes.stdout.trim();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const baseRes = await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!baseRes.ok) return fail("error", `can't read ${repo}'s HEAD: ${baseRes.text}`);
    const base = baseRes.stdout.trim();

    // Nothing on the branch that HEAD doesn't already have.
    if (await isAncestor(git, repo, tip, base)) {
      return land(repo, worktree, ctx, base, { status: "skipped", runs: [], durationMs: 0 }, onLanded, `nothing to land: ${repo} already has everything on ${worktree.branch}`);
    }

    const plan = await buildLandingCommit(git, repo, worktree, base, tip, message);
    if (plan.kind === "error") return fail("error", plan.message);
    if (plan.kind === "conflict") return fail("conflict", plan.message);
    if (plan.kind === "resolved") {
      // The conflict merge resolved on its own after all; the branch tip
      // is now the landing commit.
      tip = plan.tip;
      attempt--;
      continue;
    }
    const landing = plan.sha;

    let gate: GateReport = NO_GATE;
    if (gateConfig && gateConfig.commands.length > 0) {
      const detach = await git(worktree.path, ["checkout", "--detach", "-q", landing]);
      if (!detach.ok) return fail("error", `couldn't check out the landing commit in ${worktree.path} to run the merge gate: ${detach.text}`);
      linkNodeModules(repo, worktree.path);
      try {
        gate = await runMergeGate(gateConfig, worktree.path, ctx.gateRunner);
      } finally {
        // Back onto the branch, pass or fail: a pushback attempt picks up
        // where the branch was, and landing below uses the sha, not the
        // worktree. Plain checkout: refuses rather than overwrite.
        const back = await git(worktree.path, ["checkout", "-q", worktree.branch]);
        if (!back.ok) console.error(`merge: couldn't switch ${worktree.path} back to ${worktree.branch}: ${back.text}`);
      }
      if (gate.status === "failed") return fail("gate-failed", gate.feedback ?? "merge gate failed", gate);
    }

    await ctx.beforeLand?.();

    const headNow = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (headNow !== base) {
      if (attempt === 1) continue;
      return fail(
        "head-moved",
        `${repo}'s HEAD moved twice while this merge was being checked (${short(base)} -> ${short(headNow)}); nothing landed. Merge again when the repo is quiet.`,
        gate,
      );
    }

    // ff-only would refuse these anyway; checking first names every file,
    // tracked or not, and keeps the refusal readable.
    const blocked = await overlappingLocalChanges(git, repo, base, landing);
    if (blocked.length > 0) return blockedResult(repo, blocked, gate);

    const ff = await git(repo, ["merge", "--ff-only", "-q", landing]);
    if (!ff.ok) {
      const files = parseOverwrittenFiles(ff.text);
      if (files.length > 0) return blockedResult(repo, files, gate);
      if (/not possible to fast-forward/i.test(ff.text)) {
        if (attempt === 1) continue;
        return fail("head-moved", `${repo}'s HEAD moved while landing; nothing landed. Merge again when the repo is quiet.`, gate);
      }
      return fail("error", `fast-forward of ${repo} to ${short(landing)} failed: ${ff.text}`, gate);
    }

    const landedHead = (await git(repo, ["rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (landedHead !== landing) {
      return fail("error", `fast-forward reported success but ${repo}'s HEAD is ${short(landedHead)}, not ${short(landing)}`, gate);
    }
    const gateNote = gate.status === "passed" ? ` (gate passed in ${Math.round(gate.durationMs / 1000)}s)` : gate.status === "none" ? " (no merge gate configured)" : "";
    return land(repo, worktree, ctx, landing, gate, onLanded, `landed ${worktree.branch} on ${repo} at ${short(landing)}${gateNote}`);
  }
  // Unreachable: every iteration returns or continues at most once.
  return fail("head-moved", `${repo}'s HEAD kept moving; nothing landed`);
}

async function land(
  repo: string,
  worktree: TaskWorktree,
  ctx: MergeContext,
  sha: string,
  gate: GateReport,
  onLanded: ((sha: string) => Promise<void>) | undefined,
  message: string,
): Promise<Unlocked> {
  // Recorded before cleanup: a crash between the two leaves a card
  // crash recovery can prove merged from the sha alone.
  try {
    await onLanded?.(sha);
  } catch (e) {
    console.error(`merge: landed ${short(sha)} but couldn't record it: ${(e as Error).message}`);
  }
  await removeTaskWorktree(repo, worktree, ctx.runner);
  return { ok: true, outcome: "landed", message, mergedSha: sha, gate };
}

function blockedResult(repo: string, files: string[], gate: GateReport): Unlocked {
  return {
    ok: false,
    outcome: "blocked-local-changes",
    message: `blocked by uncommitted local changes in: ${files.join(", ")}. Commit or move those edits in ${repo}, then merge again. Nothing landed and your edits are untouched.`,
    gate,
    blockedFiles: files,
  };
}

type Git = (cwd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; text: string }>;

function gitIn(runner: CommandRunner): Git {
  return async (cwd, args) => {
    const r = await runner(["git", ...args], { cwd });
    return { ok: r.exitCode === 0, stdout: r.stdout, text: (r.stderr || r.stdout).trim() };
  };
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

async function isAncestor(git: Git, repo: string, a: string, b: string): Promise<boolean> {
  return (await git(repo, ["merge-base", "--is-ancestor", a, b])).ok;
}

type LandingPlan = { kind: "commit"; sha: string } | { kind: "conflict"; message: string } | { kind: "resolved"; tip: string } | { kind: "error"; message: string };

/**
 * The commit that will land: parents [base, tip], so `repo`'s
 * first-parent history reads exactly as it did when the merge ran there.
 *
 * - `base` already in the branch: the tree is the tip's own. If the tip
 *   already *is* a landing commit (a resolved conflict, committed with
 *   --no-edit), it lands as is rather than wrapping it in a second
 *   `Merge ...` commit the digest would count twice.
 * - Otherwise `git merge-tree --write-tree` merges in the object store,
 *   touching no working tree. A conflict there is redone as a real
 *   `git merge` in the worktree, on the branch, for a human or the
 *   integrator to resolve.
 */
async function buildLandingCommit(git: Git, repo: string, worktree: TaskWorktree, base: string, tip: string, message: string): Promise<LandingPlan> {
  let tree: string;
  if (await isAncestor(git, repo, base, tip)) {
    const tipInfo = await git(repo, ["log", "-1", "--format=%P%x09%s", tip]);
    const [parents = "", subject = ""] = tipInfo.stdout.replace(/\n$/, "").split("\t");
    if (parents.trim().split(/\s+/).length > 1 && subject === message) return { kind: "commit", sha: tip };
    tree = (await git(repo, ["rev-parse", `${tip}^{tree}`])).stdout.trim();
  } else {
    const mt = await git(repo, ["merge-tree", "--write-tree", "--name-only", base, tip]);
    if (mt.ok) {
      tree = mt.stdout.split("\n")[0]!.trim();
    } else if (/^[0-9a-f]{40,64}$/m.test(mt.stdout.split("\n")[0] ?? "")) {
      // Exit 1 with a tree id first: conflicts. Redo it where it can be
      // resolved: in the worktree, on the branch.
      const merge = await git(worktree.path, ["merge", "--no-ff", "-m", message, base]);
      if (merge.ok) {
        const newTip = (await git(worktree.path, ["rev-parse", "HEAD"])).stdout.trim();
        return { kind: "resolved", tip: newTip };
      }
      const out = merge.stdout.trim() || merge.text;
      return {
        kind: "conflict",
        message:
          `conflict merging ${repo}'s HEAD (${short(base)}) into ${worktree.branch}. It is left in the worktree at ${worktree.path} ` +
          `(never in ${repo}); resolve it there and \`git commit --no-edit\`, then merge again.\n${out}`,
      };
    } else {
      return { kind: "error", message: `git merge-tree failed in ${repo}: ${mt.text}` };
    }
  }
  if (!tree) return { kind: "error", message: `couldn't compute the merged tree for ${worktree.branch}` };
  const commit = await git(repo, ["commit-tree", tree, "-p", base, "-p", tip, "-m", message]);
  if (!commit.ok) return { kind: "error", message: `couldn't create the landing commit: ${commit.text}` };
  return { kind: "commit", sha: commit.stdout.trim() };
}

/** Uncommitted paths in `repo` (modified, staged, or untracked) that the
 *  landing changes between `base` and `landing`. */
async function overlappingLocalChanges(git: Git, repo: string, base: string, landing: string): Promise<string[]> {
  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const dirty = new Set(parsePorcelainZ(status.stdout));
  if (dirty.size === 0) return [];
  const diff = await git(repo, ["diff", "--name-only", "--no-renames", "-z", base, landing]);
  const changed = diff.stdout.split("\0").filter(Boolean);
  return changed.filter((p) => dirty.has(p)).sort();
}

/** Paths from `git status --porcelain=v1 -z`; a rename or copy carries
 *  its original path as the next NUL field, and both count. */
export function parsePorcelainZ(out: string): string[] {
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    if (f[0] === "R" || f[0] === "C") {
      const orig = fields[++i];
      if (orig) paths.push(orig);
    }
  }
  return paths;
}

/** The files git lists under "would be overwritten by merge", tracked
 *  or untracked. */
export function parseOverwrittenFiles(text: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const line of text.split("\n")) {
    if (/would be overwritten by merge:?\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (inList && /^\s+\S/.test(line)) files.push(line.trim());
    else inList = false;
  }
  return [...new Set(files)].sort();
}

/**
 * Answers "did `mergeTaskWorktree` already land this branch?" without
 * ever calling it again — the crash-recovery question for an implementer
 * found `pending-review` with an already-`done`, already-approved
 * reviewer (see docs/SDD-crash-recovery.md's interrupted-review-verdict
 * section, resumeAfterApproval's own caller). A crash can land anywhere
 * in or after `mergeTaskWorktree`'s own sequence, so this has to handle
 * every state that sequence can leave behind:
 *
 * - Branch and worktree both still there: `mergeTaskWorktree` never ran,
 *   or crashed before finishing. `git status --porcelain` at
 *   `worktree.path` is checked *first* and short-circuits straight to
 *   `"not-merged"` when dirty — `mergeTaskWorktree` always commits
 *   whatever's uncommitted before it ever merges, so real, not-yet-
 *   committed content sitting in the worktree proves the merge can't
 *   have landed yet, no matter what the branch ref's *current* tip
 *   looks like relative to HEAD (a branch that was created off HEAD and
 *   never advanced is trivially its own ancestor — checking ancestry
 *   before checking for uncommitted content would misread "never
 *   touched" as "already merged"). Only once the worktree is clean does
 *   `git merge-base --is-ancestor <branch> HEAD` decide it: ancestor
 *   means the merge commit landed and the crash hit before
 *   `removeTaskWorktree` ran — `"merged"`; not an ancestor is the
 *   ordinary not-yet-reviewed case — `"not-merged"`.
 * - Branch and worktree both gone: `removeTaskWorktree` already deleted
 *   both, which only ever happens right after a successful merge — but a
 *   discarded (never-merged) worktree also deletes both the same way, so
 *   this alone doesn't prove anything either way. The merge commit
 *   `mergeTaskWorktree` creates carries a deterministic, exact-match
 *   message (`Merge <branch>: <title>`) — found in history, it proves
 *   the merge really landed before cleanup; not found, there's no way to
 *   tell "cleaned up after a real merge" apart from "discarded before
 *   ever merging," so this doesn't guess either way — `"unknown"`.
 * - Exactly one of branch/worktree exists: a state the paired create
 *   (`createTaskWorktree`) / remove (`removeTaskWorktree`) calls never
 *   produce on their own — can't be trusted either way — `"unknown"`.
 *
 * Checked before all of that: `mergedSha`, the landed commit
 * mergeTaskWorktree records on the result (TaskResult.mergedSha) before
 * it cleans up. In HEAD's history means merged, whatever the worktree
 * and branch look like. The checks above only run for a result without
 * one (written before the field existed, or never landed).
 */
export async function determineWorktreeMergeState(
  repo: string,
  worktree: TaskWorktree,
  task: TaskCard,
  runner: CommandRunner,
  mergedSha?: string,
): Promise<"merged" | "not-merged" | "unknown"> {
  if (mergedSha) {
    const landed = await runner(["git", "merge-base", "--is-ancestor", mergedSha, "HEAD"], { cwd: repo });
    if (landed.exitCode === 0) return "merged";
  }

  const branchCheck = await runner(["git", "rev-parse", "--verify", "--quiet", worktree.branch], { cwd: repo });
  const branchExists = branchCheck.exitCode === 0;
  const worktreeExists = existsSync(worktree.path);

  if (branchExists && worktreeExists) {
    const status = await runner(["git", "status", "--porcelain"], { cwd: worktree.path });
    if (status.stdout.trim()) return "not-merged";
    const ancestor = await runner(["git", "merge-base", "--is-ancestor", worktree.branch, "HEAD"], { cwd: repo });
    return ancestor.exitCode === 0 ? "merged" : "not-merged";
  }

  if (!branchExists && !worktreeExists) {
    // Legacy: only a result recorded before TaskResult.mergedSha existed
    // gets here having really merged. Searching the log for the landing
    // message is the best proof such a row has.
    const commitMessage = landingCommitMessage(worktree, task);
    const log = await runner(["git", "log", "--all", "--fixed-strings", `--grep=${commitMessage}`, "--format=%H"], { cwd: repo });
    return log.exitCode === 0 && log.stdout.trim() ? "merged" : "unknown";
  }

  return "unknown";
}
