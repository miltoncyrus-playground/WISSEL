// Type declaration for board-pipelines.js — a plain browser script (no
// build step, see its own header comment) that's also imported directly
// by bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
import type { AgentDef, PipelineDef, TaskCard } from "../../core/types.ts";

type RunTask = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
type ListedPipeline = Pick<PipelineDef, "id" | "name"> & Partial<PipelineDef>;

export function isPipelineRunRoot(t: RunTask | null | undefined): boolean;

export function lastRunsByPipeline<T extends RunTask>(tasks: T[] | null | undefined): Record<string, T>;

export function pipelineStepCount(p: ListedPipeline | null | undefined): number;

export function formatStepCount(n: number): string;

export function pipelineRows<P extends ListedPipeline, T extends RunTask>(
  pipelines: P[] | null | undefined,
  tasks: T[] | null | undefined,
): { pipeline: P; stepCount: number; lastRun: T | null }[];

export function pipelineNeedsRepo(
  p: ListedPipeline | null | undefined,
  agents: Pick<AgentDef, "id" | "tier" | "toolAccess">[] | null | undefined,
): boolean;
