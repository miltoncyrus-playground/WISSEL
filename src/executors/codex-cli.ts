import type { AgentDef, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";
import type { CommandResult, CommandRunner } from "./claude-cli.ts";

export type { CommandResult, CommandRunner } from "./claude-cli.ts";

/** Codex's own sandbox tiers, confirmed live against the installed
 *  binary (v0.155.1) — see docs/SDD-codex-cli-harness.md §6.1. There is
 *  no approval-mode flag to set here the way runClaude has
 *  permissionMode: `codex exec` has no interactive approval concept at
 *  all (it's already non-interactive by definition), only a sandbox. */
export type SandboxMode = "read-only" | "workspace-write";

export interface CodexModelPricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

/** $/1M tokens. Empty for now, deliberately: the only Codex model id
 *  this project's research turned up (`gpt-5.1-codex`) 404s on this
 *  account's key (confirmed live — see SDD §6/§8.5), and even if it
 *  worked, the aggregator source for its price (SDD §3) only covers
 *  input/output — there's no confirmed rate yet for
 *  `cached_input_tokens` or `cache_write_input_tokens`. Same contract
 *  anthropic-api.ts's own MODEL_PRICING already relies on: an
 *  unknown/unpriced model computes no actualCost rather than a guessed
 *  one. Add a real entry here once a working model and all four verified
 *  per-token rates exist. */
export const MODEL_PRICING: Record<string, CodexModelPricing> = {};

/** The `usage` object on a `turn.completed` event. Confirmed live to
 *  have five fields (SDD §6.2) — `reasoning_output_tokens` isn't priced
 *  separately from `output_tokens` anywhere in the SDD's research, so
 *  it's read but not billed here. */
interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens?: number;
}

/** One line of `codex exec --json`'s JSONL stream. Deliberately a flat,
 *  loosely-shaped interface (every field optional besides `type`) rather
 *  than a discriminated union — this is untrusted subprocess output, and
 *  the event types actually used here (`item.completed`, `turn.completed`,
 *  `turn.failed`) are read defensively rather than assumed exhaustive. */
interface CodexEvent {
  type: string;
  item?: { id: string; type: string; text?: string; status?: string };
  usage?: CodexUsage;
  error?: { message: string };
}

/**
 * Turns a `usage` object into a dollar figure — mirrors
 * anthropic-api.ts's `computeCost`, since codex reports only token
 * counts, never a dollar figure itself (unlike `claude -p
 * --output-format json`'s `total_cost_usd`). `pricing` defaults to the
 * module's own `MODEL_PRICING` — overridable so tests can exercise the
 * arithmetic (including the cache-write field) without needing a real,
 * verified dollar rate to exist yet.
 */
export function computeCost(
  model: string | undefined,
  usage: CodexUsage | undefined,
  pricing: Record<string, CodexModelPricing> = MODEL_PRICING,
): number | undefined {
  if (!model || !usage) return undefined;
  const rates = pricing[model];
  if (!rates) return undefined;
  return (
    (usage.input_tokens * rates.input +
      usage.cached_input_tokens * rates.cachedInput +
      usage.cache_write_input_tokens * rates.cacheWrite +
      usage.output_tokens * rates.output) /
    1_000_000
  );
}

export interface RunCodexOptions {
  runner: CommandRunner;
  task: TaskCard;
  agent: AgentDef;
  /** "read-only" for the readonly tier (Codex's own enforced no-write
   *  sandbox — see CodexReadOnlyExecutor); "workspace-write" lets edits
   *  inside task.repo land without a human in the loop, same tradeoff
   *  runClaude's "acceptEdits" makes — see CodexWriteExecutor. */
  sandbox: SandboxMode;
  /** Omitted lets codex use its own configured default. Don't default
   *  this to `gpt-5.1-codex` (or any other unverified model id): that
   *  model 404s on this account's key, confirmed live — see SDD §6/§8.5. */
  model?: string;
  /** The picked harness's env overrides, passed straight through to the
   *  runner (e.g. CODEX_HOME). Undefined when no harness was picked. */
  env?: Record<string, string>;
}

/**
 * Shared plumbing for every headless `codex exec --json` invocation,
 * read-only or write: build the command, spawn it, parse its JSONL event
 * stream into a TaskResult. Mirrors runClaude exactly in shape — the
 * only thing that differs between tiers is `sandbox`, which the caller
 * picks — but differs in substance because codex's result comes back as
 * a stream of events instead of one JSON object; see
 * docs/SDD-codex-cli-harness.md §6.2 for the confirmed-live event shapes
 * this parses.
 */
export async function runCodex(opts: RunCodexOptions): Promise<TaskResult> {
  const { runner, task, agent, sandbox, model, env } = opts;
  const cmd = ["codex", "exec", "--json", "-s", sandbox];
  if (model) cmd.push("-m", model);
  cmd.push(buildAgentPrompt(task, agent));

  let cmdResult: CommandResult;
  try {
    cmdResult = await runner(cmd, { cwd: task.repo, env });
  } catch (e) {
    return fail(task, agent, `failed to spawn codex: ${(e as Error).message}`);
  }

  const { stdout, stderr, exitCode } = cmdResult;
  const events = parseJsonl(stdout);

  const agentMessages = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message");
  const lastAgentMessage = agentMessages.at(-1)?.item?.text;

  const turnFailedEvents = events.filter((e) => e.type === "turn.failed");
  const lastTurnFailed = turnFailedEvents.at(-1);

  // Confirmed live (SDD §6.1/§6.2): a sandbox-denied write can leave
  // exit 0 with no turn.failed at all, visible only as a failed
  // item.completed — exit code and item status each miss a failure mode
  // the other one catches, so both (plus turn.failed) are checked
  // independently.
  const hasFailedItem = events.some((e) => e.type === "item.completed" && e.item?.status === "failed");
  const ok = exitCode === 0 && !hasFailedItem && turnFailedEvents.length === 0;

  const exitFallback = exitCode !== 0 ? (stderr || stdout).trim() : "";
  const summary = lastAgentMessage ?? lastTurnFailed?.error?.message ?? (exitFallback || "(no result)");

  const turnCompletedEvents = events.filter((e) => e.type === "turn.completed");
  const usage = turnCompletedEvents.at(-1)?.usage;

  return {
    taskId: task.id,
    agentId: agent.id,
    ok,
    summary,
    actualCost: computeCost(model, usage),
  };
}

/** Splits stdout on newlines and parses each non-blank line as JSON,
 *  skipping (not throwing on) anything unparseable — a JSONL stream from
 *  a long-running subprocess can end up with a partial trailing line if
 *  something goes wrong downstream, and one bad line shouldn't sink the
 *  whole run's worth of otherwise-good events. */
function parseJsonl(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as CodexEvent);
    } catch {
      // tolerated — see doc comment above.
    }
  }
  return events;
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
