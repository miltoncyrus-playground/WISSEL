import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";

export type { CommandResult, CommandRunner } from "./claude-cli.ts";

export interface ReadOnlyExecutorOptions {
  runner?: CommandRunner;
  model?: string;
}

/**
 * No worktree, no session. Plain headless `claude -p` call in plan mode.
 * Plan mode is claude's own read-only enforcement — verified empirically
 * (see test/readonly.eval.ts): a prompt that tries to write via Bash
 * produces no file, even though Bash itself isn't in --disallowedTools.
 * That's what makes this "zero write risk" rather than "no *Edit/Write*
 * tool risk" — a plain --disallowedTools list would still let a write
 * through via Bash.
 *
 * Per house rule: LLM access goes through local Claude Code, never a
 * hosted API directly.
 */
export class ReadOnlyExecutor implements Executor {
  readonly id = "readonly";
  private runner: CommandRunner;
  private model?: string;

  constructor(opts: ReadOnlyExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "readonly";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    const result = await runClaude({ runner: this.runner, task, agent, permissionMode: "plan", model: this.model, env: harness?.env });
    return harness ? { ...result, harnessId: harness.id } : result;
  }
}
