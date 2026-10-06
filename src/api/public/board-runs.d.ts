// Type declaration for board-runs.js — a plain browser script (no build
// step, see its own header comment) that's also imported directly by
// bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
import type { PipelineDef, TaskCard } from "../../core/types.ts";
import type { BoardPartition, DisplayStatus } from "./board-lanes.d.ts";

type RunTask = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
type RunPipeline = Partial<Pick<PipelineDef, "graph">> | null | undefined;

export const RUN_STEP_PENDING: "pending";

export interface RunIndex<T> {
  byId: Record<string, T>;
  steps: Record<string, T[]>;
}

export interface RunStepRef {
  taskId: string;
  name: string;
  attempt: number;
}

export interface RunProgress {
  done: number;
  total: number;
  current: RunStepRef | null;
  failedAt: RunStepRef | null;
  segments: { taskId: string | null; name: string; status: DisplayStatus | "pending" }[];
  text: string;
}

export function isPipelineStep(t: RunTask | null | undefined): boolean;
export function indexRuns<T extends RunTask>(tasks: T[] | null | undefined): RunIndex<T>;
export function runStepsOf<T extends RunTask>(index: RunIndex<T> | null | undefined, runId: string): T[];
export function runRootOf<T extends RunTask>(t: T, index: RunIndex<T>): T | null;
export function foldsIntoRun<T extends RunTask>(t: T, index: RunIndex<T>): boolean;
export function stepDisplayName(step: RunTask, root: RunTask | null | undefined, def: RunPipeline): string;
export function latestStepCards<T extends RunTask>(steps: T[] | null | undefined): { key: string; card: T; attempt: number }[];
export function runProgress(root: RunTask | null | undefined, steps: RunTask[] | null | undefined, def: RunPipeline): RunProgress;
export function runNeedsYouSteps<T extends RunTask>(steps: T[] | null | undefined): T[];
export function runNeedsYouReason(root: RunTask, steps: RunTask[] | null | undefined, def: RunPipeline): string;
export function partitionRunBoard<T extends RunTask>(
  tasks: T[],
  allTasks: T[] | null | undefined,
  opts?: { now?: number; showAllDone?: boolean; showSuperseded?: boolean },
): BoardPartition<T> & { index: RunIndex<T> };
