import type { TaskResult } from "../core/types.ts";
import { mcpToolName, type ResolvedMcpGrant } from "./mcp-config.ts";

type McpCall = NonNullable<TaskResult["mcpCalls"]>[number];

/**
 * Pulls `TaskResult.mcpCalls` out of a claude-cli `--output-format
 * stream-json --include-partial-messages --verbose` run's raw, full
 * stdout — the exact same JSONL blob runClaude already receives as
 * `cmdResult.stdout` regardless of whether an `onChunk` live-display
 * tap was also wired up (see RunClaudeOptions.onChunk's own doc
 * comment: `stdout` on the resolved CommandResult is always the full
 * accumulated text).
 *
 * Built against the officially-documented shape — not a guess, but also
 * not a live-observed one: no round-trip against a real attached MCP
 * server was performed (see docs/SDD-mcp-orchestration.md's "Revision
 * (subtask 2, shipped)" callout). The generic tool_use/tool_result
 * envelope below is well corroborated elsewhere in this codebase; whether
 * a granted MCP tool actually surfaces as `mcp__<server>__<tool>` in
 * practice remains an open empirical item for subtask 7.
 * - A tool call is a `tool_use` content block
 *   (`{type:"tool_use", id, name, input}`) inside a top-level
 *   `type:"assistant"` message's `message.content` array. Claude Code
 *   emits one complete `AssistantMessage` per finished content block
 *   even with partial-message streaming on (confirmed:
 *   code.claude.com/docs/en/agent-sdk/streaming-output's "Message
 *   flow" — "Claude Code emits an AssistantMessage as each non-empty
 *   content block completes... each one carries only its own content
 *   block"), so reading the complete block's `input` here needs no
 *   content_block_delta/input_json_delta accumulation at all.
 * - A tool's result is a `tool_result` content block
 *   (`{type:"tool_result", tool_use_id, content, is_error}`) inside a
 *   top-level `type:"user"` message's `message.content` array — never
 *   nested in a stream_event (confirmed live elsewhere in this
 *   codebase; see render-task-output.js's own header comment and
 *   docs/SDD-live-task-output.md §9's revision callout for the same
 *   finding). Correlated back to its call via `tool_use_id` matching
 *   the tool_use block's own `id` (confirmed:
 *   platform.claude.com/docs/en/agents-and-tools/tool-use/overview's
 *   full request/response round trip).
 * - The MCP tool-naming convention (`mcp__<server>__<tool>`) is
 *   confirmed against code.claude.com/docs/en/mcp.
 *
 * Only `tool_use` blocks whose `name` matches one of `grants`' own
 * `mcp__<server>__<tool>` names are tracked — a plain Read/Bash/Edit
 * call (or an MCP tool this run wasn't actually granted) is never
 * captured. Returns `undefined` for zero grants or zero matched calls —
 * same "absence always means nothing to show" discipline
 * TaskResult.mcpCalls's own doc comment holds.
 */
export function parseMcpCalls(stdout: string, grants: ResolvedMcpGrant[]): McpCall[] | undefined {
  if (grants.length === 0) return undefined;

  const grantedServerByName = new Map<string, string>();
  for (const { server, tools } of grants) {
    for (const tool of tools) grantedServerByName.set(mcpToolName(server.id, tool), server.id);
  }

  const pending = new Map<string, { server: string; tool: string; args: unknown }>();
  const calls: McpCall[] = [];

  for (const rawLine of stdout.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let line: unknown;
    try {
      line = JSON.parse(trimmed);
    } catch {
      continue; // partial/unparseable line — tolerated, same as every other JSONL reader in this codebase
    }
    if (!line || typeof line !== "object") continue;
    const obj = line as { type?: string; message?: { content?: unknown[] } };

    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message!.content!) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (b?.type !== "tool_use" || !b.name || !b.id) continue;
        const serverId = grantedServerByName.get(b.name);
        if (!serverId) continue;
        const tool = b.name.slice(`mcp__${serverId}__`.length);
        pending.set(b.id, { server: serverId, tool, args: b.input });
      }
      continue;
    }

    if (obj.type === "user" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message!.content!) {
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue;
        calls.push({ server: call.server, tool: call.tool, args: call.args, result: b.content, ok: !b.is_error });
        pending.delete(b.tool_use_id);
      }
    }
  }

  return calls.length > 0 ? calls : undefined;
}
