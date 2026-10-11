import type { TaskCard } from "../core/types.ts";
import type { ResultMeta } from "./board.ts";
import type { TelemetryLine } from "./news-run-checks.ts";

/**
 * The feed: what happened, newest first (docs/SDD-wissel-app.md §3.2).
 * Pure: buildFeed reads only what it is handed (cards, their latest
 * results, podcast runs already read off disk, parsed telemetry, the
 * clock) and returns the same items for the same input. `GET /feed`
 * (src/api/server.ts, via src/services/feed-sources.ts) gathers the
 * input; the app's Feed screen and Stories draw what comes back.
 *
 * Kinds:
 *   landed     a card reached `done` (its merge branch when it had a worktree).
 *   needs-you  review, escalated, failed, no-match, an open MCP approval,
 *              or a queued card pinned to a disabled harness. Each carries
 *              the one action the board supports for it.
 *   podcast    a podcast run with audio.
 *   checks     the check-news-run result for a podcast run.
 *   spend      one per past day: that day's spend by harness.
 */

export const FEED_KINDS = ["landed", "needs-you", "podcast", "checks", "spend"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** Which show a podcast or checks item belongs to: the Stories group. */
export type FeedShow = "ai" | "world" | "retro" | "other";

export interface FeedLink {
  label: string;
  href: string;
  /** Absent: a plain link. "POST": an action endpoint the app calls. */
  method?: "POST";
}

export interface FeedItem {
  /** Stable across requests: `<kind>:<task or run id>`, `spend:<day>`. */
  id: string;
  kind: FeedKind;
  /** ISO time the thing happened. */
  at: string;
  title: string;
  detail: string;
  links: FeedLink[];
  taskId?: string;
  runId?: string;
  /** needs-you only: no recorded time, so `at` is the request's `now`. */
  undated?: boolean;
  /** podcast and checks. */
  show?: FeedShow;
  /** podcast: where the MP3 plays from. */
  audioUrl?: string;
  /** podcast: length of the MP3, when it could be read. */
  durationSeconds?: number;
  /** podcast: the pipeline's name (the mini-player's second line). */
  pipelineName?: string;
  /** checks: true when every check passed. */
  pass?: boolean;
}

/** A podcast run with audio, read by the server (feed-sources.ts). */
export interface FeedRun {
  runId: string;
  pipelineName: string;
  show: FeedShow;
  /** When the run finished; undefined drops the run (nothing to date it by). */
  at?: string;
  /** First quick-read headline. */
  headline?: string;
  durationSeconds?: number;
  audioUrl: string;
  /** checkStoredRun's result; undefined when the run can't be checked. */
  checks?: { pass: boolean; total: number; failed: string[] };
}

/** Where a page starts: items strictly after this in feed order. */
export interface FeedCursor {
  at: number;
  /** Tie-break for items at the same millisecond; absent means "all of them". */
  id?: string;
}

export interface FeedInput {
  tasks: readonly TaskCard[];
  /** Each task's latest result (Board.listResultMeta). */
  results?: ReadonlyMap<string, ResultMeta>;
  runs?: readonly FeedRun[];
  telemetry?: readonly TelemetryLine[];
  /** Ids of harnesses that are switched off. */
  disabledHarnesses?: readonly string[];
  now: number;
  limit: number;
  before?: FeedCursor;
}

export interface FeedPage {
  items: FeedItem[];
  /** Pass as `before` for the next page; null on the last page. */
  next: string | null;
}

const NEEDS_YOU_STATUSES = new Set<TaskCard["status"]>(["review", "escalated", "failed", "no-match"]);

/** The app's card view, which works from anywhere. */
export function cardHref(taskId: string): string {
  return `/app#/board/${encodeURIComponent(taskId)}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function parseTime(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Local midnight at or before `ms`. */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "2026-10-09" for a local day. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nextLocalMidnight(dayStart: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** "12 min", "45 s". */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** The latest telemetry `at` per task id. */
function lastTelemetryAt(telemetry: readonly TelemetryLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of telemetry) {
    if (!e.taskId) continue;
    const at = parseTime(e.at);
    if (at === undefined) continue;
    if (at > (out.get(e.taskId) ?? -Infinity)) out.set(e.taskId, at);
  }
  return out;
}

/** True for the bookkeeping cards a person never asked for: a
 *  pipeline's step cards and the automated reviewer's cards. */
function isBookkeeping(t: TaskCard): boolean {
  return t.pipelineRunId !== undefined || (t.parentTaskId !== undefined && t.labels.includes("review"));
}

function repoName(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  return repo.replace(/\/+$/, "").split("/").pop() || undefined;
}

function landedItem(t: TaskCard, at: number, result: ResultMeta | undefined): FeedItem {
  const who = [result?.agentId ?? t.routedTo, repoName(t.repo)].filter(Boolean).join(" in ");
  const detail = result?.worktreeBranch ? `Merged ${result.worktreeBranch}${who ? ` · ${who}` : ""}` : who || "Done";
  return {
    id: `landed:${t.id}`,
    kind: "landed",
    at: iso(at),
    title: t.title || t.id.slice(0, 8),
    detail,
    links: [{ label: "Open", href: cardHref(t.id) }],
    taskId: t.id,
  };
}

/** Why a card needs Milton and the one action the board offers for it,
 *  or null when it doesn't need him. */
export function needsYouAction(t: TaskCard, disabledHarnesses: ReadonlySet<string>): { detail: string; link: FeedLink } | null {
  if (t.archivedAt || t.supersededBy) return null;
  const open = { label: "Open", href: cardHref(t.id) };
  if (t.pendingMcpApproval && t.status === "review") {
    return {
      detail: `Wants to call ${t.pendingMcpApproval.server} · ${t.pendingMcpApproval.tool}`,
      link: { label: "Approve", href: `/tasks/${encodeURIComponent(t.id)}/mcp-approval/approve`, method: "POST" },
    };
  }
  if (NEEDS_YOU_STATUSES.has(t.status)) {
    switch (t.status) {
      case "review":
        return { detail: "Ready for your review", link: open };
      case "escalated":
        return { detail: "The reviewer escalated it", link: open };
      case "failed":
        return { detail: "Failed", link: { label: "Retry", href: `/tasks/${encodeURIComponent(t.id)}/run`, method: "POST" } };
      default:
        return { detail: "No agent matched it", link: open };
    }
  }
  if ((t.status === "inbox" || t.status === "ready") && t.harnessOverride && disabledHarnesses.has(t.harnessOverride)) {
    return { detail: `Held: ${t.harnessOverride} is switched off`, link: open };
  }
  return null;
}

/** Yesterday's (and every earlier day's) spend by harness, one item per
 *  local day with spend, dated the midnight that closed the day. Today
 *  is still running, so it has no item yet. */
export function spendItems(telemetry: readonly TelemetryLine[], now: number): FeedItem[] {
  const today = startOfLocalDay(now);
  const days = new Map<number, Map<string, number>>();
  for (const e of telemetry) {
    if (e.type !== "result" || typeof e.actualCost !== "number" || !(e.actualCost > 0)) continue;
    const at = parseTime(e.at);
    if (at === undefined || at >= today) continue;
    const day = startOfLocalDay(at);
    const byHarness = days.get(day) ?? new Map<string, number>();
    const h = e.harnessId || "unknown";
    byHarness.set(h, (byHarness.get(h) ?? 0) + e.actualCost);
    days.set(day, byHarness);
  }
  const out: FeedItem[] = [];
  for (const [day, byHarness] of days) {
    const total = [...byHarness.values()].reduce((a, b) => a + b, 0);
    const parts = [...byHarness.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const name = localDay(day);
    out.push({
      id: `spend:${name}`,
      kind: "spend",
      at: iso(nextLocalMidnight(day)),
      title: `${formatUsd(total)} spent on ${name}`,
      detail: parts.map(([h, v]) => `${h} ${formatUsd(v)}`).join(" · "),
      links: [],
    });
  }
  return out;
}

/** The board's run view (board-routes.js `pipelines/run/:runId`). */
export function runHref(runId: string): string {
  return `/board#/pipelines/run/${encodeURIComponent(runId)}`;
}

function podcastItems(run: FeedRun, at: number): FeedItem[] {
  const items: FeedItem[] = [
    {
      id: `podcast:${run.runId}`,
      kind: "podcast",
      at: iso(at),
      title: run.headline ?? run.pipelineName,
      detail: [run.pipelineName, run.durationSeconds !== undefined ? formatDuration(run.durationSeconds) : undefined].filter(Boolean).join(" · "),
      links: [{ label: "Download", href: run.audioUrl }],
      runId: run.runId,
      show: run.show,
      audioUrl: run.audioUrl,
      pipelineName: run.pipelineName,
      ...(run.durationSeconds !== undefined ? { durationSeconds: run.durationSeconds } : {}),
    },
  ];
  if (run.checks) {
    const failed = run.checks.failed.length;
    items.push({
      // Sorts right after its podcast item at the same time (see compareItems).
      id: `podcast:${run.runId}:checks`,
      kind: "checks",
      at: iso(at),
      title: failed === 0 ? `All ${run.checks.total} checks passed` : `${failed} of ${run.checks.total} checks failed`,
      detail: failed === 0 ? run.pipelineName : `${run.pipelineName}: ${run.checks.failed.join(", ")}`,
      links: [{ label: "Open run", href: runHref(run.runId) }],
      runId: run.runId,
      show: run.show,
      pass: failed === 0,
    });
  }
  return items;
}

/** Feed order: newest first, then by id so equal times are stable. */
export function compareItems(a: Pick<FeedItem, "at" | "id">, b: Pick<FeedItem, "at" | "id">): number {
  const d = Date.parse(b.at) - Date.parse(a.at);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function afterCursor(item: FeedItem, c: FeedCursor): boolean {
  const at = Date.parse(item.at);
  if (at !== c.at) return at < c.at;
  return c.id === undefined ? false : item.id > c.id;
}

/** `before` as given to GET /feed: an ISO time, or the `next` value of
 *  a previous page (`<iso>~<id>`). null when it can't be read. */
export function parseCursor(s: string): FeedCursor | null {
  const i = s.indexOf("~");
  const time = i === -1 ? s : s.slice(0, i);
  const at = Date.parse(time);
  if (Number.isNaN(at)) return null;
  return i === -1 ? { at } : { at, id: s.slice(i + 1) };
}

export function formatCursor(item: Pick<FeedItem, "at" | "id">): string {
  return `${item.at}~${item.id}`;
}

export function buildFeed(input: FeedInput): FeedPage {
  const { tasks, now } = input;
  const results = input.results ?? new Map<string, ResultMeta>();
  const telemetry = input.telemetry ?? [];
  const runs = input.runs ?? [];
  const disabled = new Set(input.disabledHarnesses ?? []);
  const lastAt = lastTelemetryAt(telemetry);
  const podcastRunIds = new Set(runs.map((r) => r.runId));
  const items: FeedItem[] = [];

  for (const t of tasks) {
    const result = results.get(t.id);
    const finished = parseTime(result?.finishedAt) ?? lastAt.get(t.id);

    // A podcast run's root is told as its podcast item instead.
    if (t.status === "done" && !t.supersededBy && !isBookkeeping(t) && !podcastRunIds.has(t.id)) {
      const at = parseTime(t.doneAt) ?? finished;
      if (at !== undefined) items.push(landedItem(t, at, result));
      continue;
    }
    if (t.pipelineRunId !== undefined) continue;
    const need = needsYouAction(t, disabled);
    if (!need) continue;
    items.push({
      id: `needs-you:${t.id}`,
      kind: "needs-you",
      at: iso(finished ?? now),
      title: t.title || t.id.slice(0, 8),
      detail: need.detail,
      links: [need.link],
      taskId: t.id,
      ...(finished === undefined ? { undated: true } : {}),
    });
  }

  for (const run of runs) {
    const at = parseTime(run.at);
    if (at !== undefined) items.push(...podcastItems(run, at));
  }
  items.push(...spendItems(telemetry, now));

  items.sort(compareItems);
  const limit = Math.max(1, Math.floor(input.limit));
  const page = input.before ? items.filter((i) => afterCursor(i, input.before!)) : items;
  const out = page.slice(0, limit);
  return { items: out, next: page.length > limit ? formatCursor(out[out.length - 1]!) : null };
}
