import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";

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
  total_cost_usd?: number;
}

export interface ReadOnlyExecutorOptions {
  runner?: CommandRunner;
  /** Passed through as --model; omitted lets claude use its own default
   *  (the house rule is "best available model", which is already the
   *  local default — never silently downgrade here). */
  model?: string;
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
  private runner: CommandRunner;
  private model?: string;

  constructor(opts: ReadOnlyExecutorOptions = {}) {
    this.runner = opts.runner ?? runViaBun;
    this.model = opts.model;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "readonly";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    const cmd = ["claude", "-p", buildAgentPrompt(task, agent), "--output-format", "json", "--permission-mode", "plan"];
    if (this.model) cmd.push("--model", this.model);

    let cmdResult: CommandResult;
    try {
      cmdResult = await this.runner(cmd, { cwd: task.repo });
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

    const denials = parsed.permission_denials ?? [];
    const summary = denials.length > 0 ? `${parsed.result ?? "(no result)"} [${denials.length} permission denial(s)]` : parsed.result ?? "(no result)";

    return {
      taskId: task.id,
      agentId: agent.id,
      ok: !parsed.is_error,
      summary,
      actualCost: parsed.total_cost_usd,
    };
  }
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
