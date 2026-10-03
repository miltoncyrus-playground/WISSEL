import type { McpApprovalRequest } from "../core/types.ts";

/** Matches a fenced ```mcp-approval-request block anywhere in the text —
 *  same reasoning as HANDOFF_BLOCK in parse-pipeline-handoff.ts: the
 *  contract asks for the final message to *end with* one, but the raw
 *  text here is whatever claude printed, prose and all, so this has to
 *  find the block rather than assume the whole string is JSON. `g` +
 *  taking the last match handles a model that "thinks out loud" with an
 *  earlier example block before the real one. */
const APPROVAL_REQUEST_BLOCK = /```mcp-approval-request\s*\n([\s\S]*?)```/g;

/** Deliberately separate, non-global pattern used only to answer "did
 *  the model attempt this block at all" — see
 *  mcpApprovalRequestBlockPresent's own doc comment for why this can't
 *  just reuse APPROVAL_REQUEST_BLOCK.test(). */
const APPROVAL_REQUEST_FENCE = /```mcp-approval-request\s*\n/;

/**
 * True the moment the model's output contains the opening fence of an
 * mcp-approval-request block at all, well-formed or not. This is what
 * lets the caller (runClaude, src/executors/claude-cli.ts) tell apart
 * two different "nothing usable" outcomes that parseMcpApprovalRequest
 * itself can't distinguish (it returns `null` for both):
 *
 * - The agent had nothing to request — a legitimate, non-failing
 *   outcome. Unlike review-verdict/subtask-plan/pipeline-handoff, this
 *   contract is OPTIONAL: an agent with a pending-approval grant may
 *   simply have no blocked call to describe this run, and the prompt
 *   (see buildAgentPrompt's pendingMcpApprovalTools option) explicitly
 *   tells it not to emit the block in that case.
 * - The agent DID attempt the block but produced something malformed —
 *   a real contract violation, which runClaude fails closed on exactly
 *   like every other output contract in this codebase.
 *
 * Intentionally NOT implemented by calling `.test()` on
 * APPROVAL_REQUEST_BLOCK directly: that regex carries the `g` flag, and
 * `RegExp.prototype.test` mutates a global regex's own `lastIndex`
 * across calls — a second call against different input could silently
 * start mid-string. A fresh, non-global pattern has no such state to
 * corrupt.
 */
export function mcpApprovalRequestBlockPresent(rawOutput: string): boolean {
  return APPROVAL_REQUEST_FENCE.test(rawOutput);
}

/**
 * The only code allowed to turn raw claude output into an
 * McpApprovalRequest. Strict on purpose, mirroring parseReviewVerdict's/
 * parsePipelineHandoff's own contract: malformed, missing, or ambiguous
 * input returns null — it never guesses a server/tool/args, because an
 * agent's own account of a blocked tool call is exactly the kind of
 * thing a human approver has to trust literally, not a best-effort
 * reconstruction of what the model probably meant.
 *
 * `args` is accepted as whatever JSON value the agent supplied (object,
 * array, primitive) — the real tool's own argument shape isn't known to
 * this parser, so it only requires the key to be present, never a
 * specific type. `server`/`tool`/`reason` must each be a non-empty
 * string. See docs/SDD-mcp-orchestration.md §3.5.
 */
export function parseMcpApprovalRequest(rawOutput: string): McpApprovalRequest | null {
  const matches = [...rawOutput.matchAll(APPROVAL_REQUEST_BLOCK)];
  if (matches.length === 0) return null;

  const body = matches[matches.length - 1]![1]!.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { server, tool, args, reason } = candidate as Record<string, unknown>;

  if (typeof server !== "string" || server.length === 0) return null;
  if (typeof tool !== "string" || tool.length === 0) return null;
  if (args === undefined) return null;
  if (typeof reason !== "string" || reason.length === 0) return null;

  return { server, tool, args, reason };
}
