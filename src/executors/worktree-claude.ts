import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";
import type { WorktreeService } from "../services/worktree.ts";
import type { SessionSupervisor } from "../services/session.ts";
import type { Provisioner } from "../services/provisioner.ts";

/** The agetor path, unchanged in behaviour but decomposed into services. */
export class WorktreeClaudeExecutor implements Executor {
  readonly id = "worktree-claude";

  constructor(
    private worktrees: WorktreeService,
    private sessions: SessionSupervisor,
    private provisioner: Provisioner,
  ) {}

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    void task;
    void agent;
    void this.worktrees;
    void this.sessions;
    void this.provisioner;
    throw new Error("not implemented");
  }
}
