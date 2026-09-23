import type { AgentDef, Harness, TaskCard } from "./types.ts";

/**
 * The shared model-selection precedence, read by every executor —
 * see the ordering documented next to CostProfile/Harness in types.ts.
 * Callers still layer their own constructor-override check on top of
 * this (`this.model ?? resolveModel(...)`) — that level is tests/evals
 * only and deliberately lives outside this function, not a fifth tier
 * inside it.
 */
export function resolveModel(task: TaskCard, agent: AgentDef, harness?: Harness): string {
  return task.model ?? harness?.model ?? agent.costProfile.model;
}
