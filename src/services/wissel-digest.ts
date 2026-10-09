import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { TaskCard, TaskResult } from "../core/types.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";

/**
 * The "Collect activity" step of the Wissel retrospective podcast
 * (docs/SDD-wissel-retro-podcast.md §3.1): what happened in wissel over a
 * period, gathered from the board, git, telemetry, memory/lessons.md and
 * the SDDs into one small digest the analyst step reads in one prompt.
 *
 * Deterministic and pure apart from its injected inputs: the board, the
 * file paths, the git runner and `now` all come in as arguments, so
 * test/wissel-digest.test.ts drives it with an in-memory board, a temp
 * git repo and a telemetry fixture. Git is only ever called through
 * `runner` with `git -C <dir> log ...` or `git -C <dir> remote get-url
 * origin` (assertReadOnlyGit enforces it), never anything that writes.
 *
 * `stories` uses the news gather shape on purpose ({title, date, sources,
 * facts}), so the run drawer's gather-source check (board-news.js
 * gatherUrlSet) and the eval's sources-from-gather work unchanged.
 */

export const DIGEST_LIMITS = {
  defaultDays: 7,
  maxDays: 366,
  maxStories: 40,
  maxFactsChars: 400,
  maxTitleChars: 200,
  maxDocs: 20,
  maxLessonsBytes: 6 * 1024,
  maxPayloadBytes: 40 * 1024,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DigestPeriod {
  from: Date;
  to: Date;
  days: number;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The run input's period: `last N days` or `since YYYY-MM-DD` anywhere
 *  in the text, counted back from `now`; anything else (including an
 *  N of 0, a date in the future or a date that doesn't exist) is the
 *  last 7 days. A `since` date is midnight UTC of that day. */
export function parsePeriod(input: string, now: Date): DigestPeriod {
  const fallback = { from: new Date(now.getTime() - DIGEST_LIMITS.defaultDays * DAY_MS), to: now, days: DIGEST_LIMITS.defaultDays };
  const last = /\blast\s+(\d{1,4})\s+days?\b/i.exec(input);
  if (last) {
    const n = Number(last[1]);
    if (n >= 1 && n <= DIGEST_LIMITS.maxDays) return { from: new Date(now.getTime() - n * DAY_MS), to: now, days: n };
    return fallback;
  }
  const since = /\bsince\s+(\d{4}-\d{2}-\d{2})\b/i.exec(input);
  if (since) {
    const from = new Date(`${since[1]}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || ymd(from) !== since[1] || from.getTime() >= now.getTime()) return fallback;
    const days = Math.ceil((now.getTime() - from.getTime()) / DAY_MS);
    if (days > DIGEST_LIMITS.maxDays) return { from: new Date(now.getTime() - DIGEST_LIMITS.maxDays * DAY_MS), to: now, days: DIGEST_LIMITS.maxDays };
    return { from, to: now, days };
  }
  return fallback;
}

/** `https://github.com/<owner>/<repo>` for a GitHub origin in https, ssh
 *  (`git@github.com:o/r.git`) or `ssh://` form; null for anything else. */
export function githubRepoUrl(origin: string): string | null {
  const s = origin.trim();
  const m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s) ??
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s) ??
    /^ssh:\/\/git@github\.com(?::\d+)?\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** Throws unless `cmd` is one of the two read-only git forms this module
 *  may run. A guard, not a convenience: the digest must never fetch,
 *  check out or write anything in a repo. */
export function assertReadOnlyGit(cmd: string[]): void {
  const ok =
    cmd[0] === "git" &&
    cmd[1] === "-C" &&
    typeof cmd[2] === "string" &&
    (cmd[3] === "log" || (cmd[3] === "remote" && cmd[4] === "get-url" && cmd[5] === "origin" && cmd.length === 6));
  if (!ok) throw new Error(`wissel-digest: refusing a git command that isn't read-only: ${cmd.join(" ")}`);
}

export interface DigestStory {
  title: string;
  date: string;
  sources: string[];
  facts: string;
}

export interface DigestStats {
  /** Card lineages active in the period (reviewer, pushback and
   *  integrator cards folded into their root). Pipeline runs are counted
   *  separately in `pipelineRuns`. */
  cards: number;
  done: number;
  failed: number;
  escalated: number;
  reviewPasses: number;
  pushbacks: number;
  spendUsd: number;
  byAgent: Record<string, number>;
  byHarness: Record<string, number>;
  byModel: Record<string, number>;
  retries429: number;
  pipelineRuns: Record<string, { runs: number; failed: number; costUsd: number }>;
}

export interface WisselDigest {
  period: { from: string; to: string; days: number };
  stats: DigestStats;
  stories: DigestStory[];
  lessons: string;
  docs: { file: string; title: string }[];
  /** Items dropped to keep the digest within DIGEST_LIMITS. */
  truncated: number;
}

export interface DigestInputs {
  board: { list(): Promise<TaskCard[]>; getResult(taskId: string): Promise<TaskResult | undefined> };
  /** telemetry.jsonl; undefined or missing means no spend data. */
  telemetryPath?: string;
  /** memory/lessons.md; undefined or missing means no lessons. */
  lessonsPath?: string;
  /** The docs/ directory whose SDD-*.md changes are reported (wissel's
   *  own); its git history is read with `git -C <docsDir> log`. */
  docsDir?: string;
  runner: CommandRunner;
  now: Date;
  /** The run input; the period is parsed from it. */
  input: string;
  /** Where task worktrees live (`~/.wissel/worktrees`). */
  worktreesRoot?: string;
  /** An agent's manifest model, for spend whose telemetry has no
   *  dispatch event naming one (pipeline steps). */
  agentModel?: (agentId: string) => string | undefined;
  /** The pipeline run doing the collecting, left out of its own digest. */
  excludeRunId?: string;
}

interface TelemetryLine {
  type?: string;
  taskId?: string;
  agentId?: string;
  model?: string;
  actualCost?: number;
  harnessId?: string;
  retryAfter?: string;
  at?: string;
}

async function readTelemetry(path: string | undefined): Promise<TelemetryLine[]> {
  if (!path) return [];
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: TelemetryLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TelemetryLine;
      if (e && typeof e === "object" && typeof e.at === "string") out.push(e);
    } catch {
      // a torn or foreign line; telemetry tolerates them (TelemetryLog.sumCostSince)
    }
  }
  return out;
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

function centsRecord(r: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cents(v)]));
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 3).trimEnd() + "..." : flat;
}

function firstLine(text: string | undefined): string {
  return (text ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const REVIEW_LABEL = "review";
const CONFLICT_LABEL = "conflict";
const INTEGRATOR_LABEL = "integration";
const CONFLICT_TITLE = /^Resolve merge conflict: (\S+)$/;
const MERGE_SUBJECT = /^Merge wissel\/([A-Za-z0-9_-]+): (.*)$/;

interface Commit {
  sha: string;
  /** Committer date, ISO 8601 with offset. */
  date: string;
  key: string;
  title: string;
  url: string | null;
  repo: string;
}

async function git(runner: CommandRunner, dir: string, args: string[]): Promise<string | null> {
  const cmd = ["git", "-C", dir, ...args];
  assertReadOnlyGit(cmd);
  try {
    const res = await runner(cmd, { cwd: dir });
    return res.exitCode === 0 ? res.stdout : null;
  } catch {
    return null;
  }
}

export async function buildWisselDigest(inp: DigestInputs): Promise<WisselDigest> {
  const period = parsePeriod(inp.input, inp.now);
  const fromMs = period.from.getTime();
  const toMs = period.to.getTime();
  const inWindow = (iso: string | undefined) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= fromMs && t <= toMs;
  };
  const worktreesRoot = inp.worktreesRoot ?? join(homedir(), ".wissel", "worktrees");

  const allCards = await inp.board.list();
  const byId = new Map(allCards.map((c) => [c.id, c]));
  const cards = allCards.filter((c) => !(inp.excludeRunId && (c.id === inp.excludeRunId || c.pipelineRunId === inp.excludeRunId)));

  // ---- telemetry: spend in the window, cost and last activity per task ----
  const events = await readTelemetry(inp.telemetryPath);
  const modelByTask = new Map<string, string>();
  const costByTask = new Map<string, number>();
  const lastSeen = new Map<string, number>();
  for (const e of events) {
    if (!e.taskId) continue;
    const t = Date.parse(e.at!);
    if (!Number.isNaN(t) && t <= toMs) lastSeen.set(e.taskId, Math.max(lastSeen.get(e.taskId) ?? 0, t));
    if (e.type === "dispatch" && typeof e.model === "string") modelByTask.set(e.taskId, e.model);
    if (e.type === "result" && typeof e.actualCost === "number") costByTask.set(e.taskId, (costByTask.get(e.taskId) ?? 0) + e.actualCost);
  }
  let spendUsd = 0;
  let retries429 = 0;
  const byAgent: Record<string, number> = {};
  const byHarness: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== "result" || !inWindow(e.at)) continue;
    if (typeof e.retryAfter === "string") retries429++;
    if (typeof e.actualCost !== "number") continue;
    const cost = e.actualCost;
    spendUsd += cost;
    const agent = e.agentId ?? "unknown";
    byAgent[agent] = (byAgent[agent] ?? 0) + cost;
    const harness = e.harnessId ?? "none";
    byHarness[harness] = (byHarness[harness] ?? 0) + cost;
    const model = (e.taskId && modelByTask.get(e.taskId)) || inp.agentModel?.(agent) || "unknown";
    byModel[model] = (byModel[model] ?? 0) + cost;
  }

  /** When a card was last active, from its own doneAt and telemetry;
   *  the board stores no creation time, so a card wissel never ran and
   *  never finished has none and is left out. */
  const activity = (c: TaskCard): number | undefined => {
    const times = [lastSeen.get(c.id), c.doneAt ? Date.parse(c.doneAt) : undefined].filter(
      (t): t is number => typeof t === "number" && !Number.isNaN(t) && t <= toMs,
    );
    return times.length ? Math.max(...times) : undefined;
  };

  // ---- lineages: reviewer, pushback and integrator cards fold into their root ----
  const rootCache = new Map<string, string>();
  const rootOf = (c: TaskCard, depth = 0): string => {
    const cached = rootCache.get(c.id);
    if (cached) return cached;
    let root = c.reviewLineageId ?? c.id;
    if (depth < 10) {
      const conflict = c.labels.includes(CONFLICT_LABEL) ? CONFLICT_TITLE.exec(c.title) : null;
      const original = conflict ? byId.get(conflict[1]!) : undefined;
      const parent = c.labels.includes(INTEGRATOR_LABEL) && c.parentTaskId ? byId.get(c.parentTaskId) : undefined;
      if (original) root = rootOf(original, depth + 1);
      else if (parent) root = rootOf(parent, depth + 1);
    }
    rootCache.set(c.id, root);
    return root;
  };

  const isWorktree = (repo: string) => repo === worktreesRoot || repo.startsWith(worktreesRoot + "/");
  /** A card's real repo: a worktree path maps to the repo of the card it
   *  was made for (the worktree key is that card's lineage id), else to
   *  its lineage root's repo. */
  const realRepo = (c: TaskCard): string | undefined => {
    const candidates: (string | undefined)[] = [c.repo];
    if (c.repo && isWorktree(c.repo)) {
      const key = c.repo.slice(worktreesRoot.length + 1).split("/")[0] ?? "";
      candidates.push(byId.get(key)?.repo, byId.get(rootOf(c))?.repo);
    }
    return candidates.find((r): r is string => !!r && !isWorktree(r));
  };

  const lineages = new Map<string, TaskCard[]>();
  const pipelineRoots: TaskCard[] = [];
  const stepsByRun = new Map<string, TaskCard[]>();
  for (const c of cards) {
    if (c.pipelineRunId) {
      stepsByRun.set(c.pipelineRunId, [...(stepsByRun.get(c.pipelineRunId) ?? []), c]);
      continue;
    }
    if (c.pipelineId) {
      pipelineRoots.push(c);
      continue;
    }
    const root = rootOf(c);
    lineages.set(root, [...(lineages.get(root) ?? []), c]);
  }

  // ---- pipeline runs, by pipeline name ----
  const pipelineRuns: DigestStats["pipelineRuns"] = {};
  for (const root of pipelineRoots) {
    const steps = stepsByRun.get(root.id) ?? [];
    const last = Math.max(...[root, ...steps].map((c) => activity(c) ?? 0));
    if (last < fromMs) continue;
    const name = root.title.replace(/^Pipeline: /, "");
    const entry = (pipelineRuns[name] ??= { runs: 0, failed: 0, costUsd: 0 });
    entry.runs++;
    if (root.status === "failed") entry.failed++;
    entry.costUsd += [root, ...steps].reduce((n, c) => n + (costByTask.get(c.id) ?? 0), 0);
  }
  for (const v of Object.values(pipelineRuns)) v.costUsd = cents(v.costUsd);

  // ---- git: merge commits in the window, per repo on the board ----
  const repos = new Set<string>();
  for (const c of cards) {
    const r = realRepo(c);
    if (r) repos.add(r);
  }
  const commits: Commit[] = [];
  for (const repo of [...repos].sort()) {
    if (!existsSync(repo)) continue;
    const log = await git(inp.runner, repo, ["log", "--merges", `--since=${period.from.toISOString()}`, `--until=${period.to.toISOString()}`, "--format=%H%x09%cI%x09%s"]);
    if (log === null) continue; // not a git checkout
    const parsed = log
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 3)
      .map(([sha, date, ...subject]) => ({ sha: sha!, date: date!, subject: subject.join("\t") }));
    const merges = parsed.map((p) => ({ ...p, m: MERGE_SUBJECT.exec(p.subject) })).filter((p) => p.m);
    if (merges.length === 0) continue;
    const origin = await git(inp.runner, repo, ["remote", "get-url", "origin"]);
    const base = origin ? githubRepoUrl(origin) : null;
    for (const p of merges) {
      commits.push({ sha: p.sha, date: p.date, key: p.m![1]!, title: p.m![2]!, url: base ? `${base}/commit/${p.sha}` : null, repo });
    }
  }
  const commitsByRoot = new Map<string, Commit[]>();
  const looseCommits: Commit[] = [];
  for (const commit of commits) {
    const card = byId.get(commit.key);
    const root = card ? rootOf(card) : undefined;
    if (root && lineages.has(root)) commitsByRoot.set(root, [...(commitsByRoot.get(root) ?? []), commit]);
    else looseCommits.push(commit);
  }

  // ---- one story per active lineage ----
  interface Ranked {
    story: DigestStory;
    cost: number;
    weight: number;
  }
  const ranked: Ranked[] = [];
  let active = 0;
  let done = 0;
  let failed = 0;
  let escalated = 0;
  let reviewPasses = 0;
  let pushbacks = 0;
  for (const [rootId, members] of lineages) {
    const merged = commitsByRoot.get(rootId) ?? [];
    const times = members.map(activity).filter((t): t is number => t !== undefined);
    const last = Math.max(0, ...times, ...merged.map((m) => Date.parse(m.date)).filter((t) => !Number.isNaN(t)));
    // git already limited the merges to the window
    if (last < fromMs && merged.length === 0) continue;

    const root = byId.get(rootId) ?? members[0]!;
    const attempts = members.filter((c) => !c.labels.includes(REVIEW_LABEL) && !c.labels.includes(CONFLICT_LABEL) && !c.labels.includes(INTEGRATOR_LABEL));
    const tip = [...attempts].reverse().find((c) => !c.supersededBy) ?? attempts[attempts.length - 1] ?? root;
    const escalation = members.find((c) => c.status === "escalated");
    const status = escalation ? "escalated" : tip.status;
    const passes = members.filter((c) => c.labels.includes(REVIEW_LABEL)).length;
    const pushes = Math.max(0, ...members.map((c) => c.pushbackCount ?? 0));
    const cost = members.reduce((n, c) => n + (costByTask.get(c.id) ?? 0), 0);
    const failures: string[] = [];
    for (const c of members.filter((m) => m.status === "failed")) {
      const reason = firstLine((await inp.board.getResult(c.id))?.summary);
      failures.push(reason ? cap(reason, 160) : "no reason recorded");
    }

    active++;
    if (status === "done") done++;
    if (status === "failed") failed++;
    if (status === "escalated") escalated++;
    reviewPasses += passes;
    pushbacks += pushes;

    const facts = [
      status,
      root.routedTo ? `by ${root.routedTo}` : "",
      passes ? count(passes, "review pass", "review passes") : "",
      pushes ? count(pushes, "pushback", "pushbacks") : "",
      escalation ? `escalated: ${cap(firstLine(escalation.escalationContext) || "no reason recorded", 160)}` : "",
      failures.length ? `failed ${failures.length}x, last: ${failures[failures.length - 1]}` : "",
      cost > 0 ? money(cost) : "",
      ...merged.map((m) => `merged ${m.sha.slice(0, 7)} into ${basename(m.repo)}`),
    ].filter(Boolean);
    ranked.push({
      story: {
        title: cap(root.title, DIGEST_LIMITS.maxTitleChars),
        date: ymd(new Date(last)),
        sources: merged.map((m) => m.url).filter((u): u is string => !!u),
        facts: cap(facts.join("; "), DIGEST_LIMITS.maxFactsChars),
      },
      cost,
      weight: (merged.length ? 4 : 0) + (escalation ? 2 : 0) + (failures.length ? 1 : 0),
    });
  }
  for (const m of looseCommits) {
    ranked.push({
      story: {
        title: cap(m.title, DIGEST_LIMITS.maxTitleChars),
        date: m.date.slice(0, 10),
        sources: m.url ? [m.url] : [],
        facts: cap(`merged ${m.sha.slice(0, 7)} into ${basename(m.repo)}; its card is not on the board`, DIGEST_LIMITS.maxFactsChars),
      },
      cost: 0,
      weight: 4,
    });
  }

  // Keep the biggest items when capped: merged first, then escalations
  // and failures, then by cost; shown newest first.
  ranked.sort((a, b) => b.weight - a.weight || b.cost - a.cost || b.story.date.localeCompare(a.story.date));
  let truncated = Math.max(0, ranked.length - DIGEST_LIMITS.maxStories);
  const stories = ranked
    .slice(0, DIGEST_LIMITS.maxStories)
    .sort((a, b) => b.story.date.localeCompare(a.story.date) || b.weight - a.weight || b.cost - a.cost)
    .map((r) => r.story);

  // ---- lessons.md, capped ----
  let lessons = "";
  if (inp.lessonsPath) {
    const raw = await readFile(inp.lessonsPath).catch(() => null);
    if (raw) {
      if (raw.byteLength > DIGEST_LIMITS.maxLessonsBytes) {
        lessons = new TextDecoder().decode(raw.subarray(0, DIGEST_LIMITS.maxLessonsBytes)).replace(/�+$/, "") + "\n[cut at 6 KB]";
      } else lessons = raw.toString("utf8");
    }
  }

  // ---- SDDs added or changed in the window ----
  const docs: { file: string; title: string }[] = [];
  if (inp.docsDir && existsSync(inp.docsDir)) {
    const log = await git(inp.runner, inp.docsDir, ["log", `--since=${period.from.toISOString()}`, `--until=${period.to.toISOString()}`, "--name-only", "--format=", "--", "SDD-*.md"]);
    const files = [...new Set((log ?? "").split("\n").map((l) => l.trim()).filter((l) => /(^|\/)SDD-[^/]+\.md$/.test(l)))].sort();
    for (const file of files) {
      const text = await readFile(join(inp.docsDir, basename(file)), "utf8").catch(() => null);
      if (text === null) continue; // deleted since
      const heading = /^#\s+(.+)$/m.exec(text)?.[1] ?? basename(file);
      docs.push({ file, title: cap(heading, DIGEST_LIMITS.maxTitleChars) });
    }
  }
  if (docs.length > DIGEST_LIMITS.maxDocs) {
    truncated += docs.length - DIGEST_LIMITS.maxDocs;
    docs.length = DIGEST_LIMITS.maxDocs;
  }

  const digest: WisselDigest = {
    period: { from: ymd(period.from), to: ymd(period.to), days: period.days },
    stats: {
      cards: active,
      done,
      failed,
      escalated,
      reviewPasses,
      pushbacks,
      spendUsd: cents(spendUsd),
      byAgent: centsRecord(byAgent),
      byHarness: centsRecord(byHarness),
      byModel: centsRecord(byModel),
      retries429,
      pipelineRuns,
    },
    stories,
    lessons,
    docs,
    truncated,
  };

  // Whole payload within one prompt's budget: drop the last stories, then
  // shorten lessons.md, counting what was dropped.
  const size = () => Buffer.byteLength(JSON.stringify(digest), "utf8");
  while (size() > DIGEST_LIMITS.maxPayloadBytes && digest.stories.length > 0) {
    digest.stories.pop();
    digest.truncated++;
  }
  if (size() > DIGEST_LIMITS.maxPayloadBytes) {
    const over = size() - DIGEST_LIMITS.maxPayloadBytes;
    digest.lessons = digest.lessons.slice(0, Math.max(0, digest.lessons.length - over - 32)) + "\n[cut]";
    digest.truncated++;
  }
  return digest;
}
