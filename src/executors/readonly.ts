import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import { resolveModel } from "../core/model-resolution.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";

export type { CommandResult, CommandRunner } from "./claude-cli.ts";

/** What `toolAccess: [web]` grants a readonly agent: claude's own web
 *  search and page fetch, passed as `--allowedTools`. Plan mode denies
 *  both without it (checked live 2026-10-07: WebSearch showed up in
 *  `permission_denials`; with this list it searched and returned real
 *  results). Still plan mode, so no write and no bash either way. Only
 *  this executor reads `web`; the registry rejects it anywhere else
 *  (see Registry.from). docs/SDD-ai-news-podcast.md §3.1. */
export const WEB_ALLOWED_TOOLS = ["WebSearch", "WebFetch"] as const;

export interface ReadOnlyExecutorOptions {
  runner?: CommandRunner;
  /** Explicit override, mainly for tests/evals that want to pin a
   *  specific model regardless of the manifest. Omitted (the normal
   *  case) defaults to the routed agent's own `costProfile.model` —
   *  the manifest's declared, reviewable choice, not whatever the
   *  ambient claude-cli session happens to default to. */
  model?: string;
  /** Passed straight through to runClaude's option of the same name —
   *  see its own doc comment. Overridable so tests never fall back to
   *  this repo's real memory/lessons.md. Only actually read when
   *  `injectMemory` is true. */
  memoryPath?: string;
  /** Passed straight through to runClaude's option of the same name —
   *  see its own doc comment. Defaults to **false**; this executor never
   *  reads `process.env` itself, so the caller (src/api/server.ts) must
   *  thread `WISSEL_MEMORY_INJECTION` through explicitly. */
  injectMemory?: boolean;
  /** The live MCP server registry — passed straight through to
   *  runClaude, which resolves it against whatever `agent.mcpAccess`
   *  declares (see RunClaudeOptions.mcpServers's own doc comment).
   *  Undefined (the default) means no MCP grant on any agent routed
   *  through this executor can ever resolve to anything — byte-identical
   *  to today. See docs/SDD-mcp-orchestration.md §3.2. */
  mcpServers?: McpServerPool;
  /** Fires once per parsed JSONL line for the given task, in order, as
   *  claude's stdout streams in — wired to appendTaskOutput(taskId, ...)
   *  by src/api/server.ts (see docs/SDD-live-task-output.md §3.2/§4).
   *  Undefined (the default) keeps runClaude's non-streaming
   *  `--output-format json` behavior entirely unchanged. */
  onChunk?: (taskId: string, line: unknown) => void;
  /** Where a repo-less task's scratch workspace lives, passed straight
   *  through to runClaude — injectable so tests never touch the real
   *  $HOME. Omitted uses the real one (`~/.wissel/scratch/<taskId>`). */
  homeDir?: string;
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
  readonly harnessTool = "claude-cli" as const;
  private runner: CommandRunner;
  private model?: string;
  private memoryPath?: string;
  private injectMemory?: boolean;
  private mcpServers?: McpServerPool;
  private onChunk?: (taskId: string, line: unknown) => void;
  private homeDir?: string;

  constructor(opts: ReadOnlyExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.memoryPath = opts.memoryPath;
    this.injectMemory = opts.injectMemory;
    this.mcpServers = opts.mcpServers;
    this.onChunk = opts.onChunk;
    this.homeDir = opts.homeDir;
  }

  canHandle(agent: AgentDef): boolean {
    // executor: api is ApiExecutor's territory, executor: codex is
    // CodexReadOnlyExecutor's — both excluded explicitly so none of the
    // three depend on array order in whatever pool they're all
    // registered in to stay mutually exclusive.
    return agent.tier === "readonly" && agent.executor !== "api" && agent.executor !== "codex";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    const result = await runClaude({
      runner: this.runner,
      task,
      agent,
      permissionMode: "plan",
      model: this.model ?? resolveModel(task, agent, harness),
      // Undefined for every agent without `web`: no --allowedTools at
      // all, the exact command line from before `web` existed.
      allowedTools: agent.toolAccess.includes("web") ? [...WEB_ALLOWED_TOOLS] : undefined,
      env: harness?.env,
      memoryPath: this.memoryPath,
      injectMemory: this.injectMemory,
      mcpAccess: task.mcpAccessOverride ?? agent.mcpAccess,
      mcpServers: this.mcpServers,
      // Only true for a human-approved MCP follow-up task (`task
      // .mcpAccessOverride` set — see its own doc comment and `POST
      // /tasks/:id/mcp-approval/approve`), never for an agent's own
      // regular `agent.mcpAccess` grants — see RunClaudeOptions
      // .mcpAccessPreApproved's own doc comment for why this is safe.
      mcpAccessPreApproved: task.mcpAccessOverride !== undefined,
      onChunk: this.onChunk ? (line: unknown) => this.onChunk!(task.id, line) : undefined,
      homeDir: this.homeDir,
    });
    return harness ? { ...result, harnessId: harness.id } : result;
  }
}
