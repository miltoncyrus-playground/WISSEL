import type { CommandRunner } from "../executors/claude-cli.ts";

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
    checks: summarizeChecks(raw.statusCheckRollup),
    ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  };
}

const FIELDS = "number,title,url,headRefName,state,isDraft,reviewDecision,mergeable,updatedAt,statusCheckRollup";

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

function runState(status: string | undefined, conclusion: string | undefined): RunState {
  if (status === "in_progress") return "running";
  if (status === "completed") return FAILED.has((conclusion ?? "").toUpperCase()) ? "failed" : PASSED.has((conclusion ?? "").toUpperCase()) ? "passed" : "other";
  return status ? "queued" : "other";
}

/** The newest workflow runs of the repo behind `path`'s `origin`, on any
 *  branch (so runs on `main` and on branches without a PR show too).
 *  Read-only `gh run list` with fixed argv. */
export async function getProjectRuns(path: string, runner: CommandRunner): Promise<ProjectRuns | { error: string }> {
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
