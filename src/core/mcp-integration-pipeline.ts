import type { PipelineGraph } from "./types.ts";

/**
 * The heterogeneous proof-of-concept named by docs/SDD-mcp-orchestration.md
 * §6 Subtask 7 — a real `PipelineGraph` with one step bound to an
 * existing coding agent (`implementer`) and one step bound to a new
 * MCP-tool-calling agent (`mcp-tool-caller`, agents/manifest.yaml),
 * proving the pipeline engine composes a file-editing step and an
 * MCP-tool-calling step in the same run with zero new pipeline-runner.ts
 * primitives — mirrors buildReviewHandoffPipelineGraph's own shape
 * exactly (src/core/review-handoff-pipeline.ts): a pure, deterministic
 * builder function, same reasoning (a test or caller seeding a stored
 * PipelineDef always gets an independent, safe-to-mutate object).
 *
 * Both steps are `transition: "all"` — this isn't testing choose/
 * branching/joins (see the card's own explicit scope), just that a
 * step's result (file diff, or an MCP transcript) flows into the next
 * step's prompt and the run reaches `done` with both step TaskCards
 * carrying their own result shape: a worktree/diff for "code", and
 * `TaskResult.mcpCalls` for "call-tool". Neither step needs a
 * pipeline-handoff contract for the same reason buildReviewHandoffPipelineGraph's
 * own impl steps don't: "all" activates its one outgoing edge
 * unconditionally, off nothing but the step's own plain success/failure.
 */
export const MCP_INTEGRATION_PIPELINE_NAME = "Coding + MCP-Tool Integration Proof";
export const MCP_INTEGRATION_PIPELINE_DESCRIPTION =
  "Proves the pipeline engine (src/core/pipeline-runner.ts) composes a file-editing coding step and an MCP-tool-calling " +
  "step in one run with zero new runner primitives. See docs/SDD-mcp-orchestration.md §6 Subtask 7.";

export function buildMcpIntegrationPipelineGraph(): PipelineGraph {
  return {
    steps: [
      { id: "code", name: "Implement the requested change", agentId: "implementer", transition: "all" },
      {
        id: "call-tool",
        name: 'Call the granted "echo" MCP tool with a short argument and report exactly what it returned',
        agentId: "mcp-tool-caller",
        transition: "all",
      },
    ],
    edges: [{ id: "e-code-call-tool", from: "code", to: "call-tool" }],
  };
}
