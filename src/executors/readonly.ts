import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";

/**
 * No worktree, no session. Plain API call. This is the cheap path and
 * should cover triage, planning, review, and memory curation.
 */
export class ReadOnlyExecutor implements Executor {
  readonly id = "readonly";

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "readonly";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    void task;
    void agent;
    throw new Error("not implemented");
  }
}
