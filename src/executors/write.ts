import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import { resolveModel } from "../core/model-resolution.ts";
import { runClaude, runViaBun, type CommandRunner } from "./claude-cli.ts";
import { createTaskWorktree, type WorktreeSetupResolver } from "../services/worktree.ts";
import type { GateCommandRunner } from "../services/merge-gate.ts";
import { readProjectAllowRules } from "../core/allowed-tools.ts";
import { buildSandboxSettings, harnessConfigDirs, type SandboxStatus } from "./sandbox.ts";
import type { ProjectSettings } from "../services/project-settings.ts";

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
  /** The per-project execution settings of the repo a task is for
   *  (`ProjectStore.settingsFor`, wired by src/api/server.ts as
   *  `(repo) => projects.settingsFor(repo)`). Read per run, by
   *  `task.repo` (the human-controlled main checkout, never the
   *  worktree), only when the sandbox is on: today it supplies
   *  `sandboxAllowedDomains` to buildSandboxSettings. Undefined (tests,
   *  evals, a repo that isn't a registered project) means no extra
   *  hosts: today's `--settings` exactly. */
  projectSettings?: (repo: string) => Promise<ProjectSettings | undefined>;
  /** The project's worktree setup for a repo (ProjectStore
   *  .worktreeSetupFor), looked up per run so an edit applies without a
   *  restart. Undefined means none: today's behaviour. */
  worktreeSetupFor?: WorktreeSetupResolver;
  /** Runs each setup command; defaults to runGateCommand. Test seam. */
  setupRunner?: GateCommandRunner;
}

/** Always granted: the two commands every write-tier verificationContract
 *  runs. */
export const BASE_ALLOWED_TOOLS = ["Bash(bun test:*)", "Bash(bun run typecheck:*)"] as const;

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
 * (WriteExecutorOptions.projectSettings), no unsandboxed retry. See
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
  private projectSettings?: (repo: string) => Promise<ProjectSettings | undefined>;
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
    this.projectSettings = opts.projectSettings;
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

    // The project's own sandbox hosts (docs/SDD-project-settings.md),
    // read from the board DB by task.repo, so an agent can't grant its
    // own next attempt a host by editing a file in the worktree.
    const sandboxOn = this.sandbox.state === "on";
    const projectSettings = sandboxOn && this.projectSettings ? await this.projectSettings(task.repo!) : undefined;
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
      // Guarantees the two commands verificationContract (see
      // agents/manifest.yaml's implementer) tells the agent to run
      // actually run, every time — plain acceptEdits' own Bash gating
      // was found live to be inconsistent (see RunClaudeOptions.allowedTools'
      // own doc comment for the smoke-test evidence), so this doesn't
      // widen access, it makes these two specific commands reliable.
      // See docs/SDD-pipeline-automation.md §3.4. task.extraAllowedTools
      // (see its own doc comment, TaskCard.extraAllowedTools) appends any
      // task-specific grants beyond this fixed pair — undefined/empty for
      // every task before that field existed, so this is byte-identical
      // to the fixed two-entry array for every caller that doesn't set it.
      // With the sandbox on, sandboxed Bash is approved by the sandbox
      // itself (autoAllowBashIfSandboxed), so this list is no longer the
      // gate; it stays for the commands auto-allow still sends through
      // the permission flow (a leading VAR=value, for one).
      allowedTools: dedupe([...BASE_ALLOWED_TOOLS, ...(task.extraAllowedTools ?? []), ...project.allowed]),
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
