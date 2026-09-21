import type { AgentDef, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";
import { parseReviewVerdict } from "./parse-review-verdict.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable so tests never spawn a real process or spend a real token.
 *  `env`, when given, is a harness's account/config overrides — merged
 *  over the ambient environment by the runner, never a full replacement
 *  (dropping PATH etc. would break the spawn entirely). */
export type CommandRunner = (cmd: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<CommandResult>;

export async function runViaBun(cmd: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  /** Already present on the same `--output-format json` object
   *  runClaude has always parsed — confirmed live, no format switch
   *  needed (see docs/SDD-subagent-visibility.md §2). */
  subagent_stats?: { spawned: number; failed: number; by_type: Record<string, number> };
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
  /** The picked harness's env overrides, passed straight through to the
   *  runner. Undefined when no harness was picked — identical to
   *  wissel's behavior before harnesses existed. */
  env?: Record<string, string>;
}

/**
 * Shared plumbing for every headless `claude -p` invocation, read-only
 * or write: build the command, spawn it, parse its `--output-format
 * json` response into a TaskResult. The only thing that differs between
 * tiers is `--permission-mode`, which the caller picks.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<TaskResult> {
  const { runner, task, agent, permissionMode, model, env } = opts;
  const cmd = ["claude", "-p", buildAgentPrompt(task, agent), "--output-format", "json", "--permission-mode", permissionMode];
  if (model) cmd.push("--model", model);

  let cmdResult: CommandResult;
  try {
    cmdResult = await runner(cmd, { cwd: task.repo, env });
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
  let ok = !parsed.is_error;
  let summary = denials.length > 0 ? `${parsed.result ?? "(no result)"} [${denials.length} permission denial(s)]` : parsed.result ?? "(no result)";

  // Agents with a declared outputContract (today: only the reviewer —
  // see AgentDef.outputContract) must end their message with a
  // machine-parseable verdict block. A claude run that otherwise
  // "succeeded" but produced prose instead of the contract is still a
  // failure from the caller's point of view: nothing downstream can
  // trust `summary` as a verdict. Never default to approve here — see
  // parseReviewVerdict's own contract.
  if (ok && agent.outputContract) {
    const verdict = parseReviewVerdict(parsed.result ?? "");
    if (verdict === null) {
      ok = false;
      summary = `${agent.name} violated its output contract — expected a trailing \`\`\`review-verdict fenced block with {"verdict":"approve"|"changes_requested","feedback":"..."}, got: ${parsed.result ?? "(no result)"}`;
    }
  }

  // Undefined (not a zero-valued object) when nothing was spawned — "no
  // field" and "definitely spawned nothing" read the same way the rest
  // of TaskResult already treats absence (see SDD §3).
  const stats = parsed.subagent_stats;
  const subagents = stats && stats.spawned > 0 ? { count: stats.spawned, failed: stats.failed, byType: stats.by_type } : undefined;

  return {
    taskId: task.id,
    agentId: agent.id,
    ok,
    summary,
    actualCost: parsed.total_cost_usd,
    subagents,
  };
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
