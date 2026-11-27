// Type declaration for board-lanes.js — a plain browser script (no
// build step, see its own header comment) that's also imported directly
// by bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
import type { TaskCard } from "../../core/types.ts";

export type LaneId = "queued" | "working" | "in-review" | "next-step" | "done";
export type Placement = LaneId | "needs-you";
export type DisplayStatus = TaskCard["status"] | "reviewing" | "review-in-progress";

export const NEEDS_YOU: "needs-you";
export const BOARD_LANES: { id: LaneId; label: string }[];
export const STATUS_DISPLAY: Record<string, { lane: Placement; label: string; color: string }>;
export const DONE_WINDOW_MS: number;

type BoardTask = Partial<TaskCard> & Pick<TaskCard, "status">;

export function taskDisplayStatus(t: BoardTask): DisplayStatus;
export function reviewsInFlight(tasks: BoardTask[]): Record<string, "queued" | "running">;
export function boardDisplayStatus(t: BoardTask, inFlight?: Record<string, "queued" | "running">): DisplayStatus;
export function hasPendingMcpApproval(t: BoardTask): boolean;
export function taskPlacement(t: BoardTask): Placement;
export function statusLabel(status: string): string;
export function statusColor(status: string): string;
export function needsYouReason(t: BoardTask): string;
export function needsYouLine(t: BoardTask): string;
export function doneTime(t: BoardTask): number | null;

export interface BoardPartition<T> {
  needsYou: T[];
  lanes: Record<LaneId, T[]>;
  superseded: T[];
  doneTotal: number;
  doneHidden: number;
  /** Pending-review card id → its live reviewer's state. */
  reviewsInFlight: Record<string, "queued" | "running">;
}

export function partitionBoard<T extends BoardTask>(
  tasks: T[],
  opts?: { now?: number; showAllDone?: boolean; showSuperseded?: boolean },
): BoardPartition<T>;
