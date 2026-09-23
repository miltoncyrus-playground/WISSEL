import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { resolveModel } from "../core/model-resolution.ts";
import { runViaBun } from "./claude-cli.ts";
import { runCodex, type CommandRunner } from "./codex-cli.ts";

export type { CommandResult, CommandRunner } from "./codex-cli.ts";

export interface CodexReadOnlyExecutorOptions {
  runner?: CommandRunner;
  /** Explicit override, mainly for tests/evals that want to pin a
   *  specific model regardless of the manifest. Omitted (the normal
   *  case) defaults to the routed agent's own `costProfile.model` —
   *  see runCodex's own doc comment on why that's usually itself
   *  omitted downstream (no verified working codex model id yet). */
  model?: string;
  /** Passed straight through to runCodex's option of the same name —
   *  see its own doc comment. Overridable so tests never fall back to
   *  this repo's real memory/lessons.md. */
  memoryPath?: string;
}

/**
 * No worktree, no session. Plain headless `codex exec --json -s
 * read-only` call. `read-only` is Codex's own enforced no-write
 * sandbox — same "zero write risk by the tool's own enforcement, not
 * just by which tools we didn't grant" property `readonly.ts`'s comment
 * calls out for claude's `plan` mode. See
 * docs/SDD-codex-cli-harness.md §6.1.
 *
 * Per house rule: LLM access goes through a local CLI, never a hosted
 * API directly.
 */
export class CodexReadOnlyExecutor implements Executor {
  readonly id = "codex-readonly";
  readonly harnessTool = "codex-cli" as const;
  private runner: CommandRunner;
  private model?: string;
  private memoryPath?: string;

  constructor(opts: CodexReadOnlyExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.memoryPath = opts.memoryPath;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "readonly" && agent.executor === "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    const result = await runCodex({
      runner: this.runner,
      task,
      agent,
      sandbox: "read-only",
      model: this.model ?? resolveModel(task, agent, harness),
      env: harness?.env,
      memoryPath: this.memoryPath,
    });
    return harness ? { ...result, harnessId: harness.id } : result;
  }
}
