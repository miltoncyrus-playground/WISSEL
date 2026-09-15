import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";
import type { WorktreeHandle, WorktreeService } from "../services/worktree.ts";
import type { SessionSupervisor } from "../services/session.ts";
import type { Provisioner } from "../services/provisioner.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable so tests never spawn a real process or spend a real token. */
export type CommandRunner = (cmd: string[], opts: { cwd: string }) => Promise<CommandResult>;

async function runViaBun(cmd: string[], opts: { cwd: string }): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

interface ClaudeResultJson {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  permission_denials?: unknown[];
}

export interface WorktreeClaudeExecutorOptions {
  runner?: CommandRunner;
  model?: string;
}

/**
 * The agetor spawn path, decomposed into services: fresh worktree, provision
 * its settings, run claude in it.
 *
 * Deliberately a headless `claude -p` call, same synchronous shape as
 * `ReadOnlyExecutor`, not a live/attachable tmux session — a decision made
 * explicitly rather than defaulted to. `run()` returns a single
 * `Promise<TaskResult>`; making that resolve from a real interactive tmux
 * session would require completion detection (tailing the session's
 * transcript for a turn-end marker, agetor's own output-scraping and
 * death-watch machinery) that hasn't been built or verified here. The
 * `SessionSupervisor` dependency is kept on the constructor for the
 * interface's sake but is unused by this synchronous path — it's there for
 * a future mode that spawns a resumable tmux session for follow-up turns
 * after this first one lands.
 *
 * `--dangerously-skip-permissions` is required for a headless run to
 * actually write anything — without it every edit stalls waiting on a
 * permission prompt nobody is there to answer. claude's own docs say this
 * flag is "recommended only for sandboxes with no internet access"; a
 * wissel worktree is git/filesystem-isolated (its own branch, its own
 * directory) but NOT network-isolated — an agent running here can still
 * reach the network like any other process on this machine. The isolation
 * that makes this acceptable is "disposable branch, nothing shared with
 * the user's working tree," not "sandboxed."
 */
export class WorktreeClaudeExecutor implements Executor {
  readonly id = "worktree-claude";
  private runner: CommandRunner;
  private model?: string;

  constructor(
    private worktrees: WorktreeService,
    private sessions: SessionSupervisor,
    private provisioner: Provisioner,
    opts: WorktreeClaudeExecutorOptions = {},
  ) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "write";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    let handle: WorktreeHandle;
    try {
      handle = await this.worktrees.create(task.repo, task.id);
    } catch (e) {
      return fail(task, agent, `failed to create worktree: ${(e as Error).message}`);
    }

    try {
      await this.provisioner.provision({ cwd: handle.path, originRepo: handle.originRepo, owned: true });
    } catch (e) {
      return fail(task, agent, `failed to provision worktree: ${(e as Error).message}`);
    }

    const cmd = [
      "claude",
      "-p",
      buildAgentPrompt(task, agent),
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ];
    if (this.model) cmd.push("--model", this.model);

    let cmdResult: CommandResult;
    try {
      cmdResult = await this.runner(cmd, { cwd: handle.path });
    } catch (e) {
      return fail(task, agent, `failed to spawn claude: ${(e as Error).message}`);
    }

    const { stdout, stderr, exitCode } = cmdResult;
    if (exitCode !== 0) {
      return fail(task, agent, `claude exited ${exitCode}: ${(stderr || stdout).trim()}`);
    }

    let parsed: ClaudeResultJson;
    try {
      parsed = JSON.parse(stdout) as ClaudeResultJson;
    } catch (e) {
      return fail(task, agent, `could not parse claude output: ${(e as Error).message}`);
    }

    const committed = await this.commitIfDirty(handle);

    const denials = parsed.permission_denials ?? [];
    const summaryBits = [parsed.result ?? "(no result)"];
    if (denials.length > 0) summaryBits.push(`[${denials.length} permission denial(s)]`);
    summaryBits.push(committed ? `committed on ${handle.branch}` : `no changes committed on ${handle.branch}`);

    return {
      taskId: task.id,
      agentId: agent.id,
      ok: !parsed.is_error,
      summary: summaryBits.join(" "),
      artifacts: [handle.path],
    };
  }

  /** Commits whatever claude left dirty in the worktree. Best-effort: a
   *  commit failure here (e.g. no user.email configured) degrades to
   *  "not committed" rather than failing the whole task result — the work
   *  is still sitting in the worktree either way. */
  private async commitIfDirty(handle: WorktreeHandle): Promise<boolean> {
    const status = await this.runner(["git", "status", "--porcelain"], { cwd: handle.path });
    if (!status.stdout.trim()) return false;
    await this.runner(["git", "add", "-A"], { cwd: handle.path });
    const commit = await this.runner(["git", "commit", "-m", `wissel: ${handle.branch.replace(/^wissel\//, "")}`], {
      cwd: handle.path,
    });
    return commit.exitCode === 0;
  }
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
