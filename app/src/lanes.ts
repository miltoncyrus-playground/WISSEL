// The Board tab's compact read of /tasks (docs/SDD-wissel-app.md §3.1):
// five lanes, Running, Needs a human, Next step, Review, Done today.
// Pure: the Board tab and the desktop Live panel both draw what this
// returns.
//
// Same reading of a card as /board (src/api/public/board-lanes.js):
// archived and superseded cards never show. The server's needsYou.lane
// decides first: "human" is Needs a human (a decision, with why and a
// checklist), and a review card on "next-step" (an approved merge, a
// passed review report) is Next step. Without a lane (an older server),
// Needs a human is review, escalated, failed, no-match and any card with
// an open MCP approval. Review is the automated reviewer's queue
// (pending-review). Inbox and ready cards are queued, not shown here:
// the full board has them, except one the server puts on "human" (its
// dependency is gone).

import type { NeedsYou, TaskCard } from "./types";

export type LaneId = "running" | "needs-you" | "next-step" | "review" | "done-today";

export const LANES: readonly { id: LaneId; label: string }[] = [
  { id: "running", label: "Running" },
  { id: "needs-you", label: "Needs a human" },
  { id: "next-step", label: "Next step" },
  { id: "review", label: "Review" },
  { id: "done-today", label: "Done today" },
];

const NEEDS_YOU_STATUSES = new Set(["review", "escalated", "failed", "no-match"]);

export function laneOf(t: TaskCard, startOfToday: number): LaneId | null {
  if (t.archivedAt || t.supersededBy) return null;
  if (t.pendingMcpApproval && t.status === "review") return "needs-you";
  const lane = t.needsYou?.lane;
  if (lane === "human") return "needs-you";
  if (lane === "next-step") return t.status === "review" ? "next-step" : null;
  if (NEEDS_YOU_STATUSES.has(t.status) || t.needsYou) return "needs-you";
  if (t.status === "running" || t.status === "dispatched") return "running";
  if (t.status === "pending-review") return "review";
  if (t.status === "done") {
    const at = Date.parse(t.doneAt ?? "");
    return !isNaN(at) && at >= startOfToday ? "done-today" : null;
  }
  return null;
}

/** Local midnight for `now` (ms), so "today" is Milton's day, not UTC's. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type Lanes = Record<LaneId, TaskCard[]>;

const REVIEWER_OPEN: ReadonlySet<string> = new Set(["inbox", "ready", "running", "dispatched"]);

function isReviewerCard(t: TaskCard): boolean {
  return !!t.parentTaskId && (t.routedTo === "reviewer" || t.labels.includes("review"));
}

/** Pending-review card id → whether its reviewer is running, for every
 *  card a live reviewer card is reviewing (board-lanes.js
 *  reviewsInFlight): the review is one piece of work, so it draws once,
 *  in Review, never also as the reviewer's card in Running. */
export function reviewsInFlight(tasks: readonly TaskCard[]): Map<string, boolean> {
  const pending = new Set(tasks.filter((t) => t.status === "pending-review" && !t.archivedAt && !t.supersededBy).map((t) => t.id));
  const out = new Map<string, boolean>();
  for (const t of tasks) {
    if (t.archivedAt || t.supersededBy || !isReviewerCard(t) || !REVIEWER_OPEN.has(t.status) || !pending.has(t.parentTaskId!)) continue;
    out.set(t.parentTaskId!, out.get(t.parentTaskId!) || t.status === "running" || t.status === "dispatched");
  }
  return out;
}

/** Every lane, in `tasks` order except Done today, which is newest
 *  first. A live reviewer card is left out while the card it reviews
 *  waits in Review, and that card is marked reviewInProgress while the
 *  reviewer runs. */
export function partitionLanes(tasks: readonly TaskCard[], now: number): Lanes {
  const start = startOfLocalDay(now);
  const out: Lanes = { running: [], "needs-you": [], "next-step": [], review: [], "done-today": [] };
  const inFlight = reviewsInFlight(tasks);
  for (const t of tasks) {
    if (isReviewerCard(t) && REVIEWER_OPEN.has(t.status) && inFlight.has(t.parentTaskId!)) continue;
    const lane = laneOf(t, start);
    if (!lane) continue;
    out[lane].push(lane === "review" && inFlight.get(t.id) ? { ...t, reviewInProgress: true } : t);
  }
  out["done-today"].sort((a, b) => Date.parse(b.doneAt!) - Date.parse(a.doneAt!));
  return out;
}

/** A few words on why a card needs Milton: the server's needsYou.line,
 *  else (an older server) the board's needsYouReason status words. */
export function needsYouReason(t: TaskCard): string {
  if (t.needsYou?.line) return t.needsYou.line;
  if (t.pendingMcpApproval && t.status === "review") return `Approve ${t.pendingMcpApproval.server} · ${t.pendingMcpApproval.tool}`;
  switch (t.status) {
    case "review": return "Ready for your review";
    case "escalated": return "Reviewer escalated it";
    case "failed": return "Failed";
    case "no-match": return "No agent matched";
    default: return t.status;
  }
}

/** Kinds whose row shows needsYou.reason under the line. */
const REASON_KINDS: ReadonlySet<NeedsYou["kind"]> = new Set(["escalated", "grant-tools"]);
/** Kinds whose row shows the blocking card. */
const BLOCKER_KINDS: ReadonlySet<NeedsYou["kind"]> = new Set(["blocked-on", "merge-after"]);

/** A reason longer than this, or on more than this many lines, gets
 *  the expand toggle (the row clips it to REASON_LINES lines). */
export const REASON_LINES = 3;
const REASON_CHARS = 200;

/** Everything a Needs you row draws, from the card alone. */
export interface NeedsYouView {
  line: string;
  /** Why the card waits, in full sentences. */
  why?: string;
  /** human lane: the steps, each one a tick-box. */
  checklist?: string[];
  /** escalated/grant-tools: the full text, "No reason recorded" as-is. */
  reason?: string;
  /** Whether the reason is long enough to clip behind a toggle. */
  reasonLong: boolean;
  /** grant-tools: "round N". */
  round?: string;
  /** grant-tools: the tools it asks for. */
  grants?: string[];
  /** blocked-on/merge-after: "1a2b3c4d · escalated". */
  blocker?: string;
  /** The one button; absent on an older server. */
  action?: NeedsYou["action"];
}

export function needsYouView(t: TaskCard): NeedsYouView {
  const ny = t.needsYou;
  const view: NeedsYouView = { line: needsYouReason(t), reasonLong: false };
  if (!ny) return view;
  view.action = ny.action;
  if (ny.why) view.why = ny.why;
  if (ny.checklist?.length) view.checklist = [...ny.checklist];
  if (REASON_KINDS.has(ny.kind) && ny.reason) {
    view.reason = ny.reason;
    view.reasonLong = ny.reason.length > REASON_CHARS || ny.reason.split("\n").length > REASON_LINES;
  }
  if (ny.kind === "grant-tools") {
    if (ny.rounds !== undefined) view.round = `round ${ny.rounds}`;
    if (ny.grants?.length) view.grants = [...ny.grants];
  }
  if (BLOCKER_KINDS.has(ny.kind) && ny.blocker) view.blocker = `${ny.blocker.id8} · ${ny.blocker.status}`;
  return view;
}
