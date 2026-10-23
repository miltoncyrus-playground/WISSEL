import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import { resolveModel } from "../core/model-resolution.ts";
import { runViaBun } from "./claude-cli.ts";
import { runCodex, type CommandRunner } from "./codex-cli.ts";
import { createTaskWorktree, type WorktreeSetupResolver } from "../services/worktree.ts";
import type { GateCommandRunner } from "../services/merge-gate.ts";
import type { ProjectSettingsResolver } from "./write.ts";

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
  /** Passed straight through to runCodex's option of the same name —
   *  see its own doc comment. Overridable so tests never fall back to
   *  this repo's real memory/lessons.md. Only actually read when
   *  `injectMemory` is true. */
  memoryPath?: string;
  /** Passed straight through to runCodex's option of the same name —
   *  see its own doc comment. Defaults to **false**; this executor never
   *  reads `process.env` itself, so the caller (src/api/server.ts) must
   *  thread `WISSEL_MEMORY_INJECTION` through explicitly. */
  injectMemory?: boolean;
  /** The live MCP server registry — see CodexReadOnlyExecutorOptions
   *  .mcpServers's doc comment, identical contract (and the same
   *  fail-loud-on-non-empty-grant caveat). */
  mcpServers?: McpServerPool;
  /** Fires once per parsed JSONL line for the given task, in order, as
   *  codex's stdout streams in — wired to appendTaskOutput(taskId, ...)
   *  by src/api/server.ts (see docs/SDD-live-task-output.md §3.2/§4). */
  onChunk?: (taskId: string, line: unknown) => void;
  /** See WriteExecutorOptions.settingsFor, identical contract. Codex has
   *  no `--allowedTools` (its sandbox is `workspace-write`), so only the
   *  setting's `commands` are used here: they render the contract's
   *  tokens in the prompt. */
  settingsFor?: ProjectSettingsResolver;
  /** Same as WriteExecutorOptions.worktreeSetupFor. */
  worktreeSetupFor?: WorktreeSetupResolver;
  /** Same as WriteExecutorOptions.setupRunner. */
  setupRunner?: GateCommandRunner;
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
 *
 * No network allowlist here: `workspace-write` is Codex's own sandbox,
 * and it has no per-host setting (network is all-or-nothing in Codex's
 * config.toml), so `Project.sandboxAllowedDomains` (read by
 * WriteExecutor) has nothing to feed into. See
 * docs/SDD-write-tier-sandbox.md §11.
 */
export class CodexWriteExecutor implements Executor {
  readonly id = "codex-write";
  readonly harnessTool = "codex-cli" as const;
  private runner: CommandRunner;
  private model?: string;
  private homeDir?: string;
  private memoryPath?: string;
  private injectMemory?: boolean;
  private mcpServers?: McpServerPool;
  private onChunk?: (taskId: string, line: unknown) => void;
  private settingsFor?: ProjectSettingsResolver;
  private worktreeSetupFor?: WorktreeSetupResolver;
  private setupRunner?: GateCommandRunner;

  constructor(opts: CodexWriteExecutorOptions = {}) {
    this.worktreeSetupFor = opts.worktreeSetupFor;
    this.setupRunner = opts.setupRunner;
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.homeDir = opts.homeDir;
    this.memoryPath = opts.memoryPath;
    this.injectMemory = opts.injectMemory;
    this.mcpServers = opts.mcpServers;
    this.onChunk = opts.onChunk;
    this.settingsFor = opts.settingsFor;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write" && agent.executor === "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    // A pushback re-attempt (task.reviewLineageId set) reuses the same
    // worktree/branch as every other attempt in its lineage instead of
    // cloning fresh off HEAD — see createTaskWorktree's doc comment.
    const worktreeKey = task.reviewLineageId ?? task.id;
    // `repo` is mandatory for any write/bash-capable agent, enforced at
    // creation by POST /tasks (see TaskCard.repo's own doc comment) —
    // a write-tier task reaching this executor always has one.
    const worktree = await createTaskWorktree(task.repo!, worktreeKey, {
      runner: this.runner,
      homeDir: this.homeDir,
      setup: await this.worktreeSetupFor?.(task.repo!),
      setupRunner: this.setupRunner,
      baseRef: task.mergeTarget,
    });
    if ("error" in worktree) return fail(task, agent, worktree.error);

    // Same lookup as WriteExecutor's: by the human-controlled `task.repo`
    // path, never a file in the worktree.
    const verification = (await this.settingsFor?.(task.repo!))?.verification;

    const result = await runCodex({
      runner: this.runner,
      task: { ...task, repo: worktree.path },
      agent,
      sandbox: "workspace-write",
      model: this.model ?? resolveModel(task, agent, harness),
      env: harness?.env,
      memoryPath: this.memoryPath,
      injectMemory: this.injectMemory,
      mcpAccess: task.mcpAccessOverride ?? agent.mcpAccess,
      mcpServers: this.mcpServers,
      onChunk: this.onChunk ? (line: unknown) => this.onChunk!(task.id, line) : undefined,
      verification,
    });

    const withHarness = harness ? { ...result, harnessId: harness.id } : result;
    return { ...withHarness, worktree };
  }
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
