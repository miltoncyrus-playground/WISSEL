import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { ApiExecutor, type AnthropicMessagesClient } from "../src/executors/anthropic-api.ts";
import {
  FULL_LIFECYCLE_PIPELINE_DESCRIPTION,
  FULL_LIFECYCLE_PIPELINE_NAME,
  buildFullLifecyclePipelineGraph,
} from "../src/core/full-lifecycle-pipeline.ts";
import { REVIEW_HANDOFF_PUSHBACK_LIMIT } from "../src/core/review-handoff-pipeline.ts";
import type { CommandResult, CommandRunner } from "../src/executors/claude-cli.ts";
import type Anthropic from "@anthropic-ai/sdk";

/** Uses the REAL manifest (agents/manifest.yaml), same reasoning as
 *  test/review-handoff-pipeline.test.ts: a test that stubs out
 *  `triager`/`implementer`/`pipeline-reviewer`/`quick-answer` itself
 *  couldn't catch a real drift between this graph and what's actually
 *  declared in the manifest. */
async function realRegistry() {
  return Registry.load();
}

function scriptedClaudeRunner(claudeResponses: string[]): CommandRunner & { claudeCallCount(): number } {
  let i = 0;
  const runner: CommandRunner = async (cmd: string[]): Promise<CommandResult> => {
    if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
    const raw = claudeResponses[i++];
    if (raw === undefined) throw new Error(`claude invoked a ${i}th time — test only scripted ${claudeResponses.length} response(s)`);
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }), stderr: "", exitCode: 0 };
  };
  return Object.assign(runner, { claudeCallCount: () => i });
}

function pipelineHandoff(next: "approve" | "retry" | "escalate", note = "feedback"): string {
  return `Reviewed the diff.\n\n\`\`\`pipeline-handoff\n${JSON.stringify({ next, note })}\n\`\`\``;
}

/** quick-answer goes through ApiExecutor, not claude-cli — `triager` is
 *  `executor: readonly`, so it runs through the SAME scripted claude-cli
 *  runner as implementer/pipeline-reviewer, not this one. */
function scriptedApiClient(texts: string[]): (apiKey?: string) => AnthropicMessagesClient {
  let i = 0;
  return () => ({
    messages: {
      create: async (): Promise<Anthropic.Message> => {
        const text = texts[i++];
        if (text === undefined) throw new Error(`quick-answer invoked a ${i}th time — test only scripted ${texts.length} response(s)`);
        return {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text, citations: null }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
        } as Anthropic.Message;
      },
    },
  });
}

async function makeCtx(
  claudeResponses: string[],
  apiTexts: string[],
  homeDir: string,
): Promise<{ ctx: PipelineRunnerContext; board: SqliteBoard; claudeRunner: ReturnType<typeof scriptedClaudeRunner> }> {
  const board = new SqliteBoard();
  const claudeRunner = scriptedClaudeRunner(claudeResponses);
  const executors = [
    new WriteExecutor({ runner: claudeRunner, homeDir }),
    new ReadOnlyExecutor({ runner: claudeRunner }),
    new ApiExecutor({ clientFactory: scriptedApiClient(apiTexts) }),
  ];
  const pipelines = new SqlitePipelineStore(board.db);
  return { ctx: { executors, pipelines }, board, claudeRunner };
}

async function tmpHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-full-lifecycle-pipeline-test-"));
}

test("buildFullLifecyclePipelineGraph shape: one triage entry step feeding the same ATTEMPTS impl/rev pairs review-handoff-pipeline.ts builds", () => {
  const graph = buildFullLifecyclePipelineGraph();
  const attempts = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1;

  const triageSteps = graph.steps.filter((s) => s.agentId === "triager");
  expect(triageSteps).toHaveLength(1);
  expect(graph.edges.some((e) => e.to === triageSteps[0]!.id)).toBe(false); // the only true entry step

  const implSteps = graph.steps.filter((s) => s.agentId === "implementer");
  const revSteps = graph.steps.filter((s) => s.agentId === "pipeline-reviewer");
  expect(implSteps).toHaveLength(attempts);
  expect(revSteps).toHaveLength(attempts);

  // Triage's own outgoing edge lands on the first implementer step, and
  // nothing else points at the first implementer step — triage is the
  // real, only entry point into the loop.
  const intoImpl1 = graph.edges.filter((e) => e.to === "impl-1");
  expect(intoImpl1).toHaveLength(1);
  expect(intoImpl1[0]!.from).toBe(triageSteps[0]!.id);

  const escalateEdges = graph.edges.filter((e) => e.label === "escalate");
  expect(escalateEdges).toHaveLength(1);
  expect(escalateEdges[0]!.from).toBe(`rev-${attempts}`);

  const approveEdges = graph.edges.filter((e) => e.label === "approve");
  expect(approveEdges).toHaveLength(attempts);
  expect(new Set(approveEdges.map((e) => e.to))).toEqual(new Set(["approved"]));

  const retryEdges = graph.edges.filter((e) => e.label === "retry");
  expect(retryEdges).toHaveLength(attempts - 1);

  // Exactly one entry step overall: only "triage" has zero incoming edges.
  const entrySteps = graph.steps.filter((step) => !graph.edges.some((e) => e.to === step.id));
  expect(entrySteps.map((s) => s.id)).toEqual(["triage"]);
});

test("triage runs first, then approve on the very first review reaches done after exactly 1 implementer attempt", async () => {
  const home = await tmpHome();
  try {
    const { ctx, board, claudeRunner } = await makeCtx(
      ["Structured the card.", "Implemented it.", pipelineHandoff("approve", "looks good")],
      ["Pipeline completed successfully."],
      home,
    );
    const registry = await realRegistry();
    const graph = buildFullLifecyclePipelineGraph();
    const pipelineDef = await ctx.pipelines.create({ name: FULL_LIFECYCLE_PIPELINE_NAME, description: FULL_LIFECYCLE_PIPELINE_DESCRIPTION, graph });

    const root = await startPipelineRun(board, registry, pipelineDef, "/tmp/repo", "Add sum(a, b)", ctx);

    expect(root.status).toBe("done");
    expect(claudeRunner.claudeCallCount()).toBe(3); // triage + implementer + reviewer, no more
    const cards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(cards.map((c) => c.pipelineStepId).sort()).toEqual(["approved", "impl-1", "rev-1", "triage"].sort());
    expect(cards.every((c) => c.status === "done")).toBe(true);

    // Depth-first traversal order: board.list() returns rows in insertion
    // order (`ORDER BY rowid`, src/services/board.ts) — triage's own card
    // is created strictly before impl-1's, proving it actually gates
    // entry into the loop rather than running in parallel with it.
    const stepOrder = cards.map((c) => c.pipelineStepId);
    expect(stepOrder.indexOf("triage")).toBeLessThan(stepOrder.indexOf("impl-1"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("changes_requested every time escalates on the 6th rejected attempt, same cap as review-handoff-pipeline.ts, with triage still running exactly once", async () => {
  const home = await tmpHome();
  try {
    const attempts = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1;
    const claudeResponses: string[] = ["Structured the card."];
    for (let n = 1; n <= attempts; n++) {
      claudeResponses.push(`Implemented attempt ${n}.`);
      claudeResponses.push(n === attempts ? pipelineHandoff("escalate", "still broken") : pipelineHandoff("retry", "not quite right"));
    }
    const { ctx, board, claudeRunner } = await makeCtx(claudeResponses, ["Escalating to a human."], home);
    const registry = await realRegistry();
    const graph = buildFullLifecyclePipelineGraph();
    const pipelineDef = await ctx.pipelines.create({ name: FULL_LIFECYCLE_PIPELINE_NAME, description: FULL_LIFECYCLE_PIPELINE_DESCRIPTION, graph });

    const root = await startPipelineRun(board, registry, pipelineDef, "/tmp/repo", "Add isEvenSpecial(n)", ctx);

    expect(root.status).toBe("done"); // the escalated-notice step itself succeeds
    expect(claudeRunner.claudeCallCount()).toBe(1 + attempts * 2); // 1 triage + ATTEMPTS implementer + ATTEMPTS reviewer calls, no more

    const cards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(cards.filter((c) => c.pipelineStepId === "triage")).toHaveLength(1);
    expect(cards.filter((c) => c.pipelineStepId?.startsWith("impl-"))).toHaveLength(attempts);
    expect(cards.filter((c) => c.pipelineStepId?.startsWith("rev-"))).toHaveLength(attempts);
    expect(cards.some((c) => c.pipelineStepId === "escalated")).toBe(true);
    expect(cards.some((c) => c.pipelineStepId === "approved")).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
