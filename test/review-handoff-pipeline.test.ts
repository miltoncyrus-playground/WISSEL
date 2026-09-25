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
  REVIEW_HANDOFF_PIPELINE_DESCRIPTION,
  REVIEW_HANDOFF_PIPELINE_NAME,
  REVIEW_HANDOFF_PUSHBACK_LIMIT,
  buildReviewHandoffPipelineGraph,
} from "../src/core/review-handoff-pipeline.ts";
import type { CommandResult, CommandRunner } from "../src/executors/claude-cli.ts";
import type { PipelineGraph } from "../src/core/types.ts";
import type Anthropic from "@anthropic-ai/sdk";

/** Uses the REAL manifest (agents/manifest.yaml) rather than a hand-built
 *  registry — this is deliberate, mirroring the "drive it through the
 *  real dispatch surface" lesson elsewhere in this repo's test suite: a
 *  test that stubs out `implementer`/`pipeline-reviewer`/`quick-answer`
 *  itself couldn't catch a real drift between this graph and what's
 *  actually declared in the manifest (a renamed agent id, a dropped
 *  outputContractFormat, etc). */
async function realRegistry() {
  return Registry.load();
}

/** Fakes `git worktree ...` as always-clean (mirrors write-executor.test.ts's
 *  own `fakeRunner`) and answers every `claude -p` call with the next
 *  scripted response, in call order — pipeline-runner.ts's traversal is
 *  deliberately sequential/depth-first (see startPipelineRun's own doc
 *  comment), so call order here is deterministic. */
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

/** quick-answer (the "approved"/"escalated" terminal steps) goes through
 *  ApiExecutor, not claude-cli — a separate fake, one text response per
 *  call, in call order. */
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
  return mkdtemp(join(tmpdir(), "wissel-review-handoff-pipeline-test-"));
}

test("buildReviewHandoffPipelineGraph shape: ATTEMPTS implementer/reviewer pairs, capped exactly like handleReviewVerdict", () => {
  const graph = buildReviewHandoffPipelineGraph();
  const attempts = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1;

  const implSteps = graph.steps.filter((s) => s.agentId === "implementer");
  const revSteps = graph.steps.filter((s) => s.agentId === "pipeline-reviewer");
  expect(implSteps).toHaveLength(attempts);
  expect(revSteps).toHaveLength(attempts);

  // Every implementer step is "all" — see the file's own doc comment for
  // why: the real `implementer` agent has no pipeline-handoff contract.
  expect(implSteps.every((s) => s.transition === "all")).toBe(true);
  expect(revSteps.every((s) => s.transition === "choose")).toBe(true);

  // Exactly one "escalate"-labelled edge, out of the LAST reviewer step
  // only — matches handleReviewVerdict's own "only escalates at the cap"
  // behavior.
  const escalateEdges = graph.edges.filter((e) => e.label === "escalate");
  expect(escalateEdges).toHaveLength(1);
  expect(escalateEdges[0]!.from).toBe(`rev-${attempts}`);

  // Every reviewer step has an "approve" edge to the same shared terminal.
  const approveEdges = graph.edges.filter((e) => e.label === "approve");
  expect(approveEdges).toHaveLength(attempts);
  expect(new Set(approveEdges.map((e) => e.to))).toEqual(new Set(["approved"]));

  // Every non-final reviewer step has a "retry" edge to the next attempt.
  const retryEdges = graph.edges.filter((e) => e.label === "retry");
  expect(retryEdges).toHaveLength(attempts - 1);
});

test("approve on the very first review reaches done after exactly 1 implementer attempt", async () => {
  const home = await tmpHome();
  try {
    const { ctx, board } = await makeCtx(
      ["Implemented it.", pipelineHandoff("approve", "looks good")],
      ["Pipeline completed successfully."],
      home,
    );
    const registry = await realRegistry();
    const graph = buildReviewHandoffPipelineGraph();
    const pipelineDef = await ctx.pipelines.create({ name: REVIEW_HANDOFF_PIPELINE_NAME, description: REVIEW_HANDOFF_PIPELINE_DESCRIPTION, graph });

    const root = await startPipelineRun(board, registry, pipelineDef, "/tmp/repo", "Add sum(a, b)", ctx);

    expect(root.status).toBe("done");
    const cards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    expect(cards.map((c) => c.pipelineStepId).sort()).toEqual(["approved", "impl-1", "rev-1"].sort());
    expect(cards.every((c) => c.status === "done")).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("changes_requested every time escalates on the 6th rejected attempt — same cap as handleReviewVerdict's pushbackCount >= 5", async () => {
  const home = await tmpHome();
  try {
    const attempts = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1;
    const claudeResponses: string[] = [];
    for (let n = 1; n <= attempts; n++) {
      claudeResponses.push(`Implemented attempt ${n}.`);
      claudeResponses.push(n === attempts ? pipelineHandoff("escalate", "still broken") : pipelineHandoff("retry", "not quite right"));
    }
    const { ctx, board, claudeRunner } = await makeCtx(claudeResponses, ["Escalating to a human."], home);
    const registry = await realRegistry();
    const graph = buildReviewHandoffPipelineGraph();
    const pipelineDef = await ctx.pipelines.create({ name: REVIEW_HANDOFF_PIPELINE_NAME, description: REVIEW_HANDOFF_PIPELINE_DESCRIPTION, graph });

    const root = await startPipelineRun(board, registry, pipelineDef, "/tmp/repo", "Add isEvenSpecial(n)", ctx);

    expect(root.status).toBe("done"); // the escalated-notice step itself succeeds
    expect(claudeRunner.claudeCallCount()).toBe(attempts * 2); // ATTEMPTS implementer + ATTEMPTS reviewer calls, no more

    const cards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
    const implCards = cards.filter((c) => c.pipelineStepId?.startsWith("impl-"));
    const revCards = cards.filter((c) => c.pipelineStepId?.startsWith("rev-"));
    expect(implCards).toHaveLength(attempts);
    expect(revCards).toHaveLength(attempts);
    expect(cards.some((c) => c.pipelineStepId === "escalated")).toBe(true);
    expect(cards.some((c) => c.pipelineStepId === "approved")).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a literal retry cycle has no entry point at all and fails immediately — zero steps ever run, which is exactly why review-handoff-pipeline.ts unrolls instead of looping", async () => {
  // A 2-step graph where the reviewer's own "retry" edge points back at
  // the SAME implementer step id, instead of a fresh one — the naive
  // shape someone might reach for before reading startPipelineRun's own
  // entry-step rule ("a step with zero incoming edges"): a cycle means
  // every step in it has an incoming edge from within the cycle, so
  // there's no entry step, and the whole run fails before anything runs.
  const board = new SqliteBoard();
  const registry = Registry.from([
    {
      id: "cycle-impl",
      name: "cycle-impl",
      kind: "agent",
      tier: "readonly",
      description: "test",
      whenToUse: "test",
      tags: ["test"],
      executor: "readonly",
      inputs: [],
      outputs: [],
      trustLevel: "low",
      toolAccess: ["read"],
      costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
    },
    {
      id: "cycle-rev",
      name: "cycle-rev",
      kind: "agent",
      tier: "readonly",
      description: "test",
      whenToUse: "test",
      tags: ["test"],
      executor: "readonly",
      inputs: [],
      outputs: [],
      trustLevel: "low",
      toolAccess: ["read"],
      costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
      outputContract: "```pipeline-handoff``` required",
      outputContractFormat: "pipeline-handoff",
    },
  ]);
  const graph: PipelineGraph = {
    steps: [
      { id: "impl", name: "Impl", agentId: "cycle-impl", transition: "all" },
      { id: "rev", name: "Rev", agentId: "cycle-rev", transition: "choose" },
    ],
    edges: [
      { id: "e1", from: "impl", to: "rev" },
      { id: "e2", from: "rev", to: "impl", label: "retry" }, // the naive cycle
    ],
  };
  const runner = scriptedClaudeRunner(["did the work", pipelineHandoff("retry", "try again")]);
  const pipelines = new SqlitePipelineStore(board.db);
  const ctx: PipelineRunnerContext = { executors: [new ReadOnlyExecutor({ runner })], pipelines };
  const pipelineDef = await pipelines.create({ name: "Naive cycle", description: "", graph });

  const root = await startPipelineRun(board, registry, pipelineDef, "/tmp/repo", "do the thing", ctx);

  // Both "impl" and "rev" have an incoming edge (from each other), so
  // neither qualifies as an entry step — startPipelineRun fails the run
  // immediately, before a single claude call is made.
  expect(root.status).toBe("failed");
  expect(runner.claudeCallCount()).toBe(0);
  const stepCards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
  expect(stepCards).toHaveLength(0);
});
