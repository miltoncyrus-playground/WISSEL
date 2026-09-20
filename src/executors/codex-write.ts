import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { runViaBun } from "./claude-cli.ts";
import { runCodex, type CommandRunner } from "./codex-cli.ts";

export interface CodexWriteExecutorOptions {
  runner?: CommandRunner;
  /** Explicit override, mainly for tests/evals that want to pin a
   *  specific model regardless of the manifest. Omitted (the normal
   *  case) defaults to the routed agent's own `costProfile.model`. */
  model?: string;
}

/**
 * Opt-in local execution for write-tier work — headless `codex exec
 * --json -s workspace-write`, so file edits inside task.repo land
 * without a human in the loop. Mirrors write.ts's WriteExecutor exactly,
 * same gating rationale: not registered by default (see
 * Orchestrator's `executeWriteTier` option), a write-tier success still
 * lands in `review`, never `done`, regardless of which tool ran it.
 *
 * `workspace-write`'s own risk profile is documented in
 * docs/SDD-codex-cli-harness.md §6.1/§7.2 — a denied write doesn't fail
 * the overall turn or exit code, and there's a live-confirmed
 * sandbox-inside-a-sandbox risk still open for re-verification from
 * wissel's own real process (§7.2, §8.3) — not this executor's job to
 * resolve, just to fail-detect correctly, which runCodex already does.
 */
export class CodexWriteExecutor implements Executor {
  readonly id = "codex-write";
  readonly harnessTool = "codex-cli" as const;
  private runner: CommandRunner;
  private model?: string;

  constructor(opts: CodexWriteExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write" && agent.executor === "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    const result = await runCodex({
      runner: this.runner,
      task,
      agent,
      sandbox: "workspace-write",
      model: this.model ?? agent.costProfile.model,
      env: harness?.env,
    });
    return harness ? { ...result, harnessId: harness.id } : result;
  }
}
