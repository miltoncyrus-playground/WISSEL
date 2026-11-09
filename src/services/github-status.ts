import type { EventEmitter } from "node:events";
import type { PrLifecycle, PrRef, PrWatch, TaskCard } from "../core/types.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Board, BoardEvent } from "./board.ts";

/** Pull-request and CI state of a project's branches, read from GitHub
 *  through `gh`. Read-only: `gh pr list` with fixed argv, no shell string,
 *  no write call. It uses whatever login `gh` has active; nothing here
 *  switches accounts or touches a token. A failure (not logged in, no
 *  access, offline) is an `error` on that project and never a throw. */
export type CiState = "passing" | "failing" | "pending" | "none";

export interface PrChecks {
  state: CiState;
  total: number;
  /** Names of the checks that failed, at most 5. */
  failing: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: "open" | "draft" | "merged" | "closed";
  /** GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED. */
  review?: string;
  /** MERGEABLE, CONFLICTING or UNKNOWN; only meaningful while open. */
  mergeable?: string;
  /** GitHub's mergeStateStatus: CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, ... */
  mergeStateStatus?: string;
  /** The head commit `checks` ran on. */
  headSha?: string;
  /** Auto-merge is on (§4.7 "armed"). */
  armed?: boolean;
  checks: PrChecks;
  updatedAt?: string;
}

export interface ProjectPrs {
  /** `org/repo` as GitHub knows it. */
  repo: string;
  prs: PullRequest[];
}

const NAME = "[A-Za-z0-9_.-]+";
const SLUG_RE = new RegExp(`^(${NAME})/(${NAME})$`);
export const PR_LIMIT = 100;

/** `org/repo` out of a remote URL in any of its forms: https, scp-style
 *  (`git@host:org/repo.git`, where the host may be an SSH alias such as
 *  `github-alias`) and `ssh://`. The host is not checked: an alias is
 *  indistinguishable from a real host, and `gh` itself decides whether
 *  github.com knows the repo. */
export function parseGithubRemote(url: string): string | undefined {
  const u = url.trim();
  let path: string | undefined;
  const web = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/(.+)$/.exec(u);
  if (web) path = web[1];
  else {
    const scp = /^(?:[^@/\s]+@)?[^:/\s]+:(?!\/)(.+)$/.exec(u);
    if (scp) path = scp[1];
  }
  if (!path) return undefined;
  const slug = path.replace(/\/+$/, "").replace(/\.git$/, "");
  return SLUG_RE.test(slug) ? slug : undefined;
}

interface RawCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** Folds `statusCheckRollup` (check runs and legacy statuses) into one
 *  state: any failure fails, otherwise anything unfinished is pending,
 *  otherwise it passes. No checks at all is `none`. */
export function summarizeChecks(rollup: unknown): PrChecks {
  const list = Array.isArray(rollup) ? (rollup as RawCheck[]) : [];
  let failed = 0;
  let pending = 0;
  const failing: string[] = [];
  for (const c of list) {
    const name = c.name ?? c.context ?? "check";
    const result = (c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? c.conclusion : undefined) ?? "";
    if (FAILED.has(result)) {
      failed++;
      if (failing.length < 5) failing.push(name);
    } else if (!PASSED.has(result)) pending++;
  }
  const state: CiState = list.length === 0 ? "none" : failed ? "failing" : pending ? "pending" : "passing";
  return { state, total: list.length, failing };
}

interface RawPr {
  number?: number;
  title?: string;
  url?: string;
  headRefName?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  headRefOid?: string;
  autoMergeRequest?: unknown;
  updatedAt?: string;
  statusCheckRollup?: unknown;
}

function toPullRequest(raw: RawPr): PullRequest | undefined {
  if (typeof raw.number !== "number" || !raw.headRefName) return undefined;
  const state = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : raw.isDraft ? "draft" : "open";
  return {
    number: raw.number,
    title: raw.title ?? "",
    url: raw.url ?? "",
    branch: raw.headRefName,
    state,
    ...(raw.reviewDecision ? { review: raw.reviewDecision } : {}),
    ...(raw.mergeable ? { mergeable: raw.mergeable } : {}),
    ...(raw.mergeStateStatus ? { mergeStateStatus: raw.mergeStateStatus } : {}),
    ...(raw.headRefOid ? { headSha: raw.headRefOid } : {}),
    ...(raw.autoMergeRequest && typeof raw.autoMergeRequest === "object" ? { armed: true } : {}),
    checks: summarizeChecks(raw.statusCheckRollup),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  };
}

const FIELDS = "number,title,url,headRefName,state,isDraft,reviewDecision,mergeable,mergeStateStatus,headRefOid,autoMergeRequest,updatedAt,statusCheckRollup";

/** The newest PRs (any state) of the repo behind `path`'s `origin`. For a
 *  branch with several PRs the newest wins. */
export async function getProjectPrs(path: string, runner: CommandRunner): Promise<ProjectPrs | { error: string }> {
  const remote = await runner(["git", "remote", "get-url", "origin"], { cwd: path });
  if (remote.exitCode !== 0) return { error: "no origin remote" };
  const repo = parseGithubRemote(remote.stdout);
  if (!repo) return { error: "origin is not a GitHub repository" };
  const out = await runner(["gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", String(PR_LIMIT), "--json", FIELDS], { cwd: path });
  if (out.exitCode !== 0) {
    const reason = (out.stderr || out.stdout).trim().split("\n")[0] ?? "";
    return { error: `gh: ${reason.slice(0, 200) || `exit ${out.exitCode}`}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch {
    return { error: "gh: unreadable answer" };
  }
  const newest = new Map<string, PullRequest>();
  for (const r of Array.isArray(raw) ? (raw as RawPr[]) : []) {
    const pr = toPullRequest(r);
    if (!pr) continue;
    const have = newest.get(pr.branch);
    if (!have || pr.number > have.number) newest.set(pr.branch, pr);
  }
  return { repo, prs: [...newest.values()].sort((a, b) => b.number - a.number) };
}

export type RunState = "running" | "queued" | "failed" | "passed" | "other";

export interface WorkflowRun {
  id: number;
  workflow: string;
  title: string;
  branch: string;
  event: string;
  state: RunState;
  url: string;
  /** When it started running (or was created, while still queued). */
  startedAt?: string;
  updatedAt?: string;
  /** The jobs of a run that is running, queued or failed today. */
  jobs?: RunJob[];
}

export interface RunJob {
  name: string;
  state: RunState;
  url: string;
  startedAt?: string;
  completedAt?: string;
  /** The step in progress, or the one that failed. */
  step?: string;
}

export interface ProjectRuns {
  repo: string;
  runs: WorkflowRun[];
}

interface RawRun {
  databaseId?: number;
  workflowName?: string;
  displayTitle?: string;
  headBranch?: string;
  event?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  createdAt?: string;
  startedAt?: string;
  updatedAt?: string;
}

const RUN_FIELDS = "databaseId,workflowName,displayTitle,headBranch,event,status,conclusion,url,createdAt,startedAt,updatedAt";
export const RUN_LIMIT = 30;
/** Runs per project whose jobs are read: one `gh run view` each. */
export const JOB_RUNS = 8;
const DAY_MS = 24 * 3600 * 1000;

interface RawJob {
  name?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  startedAt?: string;
  completedAt?: string;
  steps?: { name?: string; status?: string; conclusion?: string }[];
}

async function readJobs(repo: string, id: number, path: string, runner: CommandRunner): Promise<RunJob[] | undefined> {
  const out = await runner(["gh", "run", "view", String(id), "--repo", repo, "--json", "jobs"], { cwd: path });
  if (out.exitCode !== 0) return undefined;
  try {
    const raw = (JSON.parse(out.stdout) as { jobs?: RawJob[] }).jobs;
    if (!Array.isArray(raw)) return undefined;
    return raw.map((j) => {
      const state = runState(j.status?.toLowerCase(), j.conclusion?.toLowerCase());
      const step = (j.steps ?? []).find((x) => (state === "failed" ? FAILED.has((x.conclusion ?? "").toUpperCase()) : x.status?.toLowerCase() === "in_progress"))?.name;
      return {
        name: j.name ?? "job",
        state,
        url: j.url ?? "",
        ...(j.startedAt ? { startedAt: j.startedAt } : {}),
        ...(j.completedAt ? { completedAt: j.completedAt } : {}),
        ...(step ? { step } : {}),
      };
    });
  } catch {
    return undefined;
  }
}

function runState(status: string | undefined, conclusion: string | undefined): RunState {
  if (status === "in_progress") return "running";
  if (status === "completed") return FAILED.has((conclusion ?? "").toUpperCase()) ? "failed" : PASSED.has((conclusion ?? "").toUpperCase()) ? "passed" : "other";
  return status ? "queued" : "other";
}

/** The newest workflow runs of the repo behind `path`'s `origin`, on any
 *  branch (so runs on `main` and on branches without a PR show too).
 *  Read-only `gh run list` with fixed argv. */
export async function getProjectRuns(path: string, runner: CommandRunner, now: () => number = Date.now): Promise<ProjectRuns | { error: string }> {
  const remote = await runner(["git", "remote", "get-url", "origin"], { cwd: path });
  if (remote.exitCode !== 0) return { error: "no origin remote" };
  const repo = parseGithubRemote(remote.stdout);
  if (!repo) return { error: "origin is not a GitHub repository" };
  const out = await runner(["gh", "run", "list", "--repo", repo, "--limit", String(RUN_LIMIT), "--json", RUN_FIELDS], { cwd: path });
  if (out.exitCode !== 0) {
    const reason = (out.stderr || out.stdout).trim().split("\n")[0] ?? "";
    return { error: `gh: ${reason.slice(0, 200) || `exit ${out.exitCode}`}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(out.stdout);
  } catch {
    return { error: "gh: unreadable answer" };
  }
  const runs: WorkflowRun[] = [];
  for (const r of Array.isArray(raw) ? (raw as RawRun[]) : []) {
    if (typeof r.databaseId !== "number") continue;
    runs.push({
      id: r.databaseId,
      workflow: r.workflowName ?? "workflow",
      title: r.displayTitle ?? "",
      branch: r.headBranch ?? "",
      event: r.event ?? "",
      state: runState(r.status, r.conclusion),
      url: r.url ?? "",
      ...(r.startedAt || r.createdAt ? { startedAt: r.startedAt ?? r.createdAt } : {}),
      ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
    });
  }
  // Jobs only for what is worth opening: live runs and today's failures.
  const open = runs.filter((r) => r.state === "running" || r.state === "queued" || (r.state === "failed" && r.updatedAt && now() - Date.parse(r.updatedAt) < DAY_MS)).slice(0, JOB_RUNS);
  await Promise.all(open.map(async (r) => {
    const jobs = await readJobs(repo, r.id, path, runner);
    if (jobs) r.jobs = jobs;
  }));
  return { runs, repo };
}

/** Per-path answers kept for `ttlMs`, so the Tickets page's Refresh does
 *  not call GitHub once per project every time. */
export function withPrCache<T extends object = ProjectPrs>(
  fetchPrs: (path: string) => Promise<T | { error: string }>,
  ttlMs = 60_000,
  now: () => number = Date.now,
): (path: string) => Promise<T | { error: string }> {
  const cache = new Map<string, { at: number; value: T | { error: string } }>();
  return async (path) => {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = await fetchPrs(path);
    // A failure is not worth remembering: it may be a login to fix.
    if (!("error" in value)) cache.set(path, { at: now(), value });
    return value;
  };
}

// --- PR watcher (docs/SDD-coordinator.md §4.7) ---------------------------

/** A change the watcher saw, for the board events of the same names. */
export type PrWatchEvent = { kind: "pr.checks"; checks: PrWatch["checks"]; sha: string } | { kind: "pr.dirty" } | { kind: "pr.merged" };

function mergeableOf(pr: PullRequest): PrWatch["mergeable"] {
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "dirty";
  if (pr.mergeStateStatus === "BLOCKED") return "blocked";
  return pr.mergeable === "MERGEABLE" ? "clean" : "unknown";
}

function lifecycleOf(ref: PrRef, watch: PrWatch): PrLifecycle {
  if (watch.state === "merged") return "merged";
  const open = watch.state === "open" || watch.state === "armed";
  return open && watch.checks === "passing" && ref.reviewedSha !== undefined && ref.reviewedSha === watch.sha ? "ready" : "landed";
}

/** The watch state of `card.pr` after seeing `pr`, with the events the
 *  difference to the last look warrants. Pure. Undefined when nothing
 *  changed (so nothing is written): `at` alone never counts as a change.
 *  pr.checks fires when a finished run (passing or failing) differs from
 *  the last one, by state or by sha; pr.dirty and pr.merged fire on the
 *  transition into those states. */
export function watchPr(card: Pick<TaskCard, "pr">, pr: PullRequest, at: string): { pr: PrRef; events: PrWatchEvent[] } | undefined {
  const ref = card.pr;
  if (!ref) return undefined;
  const prev = ref.watch;
  const watch: PrWatch = {
    sha: pr.headSha ?? prev?.sha ?? "",
    checks: pr.checks.state,
    mergeable: mergeableOf(pr),
    state: pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.armed ? "armed" : "open",
    at,
  };
  const lifecycle = lifecycleOf(ref, watch);
  const same = (k: keyof PrWatch) => prev !== undefined && prev[k] === watch[k];
  if (prev && same("sha") && same("checks") && same("mergeable") && same("state") && ref.lifecycle === lifecycle) return undefined;
  const events: PrWatchEvent[] = [];
  if ((watch.checks === "passing" || watch.checks === "failing") && !(same("sha") && same("checks"))) events.push({ kind: "pr.checks", checks: watch.checks, sha: watch.sha });
  if (watch.mergeable === "dirty" && !same("mergeable")) events.push({ kind: "pr.dirty" });
  if (watch.state === "merged" && !same("state")) events.push({ kind: "pr.merged" });
  return { pr: { ...ref, lifecycle, watch }, events };
}

export const PR_WATCH_INTERVAL_MS = 60_000;

export interface PrWatcherOptions {
  board: Pick<Board, "list" | "updateFields"> & { events: EventEmitter };
  /** The project's PRs by repo path: `withPrCache(getProjectPrs)` in the
   *  server, so a tick and the Tickets page share one `gh` call. */
  prsOf: (path: string) => Promise<ProjectPrs | { error: string }>;
  intervalMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: Pick<Console, "warn">;
}

export interface PrWatcher {
  /** One poll of every repo with a card whose PR is still open. */
  tick(): Promise<void>;
  stop(): void;
}

function terminal(ref: PrRef | undefined): boolean {
  return ref?.watch?.state === "merged" || ref?.watch?.state === "closed";
}

/** Polls the code host for every card with `pr` set (§4.7): once per
 *  repo per tick, every `intervalMs` (60 s). A change is persisted on
 *  the card's `pr` (through `updateFields`, so a `task.updated` event
 *  follows as for any edit) and then emitted as the pr.* board events
 *  the inbox consumes. A repo whose read fails is retried next tick; a
 *  PR the host no longer lists is left as it was. Cards whose PR is
 *  merged or closed are not polled again. Arming is not done here. */
export function startPrWatcher(opts: PrWatcherOptions): PrWatcher {
  const now = opts.now ?? Date.now;
  const log = opts.logger ?? console;
  let running: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    const cards = (await opts.board.list()).filter((c) => c.pr && c.repo && !c.archivedAt && !terminal(c.pr));
    const byRepo = new Map<string, TaskCard[]>();
    for (const c of cards) byRepo.set(c.repo!, [...(byRepo.get(c.repo!) ?? []), c]);
    for (const [repo, mine] of byRepo) {
      const answer = await opts.prsOf(repo).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
      if ("error" in answer) {
        log.warn(`pr-watcher: ${repo}: ${answer.error}`);
        continue;
      }
      const at = new Date(now()).toISOString();
      for (const card of mine) {
        const pr = answer.prs.find((p) => p.number === card.pr!.number);
        const change = pr ? watchPr(card, pr, at) : undefined;
        if (!change) continue;
        const task = await opts.board.updateFields(card.id, { pr: change.pr });
        for (const e of change.events) {
          const event: BoardEvent = e.kind === "pr.checks" ? { type: "pr.checks", task, checks: e.checks, sha: e.sha } : { type: e.kind, task };
          opts.board.events.emit("event", event);
        }
      }
    }
  };
  // Ticks never overlap: a slow `gh` answer must not start a second poll.
  const guarded = (): Promise<void> => {
    if (!running) running = tick().catch((e) => log.warn(`pr-watcher: tick failed: ${(e as Error).message}`)).finally(() => (running = undefined));
    return running;
  };
  const handle = (opts.setInterval ?? setInterval)(() => void guarded(), opts.intervalMs ?? PR_WATCH_INTERVAL_MS);
  const stop = opts.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  return { tick: guarded, stop: () => stop(handle) };
}
