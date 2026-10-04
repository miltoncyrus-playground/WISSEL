import type { AgentDef, TaskCard, TaskResult } from "../core/types.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import { buildAgentPrompt } from "../core/prompt.ts";
import { DEFAULT_MEMORY_PATH, readMemoryLessons } from "../services/memory.ts";
import type { CommandResult, CommandRunner } from "./claude-cli.ts";
import { resolveMcpGrants } from "./mcp-config.ts";
import { resolveScratchWorkspace } from "../services/scratch-workspace.ts";

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
  /** Path to the global memory/lessons.md file — see
   *  RunClaudeOptions.memoryPath's own doc comment, identical contract. */
  memoryPath?: string;
  /** This run's agent-declared MCP grants — see RunClaudeOptions.mcpAccess's
   *  own doc comment for the general contract. Undefined/empty means zero
   *  effect on the invocation, same as claude-cli's own invariant.
   *
   *  **Unlike claude-cli.ts, non-empty grants here are not actually
   *  wired into the `codex exec` invocation yet** — see runCodex's own
   *  doc comment for why, and the fail-loud behavior that results. */
  mcpAccess?: AgentDef["mcpAccess"];
  /** The live MCP server registry `mcpAccess` is resolved against — see
   *  RunClaudeOptions.mcpServers's own doc comment, identical contract. */
  mcpServers?: McpServerPool;
  /** Fires once per parsed JSONL line, in order, as codex's stdout
   *  streams in — see docs/SDD-live-task-output.md §3.1. Unlike
   *  runClaude, no command-line flags change here: `codex exec --json`
   *  already emits JSONL natively, so this is purely a read-strategy
   *  change (incremental instead of buffered), not a format switch. The
   *  final `TaskResult` this function returns is unaffected either way —
   *  parseJsonl below still reads the full accumulated stdout, exactly
   *  as before. */
  onChunk?: (line: unknown) => void;
  /** Where a repo-less task's scratch workspace lives — see
   *  RunClaudeOptions.homeDir's own doc comment, identical contract. */
  homeDir?: string;
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
 *
 * **MCP grants (`mcpAccess`/`mcpServers`) are accepted for interface
 * parity with runClaude, but deliberately NOT wired into the actual
 * invocation here.** claude-cli.ts's own wiring was built against a
 * real, confirmed CLI flag (`--mcp-config`/`--strict-mcp-config`,
 * confirmed via `claude --help`) and a real, officially-documented
 * stream-json event shape. Codex has zero prior MCP research anywhere in
 * this codebase (`docs/SDD-codex-cli-harness.md` has no mention of MCP
 * at all), and this subtask's own sandbox blocked every avenue to
 * establish it for real: `codex exec --help` itself required an
 * approval this session never received, and WebFetch against
 * non-Anthropic domains (github.com, developers.openai.com) was denied
 * the same way. Guessing a `-c mcp_servers.<id>...` config-override
 * syntax here risked something worse than an obvious failure: a
 * misnamed/mistyped TOML override can be silently ignored by codex
 * rather than erroring, which would make an agent *look* like it has a
 * granted MCP server attached when it actually doesn't — a silent
 * false-positive, strictly worse than refusing outright. So: a
 * non-empty resolved grant fails the run loud, with a message naming
 * exactly what's missing, rather than either guessing or silently
 * dropping the grant. See this subtask's own final report for the
 * concrete follow-up this leaves open.
 */
export async function runCodex(opts: RunCodexOptions): Promise<TaskResult> {
  const { runner, task, agent, sandbox, model, env, memoryPath, onChunk, mcpAccess, mcpServers, homeDir } = opts;

  const grants = resolveMcpGrants(mcpAccess, mcpServers);
  if (grants.length > 0) {
    return fail(
      task,
      agent,
      `codex-cli MCP wiring is unverified and not yet implemented — this agent's mcpAccess grants ` +
        `(${grants.map((g) => g.server.id).join(", ")}) can't be honored by runCodex yet. See codex-cli.ts's ` +
        `own doc comment on runCodex for why this fails loud instead of guessing a CLI flag.`,
    );
  }

  const memory = await readMemoryLessons(memoryPath ?? DEFAULT_MEMORY_PATH);
  const cmd = ["codex", "exec", "--json", "-s", sandbox];
  if (model) cmd.push("-m", model);
  // `prompt` is deliberately never an argv element — mirrors runClaude's
  // own E2BIG fix (see CommandRunner's `stdin` doc comment, claude-cli.ts)
  // for the same reason: a long prompt can exceed the kernel's argv size
  // limit (confirmed live: a single argv element over ~128KiB crashes a
  // real spawn with E2BIG). Confirmed empirically against the real
  // installed codex-cli v0.155.1 binary that this is safe to mirror, not
  // guessed: `codex exec --help`'s own `[PROMPT]` argument text states
  // "If not provided as an argument ..., instructions are read from
  // stdin," and a live `codex exec --json -s read-only` run with a
  // ~150KB prompt piped via stdin and no positional argument printed
  // "Reading prompt from stdin..." to stderr and completed successfully
  // end to end (exit 0, real model response).
  const prompt = buildAgentPrompt(task, agent, memory);

  // Same fallback runClaude's own cwd resolution uses — see its doc
  // comment. CodexWriteExecutor always hands this function a task whose
  // `repo` is already its worktree path, so this only triggers for a
  // repo-less readonly task.
  const cwd = task.repo ?? (await resolveScratchWorkspace(task.id, homeDir));

  let cmdResult: CommandResult;
  try {
    cmdResult = await runner(cmd, { cwd, env, onChunk, stdin: prompt });
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
