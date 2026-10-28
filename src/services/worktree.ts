import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { TaskCard } from "../core/types.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { withRepoLock } from "./repo-lock.ts";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  GATE_OUTPUT_TAIL_LINES,
  runGateCommand,
  runMergeGate,
  shellWords,
  tailLines,
  type GateCommandRunner,
  type GateReport,
  type GateRun,
  type MergeGateConfig,
  type MergeGateResolver,
} from "./merge-gate.ts";

export interface TaskWorktree {
  path: string;
  branch: string;
}

export interface WorktreeOptions {
  runner: CommandRunner;
  /** Injectable so tests never touch the real filesystem or $HOME. */
  homeDir?: string;
  /** The project's setup commands (Project.worktreeSetup), run once in
   *  a new worktree. Undefined or empty means none: today's behaviour. */
  setup?: WorktreeSetupConfig;
  /** Runs each setup command; defaults to the merge gate's spawner. */
  setupRunner?: GateCommandRunner;
  /** The card's `mergeTarget`: when set, a new worktree branches off
   *  this local branch (created first, from the repo's default branch,
   *  if it doesn't exist) instead of the repo's HEAD. */
  baseRef?: string;
}

/** Checks a card's `mergeTarget`: undefined or "" means none (today's
 *  behaviour), anything else must be a plain local branch name. Refuses
 *  what git or a shell could misread (a leading dash, `..`, `@{`,
 *  whitespace, control characters, a `.lock` suffix) and `HEAD`. */
export function validateMergeTarget(value: unknown): { ok: true; target?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  if (typeof value !== "string") return { ok: false, error: "mergeTarget must be a string" };
  const v = value.trim();
  if (v.length === 0) return { ok: true };
  if (v.length > 100) return { ok: false, error: "mergeTarget must be at most 100 characters" };
  if (v === "HEAD" || /^refs\//.test(v)) return { ok: false, error: "mergeTarget must be a branch name, not HEAD or a full ref" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(v) || v.includes("..") || v.includes("//") || v.endsWith("/") || v.endsWith(".") || v.endsWith(".lock") || v.includes("/.")) {
    return { ok: false, error: `mergeTarget "${v}" isn't a safe branch name (letters, digits, . _ - and / only)` };
  }
  return { ok: true, target: v };
}

/** Makes sure the local branch `target` exists in `repo`, creating it
 *  from the repo's default branch the first time: origin/HEAD, then
 *  origin/main, origin/master, main, master, and last the current HEAD. */
async function ensureTargetBranch(repo: string, target: string, runner: CommandRunner): Promise<{ ok: true } | { error: string }> {
  const have = await runner(["git", "rev-parse", "--verify", "-q", `refs/heads/${target}^{commit}`], { cwd: repo });
  if (have.exitCode === 0) return { ok: true };
  for (const start of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master", "HEAD"]) {
    const ok = await runner(["git", "rev-parse", "--verify", "-q", `${start}^{commit}`], { cwd: repo });
    if (ok.exitCode !== 0) continue;
    const made = await runner(["git", "branch", target, start], { cwd: repo });
    if (made.exitCode === 0) return { ok: true };
    return { error: `couldn't create the merge target ${target} in ${repo}: ${(made.stderr || made.stdout).trim()}` };
  }
  return { error: `couldn't create the merge target ${target} in ${repo}: no starting commit found` };
}

/** A project's worktree setup: argv arrays run in order in a new
 *  worktree, first failure stops. `timeoutMs` applies to each command;
 *  default DEFAULT_GATE_TIMEOUT_MS (10 min), the merge gate's. */
export interface WorktreeSetupConfig {
  commands: string[][];
  timeoutMs?: number;
}

/** Looks up the setup for a repo path (the project registered there);
 *  undefined means none configured. */
export type WorktreeSetupResolver = (repo: string) => Promise<WorktreeSetupConfig | undefined>;

/** Written to the worktree's own git dir (`.git/worktrees/<name>/`,
 *  never part of the checkout, so never tracked or merged) once setup
 *  has passed. */
export const SETUP_DONE_MARKER = ".wissel-setup-done";
/** Written there right before setup starts and removed once it passes:
 *  a reused worktree that still has it never finished setup (it failed,
 *  or the server died mid-run), so setup runs again. */
export const SETUP_PENDING_MARKER = ".wissel-setup-pending";

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
 *
 * Then runs the project's `opts.setup` commands (e.g. `uv sync
 * --frozen`) in a new worktree, once: see runWorktreeSetup. A setup
 * failure returns `{ error }` with the failing command's output tail,
 * the same as a failed `git worktree add`.
 */
export async function createTaskWorktree(repo: string, worktreeKey: string, opts: WorktreeOptions): Promise<TaskWorktree | { error: string }> {
  const root = worktreesRoot(opts.homeDir);
  mkdirSync(root, { recursive: true });
  const path = join(root, worktreeKey);
  const branch = branchName(worktreeKey);

  const existing = await opts.runner(["git", "worktree", "list", "--porcelain"], { cwd: repo });
  if (existing.exitCode === 0 && existing.stdout.includes(`worktree ${path}`)) {
    linkNodeModules(repo, path);
    // Reviewer, fixer and integrator passes land here and pay nothing.
    // Only a worktree whose own setup never finished runs it again.
    if (!setupPending(path)) return { path, branch };
    const setup = await runWorktreeSetup(path, opts.setup, opts.setupRunner);
    return "error" in setup ? setup : { path, branch };
  }

  let start = "HEAD";
  if (opts.baseRef) {
    const ensured = await ensureTargetBranch(repo, opts.baseRef, opts.runner);
    if ("error" in ensured) return ensured;
    start = `refs/heads/${opts.baseRef}`;
  }
  const result = await opts.runner(["git", "worktree", "add", "-b", branch, path, start], { cwd: repo });
  if (result.exitCode !== 0) {
    return { error: `failed to create worktree for ${worktreeKey}: ${(result.stderr || result.stdout).trim()}` };
  }
  linkNodeModules(repo, path);
  const setup = await runWorktreeSetup(path, opts.setup, opts.setupRunner);
  return "error" in setup ? setup : { path, branch };
}

/** What a setup call did, for the caller's log line. */
export interface WorktreeSetupReport {
  status: "none" | "skipped" | "passed";
  runs: GateRun[];
  durationMs: number;
}

/**
 * Runs a project's worktree setup in `worktreePath`: each argv in
 * order, first failure stops, each command under `setup.timeoutMs`
 * (default 10 minutes, the merge gate's). Runs in wissel's own process
 * (runGateCommand: no agent sandbox, WISSEL_* env stripped), so the
 * commands come only from the trusted Project.worktreeSetup setting,
 * never from card content.
 *
 * Once per worktree: skipped when SETUP_DONE_MARKER is in the
 * worktree's git dir. SETUP_PENDING_MARKER is written before the first
 * command and swapped for the done marker on success, so a failed or
 * interrupted setup is retried by the next run on that worktree
 * (createTaskWorktree's reuse path checks it). When the git dir can't
 * be found (no `.git` in the worktree) setup still runs, unmarked.
 *
 * A failure is `{ error }` naming the command, its exit code or
 * timeout, and the last GATE_OUTPUT_TAIL_LINES lines of its output: the
 * card fails before the agent starts, with that text as its summary.
 */
export async function runWorktreeSetup(
  worktreePath: string,
  setup: WorktreeSetupConfig | undefined,
  runner: GateCommandRunner = runGateCommand,
): Promise<WorktreeSetupReport | { error: string }> {
  if (!setup || setup.commands.length === 0) return { status: "none", runs: [], durationMs: 0 };
  const gitDir = worktreeGitDir(worktreePath);
  if (gitDir && existsSync(join(gitDir, SETUP_DONE_MARKER))) return { status: "skipped", runs: [], durationMs: 0 };
  if (gitDir) writeMarker(join(gitDir, SETUP_PENDING_MARKER));

  const timeoutMs = setup.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const runs: GateRun[] = [];
  const start = performance.now();
  for (const argv of setup.commands) {
    const t0 = performance.now();
    const res = await runner(argv, { cwd: worktreePath, timeoutMs });
    runs.push({ argv, exitCode: res.exitCode, durationMs: Math.round(performance.now() - t0), timedOut: res.timedOut });
    if (res.timedOut || res.exitCode !== 0) {
      const why = res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited ${res.exitCode}`;
      console.warn(`worktree setup: ${worktreePath}: \`${shellWords(argv)}\` ${why}`);
      return {
        error:
          `Worktree setup failed: \`${shellWords(argv)}\` ${why} in ${worktreePath}. ` +
          `The agent did not run. Fix the project's worktreeSetup or the repo, then retry the card.\n\n` +
          `Last ${GATE_OUTPUT_TAIL_LINES} lines of its output:\n\`\`\`\n${tailLines(res.output)}\n\`\`\``,
      };
    }
  }
  if (gitDir) {
    writeMarker(join(gitDir, SETUP_DONE_MARKER));
    rmSync(join(gitDir, SETUP_PENDING_MARKER), { force: true });
  }
  const durationMs = Math.round(performance.now() - start);
  console.log(`worktree setup: ${worktreePath}: ${runs.length} command(s) passed in ${(durationMs / 1000).toFixed(1)}s`);
  return { status: "passed", runs, durationMs };
}

/** True when a previous setup in this worktree started but never passed. */
function setupPending(worktreePath: string): boolean {
  const gitDir = worktreeGitDir(worktreePath);
  return !!gitDir && existsSync(join(gitDir, SETUP_PENDING_MARKER)) && !existsSync(join(gitDir, SETUP_DONE_MARKER));
}

/**
 * The worktree's own git dir, read from its `.git` file (`gitdir:
 * <path>`, which `git worktree add` writes), so no subprocess is
 * needed. A `.git` directory (a full checkout) is returned as is.
 * Undefined when there's neither.
 */
export function worktreeGitDir(worktreePath: string): string | undefined {
  const dotGit = join(worktreePath, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    return m ? resolve(worktreePath, m[1]!) : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(path: string): void {
  try {
    writeFileSync(path, `${new Date().toISOString()}\n`);
  } catch {
    // Unwritable git dir: setup still runs, it just isn't remembered.
  }
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
  /** The conflict integrator card whose resolution this attempt
   *  committed (finishResolvedMerge). Set only when the worktree held
   *  an unfinished merge that Wissel finished itself. */
  resolvedConflictBy?: string;
  /** The commit of `repo`'s HEAD the merge conflicted against: the
   *  `base` a fresh conflict was redone against in the worktree, or the
   *  worktree's MERGE_HEAD when an earlier conflict there is still
   *  unfinished. Set only on `conflict`. The orchestrator keys the
   *  conflict integrator on it (maybeSpawnConflictIntegrator): a new
   *  HEAD is a new conflict and gets its own card, the same HEAD never
   *  spawns twice. */
  conflictHead?: string;
  lockWaitMs: number;
  lockHoldMs: number;
}

/** Where the merge path's telemetry goes (TelemetryLog in production). */
export interface MergeTelemetry {
  record(event: TelemetryEvent): Promise<void>;
}

/** Whether a card's conflict integrator for one conflict (the follow-up
 *  maybeSpawnConflictIntegrator spawns, orchestrator.ts, keyed on the
 *  repo HEAD the merge conflicted against) has finished: status
 *  `review` or `done`. `reason` says why not, for the refusal. */
export type ConflictIntegratorState = { finished: true; cardId: string } | { finished: false; reason: string };

/** Everything the merge path needs besides the task itself. Built once
 *  in createApp (src/api/server.ts) and handed to every caller: the
 *  orchestrator's auto-merge, the board's Merge button, Ask's merge. A
 *  bare CommandRunner still works and means: no gate, no telemetry. */
export interface MergeContext {
  runner: CommandRunner;
  /** The repo's project settings (ProjectStore.settingsFor), so a
   *  reviewer's suggested grants can skip ones the card already has. */
  settingsFor?: (repo: string) => Promise<{ verification?: { allowedTools?: string[] } } | undefined>;
  /** The repo's gate (Project.mergeGate); absent means none. */
  gateFor?: MergeGateResolver;
  gateRunner?: GateCommandRunner;
  telemetry?: MergeTelemetry;
  /** Answers whether this card's conflict integrator for the conflict
   *  against `conflictHead` (the worktree's MERGE_HEAD, the repo HEAD
   *  that merge conflicted against) has finished, the second condition
   *  for Wissel to commit a resolved conflict merge itself
   *  (finishResolvedMerge, docs/SDD-worktree-isolation.md §7.8). An
   *  integrator that finished an earlier conflict against another HEAD
   *  does not count (§7.9). Every caller with a board sets it
   *  (withConflictIntegratorCheck, orchestrator.ts). Absent: a worktree
   *  with an unfinished merge is always refused, the pre-2026-10-19
   *  behaviour. */
  conflictIntegrator?: (task: TaskCard, conflictHead: string) => Promise<ConflictIntegratorState>;
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
 * landing commit itself, and the next merge lands it as is. The
 * integrator card can't run that commit (the sandbox write-denies the
 * repo's `.git`, which holds the worktree's gitdir), so Wissel finishes
 * the merge itself on the next attempt, but only once two checks pass
 * (finishResolvedMerge): no conflict marker is left in any file and
 * the card's conflict integrator has finished. Anything else, including
 * a human's half-done manual resolve, is refused with the failing check
 * named, never committed behind their back.
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
      ...(result.resolvedConflictBy ? { resolvedConflictBy: result.resolvedConflictBy } : {}),
      ...(result.conflictHead ? { conflictHead: result.conflictHead } : {}),
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

  // An unfinished merge in the worktree: a conflict from an earlier
  // attempt. Finished here when it is resolved and the integrator is
  // done; refused otherwise, since committing it would commit the
  // conflict markers.
  let resolvedConflictBy: string | undefined;
  const mergeHead = await git(worktree.path, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.ok) {
    // MERGE_HEAD is the repo HEAD that conflict was against: the key the
    // integrator card for it carries, and the one a refusal reports.
    const conflictHead = mergeHead.stdout.trim();
    const finished = await finishResolvedMerge(git, repo, worktree, task, ctx, conflictHead);
    if (!finished.ok) return fail(finished.outcome, finished.message, NO_GATE, finished.outcome === "conflict" ? { conflictHead } : {});
    resolvedConflictBy = finished.cardId;
  }
  const extra: Partial<Unlocked> = resolvedConflictBy ? { resolvedConflictBy } : {};
  const landNote = resolvedConflictBy ? ` (finished the conflict merge resolved by card ${resolvedConflictBy})` : "";

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

  // Where this card lands: its own target branch, or the repo's HEAD.
  // A target that isn't the checked-out branch moves with update-ref
  // (compare-and-swap) and never touches the working tree; a target that
  // is checked out takes the normal fast-forward.
  const target = task.mergeTarget;
  const baseRef = target ? `refs/heads/${target}` : "HEAD";
  const where = target ? `branch ${target} of ${repo}` : `${repo}'s HEAD`;
  let viaUpdateRef = false;
  if (target) {
    const checkedOut = await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"]);
    viaUpdateRef = !(checkedOut.ok && checkedOut.stdout.trim() === target);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    const baseRes = await git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    if (!baseRes.ok) return fail("error", `can't read ${where}: ${baseRes.text}`);
    const base = baseRes.stdout.trim();

    // Nothing on the branch that HEAD doesn't already have.
    if (await isAncestor(git, repo, tip, base)) {
      return land(repo, worktree, ctx, base, { status: "skipped", runs: [], durationMs: 0 }, onLanded, `nothing to land: ${repo} already has everything on ${worktree.branch}`, extra);
    }

    const plan = await buildLandingCommit(git, repo, worktree, base, tip, message);
    if (plan.kind === "error") return fail("error", plan.message);
    // `extra` too: this attempt may have committed an earlier conflict's
    // resolution (resolvedConflictBy) before conflicting against the HEAD
    // that moved since; the trace says so.
    if (plan.kind === "conflict") return fail("conflict", plan.message, NO_GATE, { ...extra, conflictHead: plan.head });
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
      if (gate.status === "failed") return fail("gate-failed", gate.feedback ?? "merge gate failed", gate, extra);
    }

    await ctx.beforeLand?.();

    const headNow = (await git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
    if (headNow !== base) {
      if (attempt === 1) continue;
      return fail(
        "head-moved",
        `${where} moved twice while this merge was being checked (${short(base)} -> ${short(headNow)}); nothing landed. Merge again when the repo is quiet.`,
        gate,
      );
    }

    if (viaUpdateRef) {
      // Not the checked-out branch: nothing in the working tree can be
      // overwritten, so there is no overlap check. The old value makes
      // this a compare-and-swap: a branch that moved since `base` fails.
      const moved = await git(repo, ["update-ref", `refs/heads/${target}`, landing, base]);
      if (!moved.ok) {
        if (attempt === 1) continue;
        return fail("head-moved", `${where} moved while landing; nothing landed. Merge again when the repo is quiet.`, gate);
      }
      const landedTarget = (await git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
      if (landedTarget !== landing) {
        return fail("error", `update-ref reported success but ${where} is ${short(landedTarget)}, not ${short(landing)}`, gate);
      }
      const noteT = gate.status === "passed" ? ` (gate passed in ${Math.round(gate.durationMs / 1000)}s)` : gate.status === "none" ? " (no merge gate configured)" : "";
      return land(repo, worktree, ctx, landing, gate, onLanded, `landed ${worktree.branch} on ${where} at ${short(landing)}${noteT}${landNote}`, extra);
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
        return fail("head-moved", `${where} moved while landing; nothing landed. Merge again when the repo is quiet.`, gate);
      }
      return fail("error", `fast-forward of ${repo} to ${short(landing)} failed: ${ff.text}`, gate);
    }

    const landedHead = (await git(repo, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
    if (landedHead !== landing) {
      return fail("error", `fast-forward reported success but ${where} is ${short(landedHead)}, not ${short(landing)}`, gate);
    }
    const gateNote = gate.status === "passed" ? ` (gate passed in ${Math.round(gate.durationMs / 1000)}s)` : gate.status === "none" ? " (no merge gate configured)" : "";
    return land(repo, worktree, ctx, landing, gate, onLanded, `landed ${worktree.branch} on ${target ? where : repo} at ${short(landing)}${gateNote}${landNote}`, extra);
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
  extra: Partial<Unlocked> = {},
): Promise<Unlocked> {
  // Recorded before cleanup: a crash between the two leaves a card
  // crash recovery can prove merged from the sha alone.
  try {
    await onLanded?.(sha);
  } catch (e) {
    console.error(`merge: landed ${short(sha)} but couldn't record it: ${(e as Error).message}`);
  }
  await removeTaskWorktree(repo, worktree, ctx.runner);
  return { ok: true, outcome: "landed", message, mergedSha: sha, gate, ...extra };
}

type FinishOutcome = { ok: true; cardId: string } | { ok: false; outcome: "conflict" | "error"; message: string };

/**
 * Finishes the unfinished merge a conflict left in the worktree
 * (buildLandingCommit's `git merge --no-ff -m <landing message> base`),
 * the way the integrator can't: its sandbox write-denies the repo's
 * `.git`, where the worktree's gitdir lives, so `git add`/`git commit`
 * there can never succeed (cards 32c60ba0 and 42d2bbfb, 2026-10-19).
 * Two checks, in order, each refusing with its own reason:
 *
 * 1. Nothing is still conflicted: no file among `git ls-files -u`'s
 *    unmerged paths or `git diff --name-only HEAD`'s changed files has a
 *    conflict marker line (findConflictMarkers), and no unmerged path is
 *    binary (git leaves one side's bytes there, with no marker to tell a
 *    resolution from the raw conflict). A changed file that is binary
 *    but not unmerged came from the merge itself and is fine. A missing
 *    file is a deletion `git add -A` stages.
 * 2. The card's conflict integrator for this conflict has finished
 *    (ctx.conflictIntegrator, asked with `conflictHead`, the worktree's
 *    MERGE_HEAD: status review or done). A human mid-way through a
 *    manual resolve has no finished integrator, so their worktree is
 *    never committed behind their back; they finish with `git commit
 *    --no-edit` as before. An integrator that finished an earlier
 *    conflict of the same card, against another HEAD, is not this
 *    conflict's and does not count either.
 *
 * Then `git add -A` and `git commit --no-edit --cleanup=strip`: the
 * prepared MERGE_MSG (`Merge <branch>: <title>`) becomes the commit's
 * message, so the digest counts the landed card by it, and git's own
 * `# Conflicts:` comment lines are dropped whatever the config says.
 * The gate still runs on the result: a bad resolution fails there and
 * goes back through pushback.
 */
async function finishResolvedMerge(git: Git, repo: string, worktree: TaskWorktree, task: TaskCard, ctx: MergeContext, conflictHead: string): Promise<FinishOutcome> {
  const where = `${worktree.path} has an unfinished merge of ${repo}'s HEAD (${short(conflictHead)}) into ${worktree.branch}`;
  const refuse = (outcome: "conflict" | "error", why: string): FinishOutcome => ({ ok: false, outcome, message: `${where}: ${why}` });

  const unmergedRes = await git(worktree.path, ["ls-files", "-u", "-z"]);
  if (!unmergedRes.ok) return refuse("error", `couldn't list its unmerged paths: ${unmergedRes.text}`);
  const diffRes = await git(worktree.path, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]);
  if (!diffRes.ok) return refuse("error", `couldn't diff it against HEAD: ${diffRes.text}`);
  const unmerged = parseUnmergedZ(unmergedRes.stdout);
  const changed = diffRes.stdout.split("\0").filter(Boolean);
  const unresolved = unresolvedFiles(worktree.path, unmerged, changed);
  if (unresolved.length > 0) {
    return refuse("conflict", `conflict markers are still in ${unresolved.join(", ")}. Resolve them there (then \`git commit --no-edit\`, or let the integrator finish), then merge again.`);
  }

  if (!ctx.conflictIntegrator) {
    return refuse("conflict", "this merge path has no board to check the conflict integrator against, so it won't commit the resolution. Run `git add -A && git commit --no-edit` there, then merge again.");
  }
  const integrator = await ctx.conflictIntegrator(task, conflictHead);
  if (!integrator.finished) {
    return refuse("conflict", `${integrator.reason}. Wissel only commits a resolution its integrator card finished; a manual one is finished with \`git add -A && git commit --no-edit\` there, then merge again.`);
  }

  const add = await git(worktree.path, ["add", "-A"]);
  if (!add.ok) return refuse("error", `\`git add -A\` failed while finishing the resolved merge: ${add.text}`);
  const commit = await git(worktree.path, ["commit", "--no-edit", "--cleanup=strip"]);
  if (!commit.ok) return refuse("error", `\`git commit --no-edit\` failed while finishing the resolved merge: ${commit.text}`);
  return { ok: true, cardId: integrator.cardId };
}

/** Paths from `git ls-files -u -z` (`<mode> <sha> <stage>\t<path>`),
 *  each once however many stages it has. */
export function parseUnmergedZ(out: string): string[] {
  const paths: string[] = [];
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** 1-based lines holding a conflict marker: `<<<<<<< `, `||||||| `
 *  (diff3), `=======` alone, `>>>>>>> `. A CR before the newline is
 *  ignored so CRLF files read the same. `=======` alone is a marker
 *  even where a file meant it as a Markdown underline: refusing names
 *  the file and line, committing a real marker would land it. */
export function findConflictMarkers(content: string): number[] {
  const lines: number[] = [];
  content.split("\n").forEach((raw, i) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (/^<<<<<<<( |$)/.test(line) || /^>>>>>>>( |$)/.test(line) || line === "=======" || /^\|\|\|\|\|\|\|( |$)/.test(line)) lines.push(i + 1);
  });
  return lines;
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** The files finishResolvedMerge's check 1 refuses on, each as
 *  `path:line` for a marker or `path (binary, unmerged)`, in path
 *  order. Exported for the gate tests. */
export function unresolvedFiles(root: string, unmerged: string[], changed: string[]): string[] {
  const out: string[] = [];
  const paths = [...new Set([...unmerged, ...changed])].sort();
  for (const path of paths) {
    const full = join(root, path);
    if (!existsSync(full) || statSync(full).isDirectory()) continue;
    const bytes = readFileSync(full);
    if (looksBinary(bytes)) {
      if (unmerged.includes(path)) out.push(`${path} (binary, unmerged)`);
      continue;
    }
    const markers = findConflictMarkers(bytes.toString("utf8"));
    if (markers.length > 0) out.push(`${path}:${markers.join(",")}`);
  }
  return out;
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

type LandingPlan =
  | { kind: "commit"; sha: string }
  /** `head` is `base`, the repo HEAD the merge conflicted against. */
  | { kind: "conflict"; message: string; head: string }
  | { kind: "resolved"; tip: string }
  | { kind: "error"; message: string };

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
        head: base,
        message:
          `conflict merging ${repo}'s HEAD (${short(base)}) into ${worktree.branch}. It is left in the worktree at ${worktree.path} ` +
          `(never in ${repo}). An integrator card resolves it there and the next merge commits and lands it; ` +
          `to resolve it yourself, edit it there and \`git commit --no-edit\`, then merge again.\n${out}`,
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
