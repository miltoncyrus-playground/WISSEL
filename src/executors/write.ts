import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { resolveModel } from "../core/model-resolution.ts";
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
  /** Passed straight through to runClaude's option of the same name —
   *  see its own doc comment. Overridable so tests never fall back to
   *  this repo's real memory/lessons.md. */
  memoryPath?: string;
  /** Fires once per parsed JSONL line for the given task, in order, as
   *  claude's stdout streams in — wired to appendTaskOutput(taskId, ...)
   *  by src/api/server.ts (see docs/SDD-live-task-output.md §3.2/§4).
   *  Undefined (the default) keeps runClaude's non-streaming
   *  `--output-format json` behavior entirely unchanged. */
  onChunk?: (taskId: string, line: unknown) => void;
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
  private memoryPath?: string;
  private onChunk?: (taskId: string, line: unknown) => void;

  constructor(opts: WriteExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.homeDir = opts.homeDir;
    this.memoryPath = opts.memoryPath;
    this.onChunk = opts.onChunk;
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
      model: this.model ?? resolveModel(task, agent, harness),
      env: harness?.env,
      // Guarantees the two commands verificationContract (see
      // agents/manifest.yaml's implementer) tells the agent to run
      // actually run, every time — plain acceptEdits' own Bash gating
      // was found live to be inconsistent (see RunClaudeOptions.allowedTools'
      // own doc comment for the smoke-test evidence), so this doesn't
      // widen access, it makes these two specific commands reliable.
      // See docs/SDD-pipeline-automation.md §3.4.
      allowedTools: ["Bash(bun test:*)", "Bash(bun run typecheck:*)"],
      memoryPath: this.memoryPath,
      onChunk: this.onChunk ? (line: unknown) => this.onChunk!(task.id, line) : undefined,
    });

    const withHarness = harness ? { ...result, harnessId: harness.id } : result;
    return { ...withHarness, worktree };
  }
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
