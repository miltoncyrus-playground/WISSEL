// The Board tab's compact read of /tasks (docs/SDD-wissel-app.md §3.1):
// four lanes, Running, Needs you, Review, Done today. Pure: the Board
// tab and the desktop Live panel both draw what this returns.
//
// Same reading of a card as /board (src/api/public/board-lanes.js):
// archived and superseded cards never show; Needs you is review,
// escalated, failed, no-match, and any card with an open MCP approval.
// Review is the automated reviewer's queue (pending-review). Inbox and
// ready cards are queued, not shown here: the full board has them.

import type { TaskCard } from "./types";

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
  if (NEEDS_YOU_STATUSES.has(t.status)) return "needs-you";
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

/** A few words on why a card needs Milton, like the board's
 *  needsYouReason. */
export function needsYouReason(t: TaskCard): string {
  if (t.pendingMcpApproval && t.status === "review") return `Approve ${t.pendingMcpApproval.server} · ${t.pendingMcpApproval.tool}`;
  switch (t.status) {
    case "review": return "Ready for your review";
    case "escalated": return "Reviewer escalated it";
    case "failed": return "Failed";
    case "no-match": return "No agent matched";
    default: return t.status;
  }
}
