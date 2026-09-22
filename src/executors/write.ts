import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";
import { createTaskWorktree } from "../services/worktree.ts";

export interface WriteExecutorOptions {
  runner?: CommandRunner;
  /** Explicit override, mainly for tests/evals that want to pin a
   *  specific model regardless of the manifest. Omitted (the normal
   *  case) defaults to the routed agent's own `costProfile.model` —
   *  the manifest's declared, reviewable choice, not whatever the
   *  ambient claude-cli session happens to default to. */
  model?: string;
  /** Where task worktrees live, passed straight through to
   *  createTaskWorktree — injectable so tests never touch the real
   *  $HOME. Omitted uses the real one (`~/.wissel/worktrees/<taskId>`). */
  homeDir?: string;
}

/**
 * Opt-in local execution for write-tier work — headless `claude -p` with
 * `--permission-mode acceptEdits`, so file edits land without a human in
 * the loop but anything riskier (Bash and friends) still needs an
 * approval a headless run can't give, and surfaces as a permission
 * denial in the result rather than silently going through.
 *
 * Runs inside an isolated git worktree, never task.repo's own working
 * tree directly (see createTaskWorktree) — a real subprocess was
 * confirmed live to get orphaned mid-run when task.repo is wissel's own
 * source and something (bun --watch) restarts the process tracking it
 * on every file the subprocess edits. See docs/SDD-worktree-isolation.md.
 *
 * Not registered by default: the documented design is "wissel decides,
 * agetor executes" (see Orchestrator's `executeWriteTier` option and the
 * WISSEL_EXECUTE_WRITE_TIER env var, both off unless explicitly turned
 * on). This exists for a setup with no agetor where wissel should run
 * the whole loop itself — a write-tier success still lands in `review`,
 * never `done`, regardless of how it ran, so the human gate is
 * unaffected by who did the work. The worktree's changes only ever reach
 * task.repo through an explicit, human-triggered `POST /tasks/:id/merge`
 * — never automatically, and never from inside this executor.
 */
export class WriteExecutor implements Executor {
  readonly id = "write";
  readonly harnessTool = "claude-cli" as const;
  private runner: CommandRunner;
  private model?: string;
  private homeDir?: string;

  constructor(opts: WriteExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.homeDir = opts.homeDir;
  }

  canHandle(agent: AgentDef): boolean {
    // executor: codex is CodexWriteExecutor's territory — excluded
    // explicitly so the two don't depend on array order in whatever
    // pool they're both registered in to stay mutually exclusive.
    return agent.tier === "write" && agent.executor !== "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    // A pushback re-attempt (task.reviewLineageId set) reuses the same
    // worktree/branch as every other attempt in its lineage instead of
    // cloning fresh off HEAD — see createTaskWorktree's doc comment.
    const worktreeKey = task.reviewLineageId ?? task.id;
    const worktree = await createTaskWorktree(task.repo, worktreeKey, { runner: this.runner, homeDir: this.homeDir });
    if ("error" in worktree) return fail(task, agent, worktree.error);

    const result = await runClaude({
      runner: this.runner,
      task: { ...task, repo: worktree.path },
      agent,
      permissionMode: "acceptEdits",
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
