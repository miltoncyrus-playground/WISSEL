import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";

export interface WriteExecutorOptions {
  runner?: CommandRunner;
  model?: string;
}

/**
 * Opt-in local execution for write-tier work — headless `claude -p` with
 * `--permission-mode acceptEdits`, so file edits land without a human in
 * the loop but anything riskier (Bash and friends) still needs an
 * approval a headless run can't give, and surfaces as a permission
 * denial in the result rather than silently going through.
 *
 * Not registered by default: the documented design is "wissel decides,
 * agetor executes" (see Orchestrator's `executeWriteTier` option and the
 * WISSEL_EXECUTE_WRITE_TIER env var, both off unless explicitly turned
 * on). This exists for a setup with no agetor where wissel should run
 * the whole loop itself — a write-tier success still lands in `review`,
 * never `done`, regardless of how it ran, so the human gate is
 * unaffected by who did the work.
 */
export class WriteExecutor implements Executor {
  readonly id = "write";
  private runner: CommandRunner;
  private model?: string;

  constructor(opts: WriteExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write";
  }

  run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    return runClaude({ runner: this.runner, task, agent, permissionMode: "acceptEdits", model: this.model });
  }
}
