import type { AgentDef, PipelineHandoff, ReviewVerdict, SubtaskPlanItem, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";
import { DEFAULT_MEMORY_PATH, readMemoryLessons } from "../services/memory.ts";
import { parseReviewVerdict } from "./parse-review-verdict.ts";
import { parseSubtaskPlan } from "./parse-subtask-plan.ts";
import { parsePipelineHandoff } from "./parse-pipeline-handoff.ts";
import { parseSessionLimitReset } from "./parse-session-limit-reset.ts";

/** A retriable 429's reset time must be within this window of "now" —
 *  parseSessionLimitReset can in principle only ever return same-day or
 *  next-day (it rolls forward exactly once), so this is defense in
 *  depth against a future change to that parser silently widening the
 *  window, not a case reachable today. Guards against ever scheduling a
 *  near-infinite wait off a misparsed timestamp. */
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Injectable so tests never spawn a real process or spend a real token.
 *  `env`, when given, is a harness's account/config overrides — merged
 *  over the ambient environment by the runner, never a full replacement
 *  (dropping PATH etc. would break the spawn entirely). `onChunk`, when
 *  given, fires synchronously once per parsed JSONL line as stdout
 *  streams in (in order) — see docs/SDD-live-task-output.md §3.1. It's
 *  purely an observability tap: `stdout` on the resolved CommandResult
 *  is still the full accumulated text either way, so a caller that
 *  never passes onChunk sees byte-for-byte the same behavior as before
 *  streaming existed. */
export type CommandRunner = (
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; onChunk?: (line: unknown) => void },
) => Promise<CommandResult>;

export async function runViaBun(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string>; onChunk?: (line: unknown) => void },
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    opts.onChunk ? readStreamingText(proc.stdout, opts.onChunk) : new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/**
 * Reads a subprocess's stdout incrementally, splitting on newlines as
 * chunks arrive and JSON-parsing each complete line — firing `onChunk`
 * for each one, in order, as soon as it's available, rather than
 * waiting for the process to exit. Still returns the exact same full
 * text a buffered `new Response(stream).text()` read would have
 * returned (see runViaBun's own doc comment), so the caller's existing
 * end-of-run parsing is unaffected by *how* the bytes were read.
 *
 * A line that fails to JSON.parse is skipped, not thrown — same
 * tolerant-of-a-bad-line discipline codex-cli.ts's parseJsonl already
 * uses, since a partial/garbled line from a still-writing subprocess is
 * expected, not exceptional.
 */
async function readStreamingText(stream: ReadableStream<Uint8Array>, onChunk: (line: unknown) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onChunk(JSON.parse(trimmed));
    } catch {
      // tolerated — see doc comment above.
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    full += text;
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      consumeLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  full += decoder.decode();
  consumeLine(buffer);
  return full;
}

/**
 * Isolates the final non-blank line of a (possibly multi-line, streamed
 * JSONL) stdout blob — the one carrying the terminal `type: "result"`
 * object. Under today's non-streaming `--output-format json`, stdout is
 * already exactly one line, so this returns the whole string unchanged
 * (see docs/SDD-live-task-output.md §3.1's "the exact same input"
 * claim). Returns `text` itself, untrimmed, when there's no non-blank
 * line at all (empty/whitespace-only stdout) — preserves the exact
 * JSON.parse error today's callers already see for that case.
 */
function lastNonBlankLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== "") return lines[i]!;
  }
  return text;
}

interface ClaudeResultJson {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  permission_denials?: unknown[];
  total_cost_usd?: number;
  /** Present on a 429 session-limit failure — confirmed live (a real
   *  hit mid-pipeline). Absent on every other result shape. */
  api_error_status?: number;
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
  /** Passed straight through as `--allowedTools`. Real write-tier
   *  results this session repeatedly self-reported "no Bash access
   *  under acceptEdits," which motivated this option — but a direct,
   *  isolated smoke test (see docs/SDD-pipeline-automation.md §3.4's
   *  own verification notes) found `acceptEdits` alone already permits
   *  at least some Bash calls with no allowlist at all (a bare `whoami`
   *  ran unprompted); a path-restricted command (`cat` on a file
   *  outside the worktree) was correctly denied either way. What this
   *  option empirically, verifiably does: guarantees the exact listed
   *  command(s) run every time, instead of implementer's Bash access
   *  being whatever acceptEdits' own (evidently inconsistent, possibly
   *  identity/harness-dependent) heuristics happen to allow that run —
   *  confirmed live: with this set to `["Bash(bun test:*)", "Bash(bun
   *  run typecheck:*)"]`, an implementer run caught and fixed a real
   *  seeded bug via its own `bun test` output before reporting done.
   *  Undefined means no allowlist is passed — same as today. */
  allowedTools?: string[];
  /** The picked harness's env overrides, passed to the runner. Undefined
   *  when no harness was picked — identical to wissel's behavior before
   *  harnesses existed. Either way, runClaude always additionally forces
   *  ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN empty before spawning — see
   *  the comment in runClaude itself. */
  env?: Record<string, string>;
  /** Path to the global memory/lessons.md file, read fresh on every call
   *  and folded into the prompt when present (see buildAgentPrompt,
   *  docs/SDD-memory-curator.md §9). Defaults to the repo-root
   *  "memory/lessons.md" path; overridable so tests never depend on
   *  whatever's actually on disk. */
  memoryPath?: string;
  /** Fires once per parsed JSONL line, in order, as claude's stdout
   *  streams in — see docs/SDD-live-task-output.md §3.1/§3.2. When
   *  given, the spawned command switches from `--output-format json` to
   *  `--output-format stream-json --include-partial-messages --verbose`
   *  (live-confirmed: `--verbose` is required for `--print
   *  --output-format stream-json` to actually emit the intermediate
   *  `stream_event` lines rather than just the final result). The final
   *  `TaskResult` this function returns is unaffected either way — see
   *  lastNonBlankLine's own doc comment. Omitted (the default) keeps
   *  today's exact buffered-json behavior, byte for byte. */
  onChunk?: (line: unknown) => void;
}

/**
 * Shared plumbing for every headless `claude -p` invocation, read-only
 * or write: build the command, spawn it, parse its `--output-format
 * json` response into a TaskResult. The only thing that differs between
 * tiers is `--permission-mode`, which the caller picks.
 */
export async function runClaude(opts: RunClaudeOptions): Promise<TaskResult> {
  const { runner, task, agent, permissionMode, model, env, allowedTools, memoryPath, onChunk } = opts;
  const memory = await readMemoryLessons(memoryPath ?? DEFAULT_MEMORY_PATH);
  const prompt = buildAgentPrompt(task, agent, memory, { planMode: permissionMode === "plan" });
  const cmd = ["claude", "-p", prompt, "--output-format", onChunk ? "stream-json" : "json", "--permission-mode", permissionMode];
  if (onChunk) cmd.push("--include-partial-messages", "--verbose");
  if (model) cmd.push("--model", model);
  if (allowedTools && allowedTools.length > 0) cmd.push("--allowedTools", ...allowedTools);

  // Always force these two empty, harness or no harness — confirmed
  // live (not just for the auth-status probe): an ambient
  // ANTHROPIC_API_KEY set for the separate anthropic-api harness makes
  // claude treat it as the active identity, overriding the intended
  // CLAUDE_CONFIG_DIR-based claude.ai login regardless of CLAUDE_CONFIG_DIR
  // itself — the run fails outright ("connectors are disabled..."), not
  // just a cosmetic warning. harness-discovery.ts's checkClaudeCliAuth
  // already scrubs these two for its own probe; this was the real
  // execution path that was missing the same guard until a live pipeline
  // run hit it for real.
  const scopedEnv = { ...(env ?? {}), ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };

  let cmdResult: CommandResult;
  try {
    cmdResult = await runner(cmd, { cwd: task.repo, env: scopedEnv, onChunk });
  } catch (e) {
    return fail(task, agent, `failed to spawn claude: ${(e as Error).message}`);
  }

  const { stdout, stderr, exitCode } = cmdResult;

  // Parsed *before* branching on exitCode (unlike before): a non-zero
  // exit can still carry a fully-formed JSON payload with real cost and
  // error detail — confirmed live on a 429 session-limit hit, whose
  // $2.37 real charge used to vanish entirely because the old code
  // returned from the exitCode!==0 branch before ever attempting to
  // parse stdout. A parse failure here is tolerated, not thrown — the
  // exitCode branch below falls back to raw stderr/stdout exactly like
  // before when there's nothing to parse.
  //
  // Parses only the LAST non-blank line, not the whole stdout blob —
  // under non-streaming `--output-format json`, stdout is already
  // exactly one line, so this is a no-op change there (see
  // lastNonBlankLine's own doc comment); under streaming
  // (`stream-json`), stdout is many JSONL lines and the terminal
  // `type: "result"` object (byte-identical in shape to the
  // non-streaming response — see docs/SDD-live-task-output.md §2) is
  // always the last one.
  let parsed: ClaudeResultJson | undefined;
  let parseError: Error | undefined;
  try {
    parsed = JSON.parse(lastNonBlankLine(stdout)) as ClaudeResultJson;
  } catch (e) {
    parseError = e as Error;
  }

  if (exitCode !== 0) {
    // A 429 with a parseable, sane reset time isn't a real failure —
    // it's a clock. Surfacing it as `retryAfter` instead of a plain
    // fail() lets finishResult reschedule the task (Board.scheduleRetry)
    // instead of stranding it on `failed` for a human to notice and
    // manually re-run — see docs/SDD-pipeline-automation.md §3.2.
    if (parsed?.api_error_status === 429) {
      const resetAt = parseSessionLimitReset(parsed.result ?? "");
      const delayMs = resetAt ? resetAt.getTime() - Date.now() : undefined;
      if (resetAt && delayMs !== undefined && delayMs > 0 && delayMs <= MAX_RETRY_DELAY_MS) {
        return {
          taskId: task.id,
          agentId: agent.id,
          ok: false,
          summary: `claude session limit hit — retrying after ${resetAt.toISOString()}`,
          actualCost: parsed.total_cost_usd,
          retryAfter: resetAt.toISOString(),
        };
      }
    }
    return fail(task, agent, `claude exited ${exitCode}: ${(stderr || stdout).trim()}`, parsed?.total_cost_usd);
  }

  if (!parsed) {
    return fail(task, agent, `could not parse claude output: ${parseError!.message}`);
  }

  const denials = parsed.permission_denials ?? [];
  let ok = !parsed.is_error;
  let summary = denials.length > 0 ? `${parsed.result ?? "(no result)"} [${denials.length} permission denial(s)]` : parsed.result ?? "(no result)";

  // Only agents that opt into outputContractFormat: "review-verdict"
  // (today: just the reviewer — see AgentDef.outputContractFormat) get
  // their message forced through the machine-parsed verdict block. A
  // claude run that otherwise "succeeded" but produced prose instead of
  // the contract is still a failure from the caller's point of view:
  // nothing downstream can trust `summary` as a verdict. Never default
  // to approve here — see parseReviewVerdict's own contract. An agent
  // with outputContract but no outputContractFormat (e.g.
  // memory-curator, whose contract is prose formatting instructions,
  // not a machine-parsed shape) is deliberately never routed through
  // this — its raw `summary` is trusted as-is, same as before
  // outputContract existed.
  let verdict: ReviewVerdict | null = null;
  if (ok && agent.outputContract && agent.outputContractFormat === "review-verdict") {
    verdict = parseReviewVerdict(parsed.result ?? "");
    if (verdict === null) {
      ok = false;
      summary = `${agent.name} violated its output contract — expected a trailing \`\`\`review-verdict fenced block with {"verdict":"approve"|"changes_requested","feedback":"..."}, got: ${parsed.result ?? "(no result)"}`;
    }
  }

  // Same idea as the review-verdict branch above, for the planner's own
  // contract — see AgentDef.outputContractFormat's doc comment.
  let plan: SubtaskPlanItem[] | null = null;
  if (ok && agent.outputContract && agent.outputContractFormat === "subtask-plan") {
    plan = parseSubtaskPlan(parsed.result ?? "");
    if (plan === null) {
      ok = false;
      summary = `${agent.name} violated its output contract — expected a trailing \`\`\`subtask-plan fenced block with a JSON array of {title, body, labels, dependsOnIndex?}, got: ${parsed.result ?? "(no result)"}`;
    }
  }

  // Same idea again, for a pipeline step's contract — see
  // AgentDef.outputContractFormat's doc comment and
  // docs/SDD-pipelines.md §3.4. Unlike verdict/plan, a valid handoff can
  // be an "empty" shape ({} — no next/data/note at all) for a fan-out
  // step with nothing to say; parsePipelineHandoff already accepts
  // that, so `ok` only flips false here on a genuinely missing or
  // malformed block, never on an empty-but-well-formed one.
  let handoff: PipelineHandoff | null = null;
  if (ok && agent.outputContract && agent.outputContractFormat === "pipeline-handoff") {
    handoff = parsePipelineHandoff(parsed.result ?? "");
    if (handoff === null) {
      ok = false;
      summary = `${agent.name} violated its output contract — expected a trailing \`\`\`pipeline-handoff fenced block with {"next"?:"...","data"?:{...},"note"?:"..."}, got: ${parsed.result ?? "(no result)"}`;
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
    // Flattened onto TaskResult (see its own doc comment) so the
    // orchestrator can branch on a review outcome without a second
    // lookup — undefined for every non-review run, same as `verdict`
    // being null above.
    ...(verdict ? { verdict: verdict.verdict, reviewFeedback: verdict.feedback } : {}),
    ...(plan ? { subtaskPlan: plan } : {}),
    ...(handoff ? { pipelineHandoff: handoff } : {}),
  };
}

function fail(task: TaskCard, agent: AgentDef, summary: string, actualCost?: number): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary, ...(actualCost !== undefined ? { actualCost } : {}) };
}
