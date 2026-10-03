import type { TaskResult } from "../core/types.ts";

type McpCall = NonNullable<TaskResult["mcpCalls"]>[number];

/**
 * What a `reviewTarget: "tool-calls"` reviewer reads instead of a diff
 * (see spawnReviewerTask, src/core/orchestrator.ts): a pure, deterministic
 * rendering of a run's `TaskResult.mcpCalls` into human/model-readable
 * text, in call order — no LLM involved, mirrors `getRepoDiff`'s own
 * mechanical role (src/services/repo-diff.ts).
 *
 * Args/results are JSON.stringify'd rather than printed as objects —
 * this text is spliced verbatim into a task body string, so it needs to
 * already be a string, not an object a template literal would otherwise
 * stringify via `[object Object]`.
 */
export function formatMcpTranscript(calls: McpCall[]): string {
  if (calls.length === 0) return "(no MCP tool calls were made)";

  return calls
    .map((call, i) => {
      const status = call.ok ? "ok" : "failed";
      return [
        `${i + 1}. ${call.server}.${call.tool} — ${status}`,
        `   args: ${JSON.stringify(call.args)}`,
        `   result: ${JSON.stringify(call.result)}`,
      ].join("\n");
    })
    .join("\n");
}
