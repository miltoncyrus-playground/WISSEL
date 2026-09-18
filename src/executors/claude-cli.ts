import type { AgentDef, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable so tests never spawn a real process or spend a real token. */
export type CommandRunner = (cmd: string[], opts: { cwd: string }) => Promise<CommandResult>;

export async function runViaBun(cmd: string[], opts: { cwd: string }): Promise<CommandResult> {
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

export type PermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

export interface RunClaudeOptions {
  runner: CommandRunner;
  task: TaskCard;
  agent: AgentDef;
  /** "plan" for read-only (claude's own read-only enforcement — see
   *  ReadOnlyExecutor); "acceptEdits" auto-accepts file edits but still
   *  gates anything riskier (e.g. Bash), which shows up as a permission
   *  denial in the result rather than silently going through — see
   *  WriteExecutor. */
  permissionMode: PermissionMode;
  /** Omitted lets claude use its own default (the house rule is "best
   *  available model", which is already the local default — never
   *  silently downgrade here). */
  model?: string;
}

/**
 * Shared plumbing for every headless `claude -p` invocation, read-only
 * or write: build the command, spawn it, parse its `--output-format
 * json` response into a TaskResult. The only thing that differs between
 * tiers is `--permission-mode`, which the caller picks.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<TaskResult> {
  const { runner, task, agent, permissionMode, model } = opts;
  const cmd = ["claude", "-p", buildAgentPrompt(task, agent), "--output-format", "json", "--permission-mode", permissionMode];
  if (model) cmd.push("--model", model);

  let cmdResult: CommandResult;
  try {
    cmdResult = await runner(cmd, { cwd: task.repo });
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

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
