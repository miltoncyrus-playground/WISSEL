import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import { resolveModel } from "../core/model-resolution.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";
import { createTaskWorktree, type WorktreeSetupResolver } from "../services/worktree.ts";
import type { GateCommandRunner } from "../services/merge-gate.ts";
import { readProjectAllowRules } from "../core/allowed-tools.ts";
import { DEFAULT_VERIFICATION } from "../core/verification.ts";
import type { ProjectSettings } from "../services/project-settings.ts";
import { buildSandboxSettings, harnessConfigDirs, type SandboxStatus } from "./sandbox.ts";

/** Looks up the execution settings of the project registered at `repo`
 *  (ProjectStore.settingsFor, src/services/projects.ts). Undefined when
 *  no project is registered there. */
export type ProjectSettingsResolver = (repo: string) => Promise<ProjectSettings | undefined>;

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
   *  this repo's real memory/lessons.md. Only actually read when
   *  `injectMemory` is true. */
  memoryPath?: string;
  /** Passed straight through to runClaude's option of the same name —
   *  see its own doc comment. Defaults to **false**; this executor never
   *  reads `process.env` itself, so the caller (src/api/server.ts) must
   *  thread `WISSEL_MEMORY_INJECTION` through explicitly. */
  injectMemory?: boolean;
  /** The live MCP server registry — see ReadOnlyExecutorOptions.mcpServers's
   *  own doc comment, identical contract. Undefined (the default) means
   *  no MCP grant on any agent routed through this executor can ever
   *  resolve to anything — byte-identical to today. */
  mcpServers?: McpServerPool;
  /** Fires once per parsed JSONL line for the given task, in order, as
   *  claude's stdout streams in — wired to appendTaskOutput(taskId, ...)
   *  by src/api/server.ts (see docs/SDD-live-task-output.md §3.2/§4).
   *  Undefined (the default) keeps runClaude's non-streaming
   *  `--output-format json` behavior entirely unchanged. */
  onChunk?: (taskId: string, line: unknown) => void;
  /** Passed straight through to runClaude's option of the same name —
   *  see its own doc comment. Off unless the caller (src/api/server.ts,
   *  from WISSEL_REMOTE_CONTROL) turns it on. */
  remoteControl?: boolean;
  /** The startup sandbox preflight's verdict (probeSandbox,
   *  src/executors/sandbox.ts). Only "on" sandboxes Bash; "off" (the
   *  default, so tests and evals keep today's argv) and "unavailable"
   *  run under the allowlist alone. Never broad Bash without the
   *  sandbox: the two only ever come together. */
  sandbox?: SandboxStatus;
  /** Extra read-denied paths for the sandbox: every configured
   *  harness's CLAUDE_CONFIG_DIR / CODEX_HOME (harnessConfigDirs). The
   *  running harness's own is always added. */
  sandboxDenyRead?: string[];
  /** The per-project execution settings (docs/SDD-project-settings.md),
   *  looked up by `task.repo` at run time so an edit takes effect without
   *  a restart. Wired to `projects.settingsFor` by src/api/server.ts.
   *  Read here: `verification` (its `allowedTools` replace
   *  BASE_ALLOWED_TOOLS and its `commands` render the contract's tokens,
   *  src/core/verification.ts) and, only when the sandbox is on,
   *  `sandboxAllowedDomains` (buildSandboxSettings). Undefined (tests, evals), or a repo with
   *  no project or none of those keys, keeps today's argv, prompt and
   *  `--settings` byte-identical. */
  settingsFor?: ProjectSettingsResolver;
  /** The project's worktree setup for a repo (ProjectStore
   *  .worktreeSetupFor), looked up per run so an edit applies without a
   *  restart. Undefined means none: today's behaviour. */
  worktreeSetupFor?: WorktreeSetupResolver;
  /** Runs each setup command; defaults to runGateCommand. Test seam. */
  setupRunner?: GateCommandRunner;
}

/** Granted when the project sets no `verification`: the two commands the
 *  default write-tier contract runs (DEFAULT_VERIFICATION.allowedTools).
 *  A project's own `verification.allowedTools` replaces this list, it
 *  never adds to it. */
export const BASE_ALLOWED_TOOLS: readonly string[] = DEFAULT_VERIFICATION.allowedTools;

/**
 * Opt-in local execution for write-tier work — headless `claude -p` with
 * `--permission-mode acceptEdits`, so file edits land without a human in
 * the loop but anything riskier (Bash and friends) still needs an
 * approval a headless run can't give, and surfaces as a permission
 * denial in the result rather than silently going through.
 *
 * When the startup preflight found Claude Code's Bash sandbox can start
 * (`sandbox.state === "on"`), Bash instead runs inside it and is
 * approved by it: writes only to the worktree, the temp dir and
 * extraAllowedDirs, credential dirs unreadable, network limited to the
 * npm registry, github.com and the project's own `sandboxAllowedDomains`
 * (WriteExecutorOptions.settingsFor), no unsandboxed retry. See
 * src/executors/sandbox.ts and docs/SDD-write-tier-sandbox.md.
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
  private remoteControl?: boolean;
  private memoryPath?: string;
  private injectMemory?: boolean;
  private mcpServers?: McpServerPool;
  private onChunk?: (taskId: string, line: unknown) => void;
  private sandbox: SandboxStatus;
  private sandboxDenyRead: string[];
  private settingsFor?: ProjectSettingsResolver;
  private worktreeSetupFor?: WorktreeSetupResolver;
  private setupRunner?: GateCommandRunner;

  constructor(opts: WriteExecutorOptions = {}) {
    this.worktreeSetupFor = opts.worktreeSetupFor;
    this.setupRunner = opts.setupRunner;
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
    this.homeDir = opts.homeDir;
    this.remoteControl = opts.remoteControl;
    this.memoryPath = opts.memoryPath;
    this.injectMemory = opts.injectMemory;
    this.mcpServers = opts.mcpServers;
    this.onChunk = opts.onChunk;
    this.sandbox = opts.sandbox ?? { state: "off", problems: [] };
    this.sandboxDenyRead = opts.sandboxDenyRead ?? [];
    this.settingsFor = opts.settingsFor;
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
    // `repo` is mandatory for any write/bash-capable agent, enforced at
    // creation by POST /tasks (see TaskCard.repo's own doc comment) —
    // a write-tier task reaching this executor always has one.
    // The project's worktreeSetup runs here, in wissel's own process,
    // before the agent starts; a failure fails the card with its output.
    const worktree = await createTaskWorktree(task.repo!, worktreeKey, {
      runner: this.runner,
      homeDir: this.homeDir,
      setup: await this.worktreeSetupFor?.(task.repo!),
      setupRunner: this.setupRunner,
    });
    if ("error" in worktree) return fail(task, agent, worktree.error);

    // The repo's own .claude/settings.json allow rules, which claude
    // drops in an untrusted worktree; only the ones a per-card grant
    // could also be (see readProjectAllowRules).
    const project = await readProjectAllowRules(task.repo!);
    for (const r of project.refused) console.warn(`write: task ${task.id}: not passing project allow rule ${r.error}`);

    // The project's own check commands and the grants that let them run
    // (docs/SDD-project-settings.md §7), read from the board DB by the
    // human-controlled `task.repo` path, never from a file in the
    // worktree an agent could have edited. Undefined keeps the Bun
    // defaults everywhere below.
    const projectSettings = await this.settingsFor?.(task.repo!);
    const verification = projectSettings?.verification;

    // The project's own sandbox hosts (docs/SDD-project-settings.md),
    // read from the board DB by task.repo, so an agent can't grant its
    // own next attempt a host by editing a file in the worktree.
    const sandboxOn = this.sandbox.state === "on";
    const settings = sandboxOn
      ? buildSandboxSettings({
          repo: task.repo!,
          extraDenyRead: [...this.sandboxDenyRead, ...harnessConfigDirs([harness?.env])],
          allowedDomains: projectSettings?.sandboxAllowedDomains,
        })
      : undefined;

    const result = await runClaude({
      runner: this.runner,
      task: { ...task, repo: worktree.path },
      agent,
      permissionMode: "acceptEdits",
      model: this.model ?? resolveModel(task, agent, harness),
      env: harness?.env,
      // Guarantees the commands verificationContract (see
      // agents/manifest.yaml's implementer) tells the agent to run
      // actually run, every time — plain acceptEdits' own Bash gating
      // was found live to be inconsistent (see RunClaudeOptions.allowedTools'
      // own doc comment for the smoke-test evidence), so this doesn't
      // widen access, it makes those specific commands reliable.
      // See docs/SDD-pipeline-automation.md §3.4. The base list is the
      // project's own `verification.allowedTools` when it has one, else
      // the fixed Bun pair (BASE_ALLOWED_TOOLS); the same setting's
      // `commands` are what the prompt names, so the two can't drift.
      // task.extraAllowedTools (see its own doc comment,
      // TaskCard.extraAllowedTools) appends any task-specific grants
      // beyond that base — undefined/empty for every task before that
      // field existed, so this is byte-identical to the fixed two-entry
      // array for every caller that sets neither.
      // With the sandbox on, sandboxed Bash is approved by the sandbox
      // itself (autoAllowBashIfSandboxed), so this list is no longer the
      // gate; it stays for the commands auto-allow still sends through
      // the permission flow (a leading VAR=value, for one).
      allowedTools: dedupe([...(verification?.allowedTools ?? BASE_ALLOWED_TOOLS), ...(task.extraAllowedTools ?? []), ...project.allowed]),
      verification,
      settings,
      sandbox: this.sandbox.state,
      addDir: task.extraAllowedDirs,
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
      remoteControl: this.remoteControl,
    });

    const withHarness = harness ? { ...result, harnessId: harness.id } : result;
    return { ...withHarness, worktree };
  }
}

function dedupe(items: string[]): string[] {
  return items.filter((x, i) => items.indexOf(x) === i);
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
