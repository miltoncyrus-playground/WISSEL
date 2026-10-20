// The Board tab's compact read of /tasks (docs/SDD-wissel-app.md §3.1):
// four lanes, Running, Needs you, Review, Done today. Pure: the Board
// tab and the desktop Live panel both draw what this returns.
//
// Same reading of a card as /board (src/api/public/board-lanes.js):
// archived and superseded cards never show; Needs you is review,
// escalated, failed, no-match, and any card with an open MCP approval.
// Review is the automated reviewer's queue (pending-review). Inbox and
// ready cards are queued, not shown here: the full board has them,
// except one the server marks needsYou (blocked-on a stuck dependency).

import type { NeedsYou, TaskCard } from "./types";

export type LaneId = "running" | "needs-you" | "review" | "done-today";

export const LANES: readonly { id: LaneId; label: string }[] = [
  { id: "running", label: "Running" },
  { id: "needs-you", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "done-today", label: "Done today" },
];

const NEEDS_YOU_STATUSES = new Set(["review", "escalated", "failed", "no-match"]);

export function laneOf(t: TaskCard, startOfToday: number): LaneId | null {
  if (t.archivedAt || t.supersededBy) return null;
  if (t.pendingMcpApproval && t.status === "review") return "needs-you";
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

/** Every lane, in `tasks` order except Done today, which is newest
 *  first. */
export function partitionLanes(tasks: readonly TaskCard[], now: number): Lanes {
  const start = startOfLocalDay(now);
  const out: Lanes = { running: [], "needs-you": [], review: [], "done-today": [] };
  for (const t of tasks) {
    const lane = laneOf(t, start);
    if (lane) out[lane].push(t);
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
