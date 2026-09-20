import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { runViaBun } from "./claude-cli.ts";
import { runCodex, type CommandRunner } from "./codex-cli.ts";
import { createTaskWorktree } from "../services/worktree.ts";

export interface CodexWriteExecutorOptions {
  runner?: CommandRunner;
  /** Explicit override, mainly for tests/evals that want to pin a
   *  specific model regardless of the manifest. Omitted (the normal
   *  case) defaults to the routed agent's own `costProfile.model`. */
  model?: string;
  /** Where task worktrees live, passed straight through to
   *  createTaskWorktree — injectable so tests never touch the real
   *  $HOME. Omitted uses the real one (`~/.wissel/worktrees/<taskId>`). */
  homeDir?: string;
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
 *
 * Runs inside an isolated git worktree, never task.repo's own working
 * tree directly — same reasoning and same mechanism as WriteExecutor;
 * see docs/SDD-worktree-isolation.md. The worktree's changes only ever
 * reach task.repo through an explicit, human-triggered
 * `POST /tasks/:id/merge`.
 */
export class CodexWriteExecutor implements Executor {
  readonly id = "codex-write";
  readonly harnessTool = "codex-cli" as const;
  private runner: CommandRunner;
  private model?: string;
  private homeDir?: string;

  constructor(opts: CodexWriteExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.homeDir = opts.homeDir;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write" && agent.executor === "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    const worktree = await createTaskWorktree(task.repo, task.id, { runner: this.runner, homeDir: this.homeDir });
    if ("error" in worktree) return fail(task, agent, worktree.error);

    const result = await runCodex({
      runner: this.runner,
      task: { ...task, repo: worktree.path },
      agent,
      sandbox: "workspace-write",
      model: this.model ?? agent.costProfile.model,
      env: harness?.env,
    });

    const withHarness = harness ? { ...result, harnessId: harness.id } : result;
    return { ...withHarness, worktree };
  }
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
