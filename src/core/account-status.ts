import { resolveModel } from "./model-resolution.ts";
import type { AgentDef, Harness, HarnessTool, PipelineDef, TaskCard } from "./types.ts";

/** One task currently running on a harness, as the board's account line
 *  shows it. `agentId`/`model` are null when they can't be determined
 *  (no routedTo and no pipeline step to read it from, or an agent id the
 *  registry doesn't know) rather than guessed. */
export interface AccountRunningTask {
  taskId: string;
  title: string;
  agentId: string | null;
  model: string | null;
}

/** `GET /status/accounts` row: one per enabled harness, in pool order. */
export interface AccountStatus {
  id: string;
  label: string;
  tool: HarnessTool;
  activeCount: number;
  maxConcurrent?: number;
  defaultModel?: string;
  running: AccountRunningTask[];
}

export interface AccountStatusInput {
  /** Pool order (`HarnessPool.all()`), which is harnesses.yaml order for
   *  manual entries. Disabled ones are dropped here. */
  harnesses: Harness[];
  /** Any task list; only `status: "running"` tasks are read. */
  tasks: TaskCard[];
  agents: { get(id: string): AgentDef | undefined };
  activeCount: (harnessId: string) => number;
  /** Only needed for pipeline step cards, which run a step's agent
   *  without ever setting `routedTo` (src/core/pipeline-runner.ts). */
  pipelines?: PipelineDef[];
}

/** Which agent a running task is executing: `routedTo` for a board task
 *  (set by the orchestrator's sweep), or the step's `agentId` for a
 *  pipeline step card, read from the same stored definition the runner
 *  used. Undefined when neither applies. */
function runningAgentId(task: TaskCard, pipelines: PipelineDef[]): string | undefined {
  if (task.routedTo) return task.routedTo;
  if (!task.pipelineId || !task.pipelineStepId) return undefined;
  const def = pipelines.find((p) => p.id === task.pipelineId);
  return def?.graph.steps.find((s) => s.id === task.pipelineStepId)?.agentId;
}

/**
 * What the board's account line shows: every enabled harness with its
 * live load and the tasks running on it right now. A task counts for a
 * harness when it is `running` and its `harness` stamp (set at acquire,
 * src/core/orchestrator.ts and src/core/pipeline-runner.ts) names it, so
 * a running task with no stamp yet, or stamped with a harness that's
 * since been disabled, is not attributed to any chip.
 *
 * The model comes from `resolveModel`, the same function every executor
 * calls, so the line shows what actually runs.
 */
export function buildAccountStatus(input: AccountStatusInput): AccountStatus[] {
  const pipelines = input.pipelines ?? [];
  const running = input.tasks.filter((t) => t.status === "running" && t.harness);
  return input.harnesses
    .filter((h) => h.enabled)
    .map((h) => {
      const row: AccountStatus = {
        id: h.id,
        label: h.label,
        tool: h.tool,
        activeCount: input.activeCount(h.id),
        running: running
          .filter((t) => t.harness === h.id)
          .map((t) => {
            const agentId = runningAgentId(t, pipelines);
            const agent = agentId ? input.agents.get(agentId) : undefined;
            return { taskId: t.id, title: t.title, agentId: agentId ?? null, model: agent ? resolveModel(t, agent, h) : null };
          }),
      };
      if (h.maxConcurrent !== undefined) row.maxConcurrent = h.maxConcurrent;
      if (h.model !== undefined) row.defaultModel = h.model;
      return row;
    });
}
