import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { appendTaskOutput } from "../src/services/task-output.ts";
import { buildPipelineRunSummary, parseRunStats, stepNameFromTitle, type PipelineRunSummary } from "../src/services/pipeline-run-summary.ts";
import type { AgentDef, Executor } from "../src/core/types.ts";

// GET /pipeline-runs/:runId, the run drawer's read-only summary
// (docs/SDD-ui-cleanup.md §4.1, card B1).

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

function stepAgent(id: string, model = "claude-sonnet-5"): AgentDef {
  return {
    id, name: id, kind: "agent", tier: "readonly", description: "test pipeline step agent", whenToUse: "test only",
    tags: ["test"], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"],
    costProfile: { model, estUsdPerTask: 0.01 },
    outputContract: "Your final message must end with a ```pipeline-handoff``` block.",
    outputContractFormat: "pipeline-handoff",
  };
}

const graph = {
  steps: [
    { id: "a", name: "Plan", agentId: "step-a", transition: "choose" as const },
    { id: "b", name: "Build", agentId: "step-b", transition: "choose" as const },
  ],
  edges: [{ id: "e1", from: "a", to: "b" }],
};

test("parseRunStats reads claude's init model and result duration_ms, skipping anything else", () => {
  const lines = [
    "not json",
    JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5", cwd: "/x" }),
    JSON.stringify({ type: "assistant", message: { model: "something-else" } }),
    JSON.stringify({ type: "result", subtype: "success", duration_ms: 1234, total_cost_usd: 0.5 }),
    // claude can print system lines after its result line
    JSON.stringify({ type: "system", subtype: "hook" }),
  ];
  expect(parseRunStats(lines)).toEqual({ model: "claude-opus-5-5", durationMs: 1234 });
});

test("parseRunStats gives nulls for output it doesn't recognize (codex events, nothing at all)", () => {
  expect(parseRunStats([])).toEqual({ model: null, durationMs: null });
  expect(parseRunStats([JSON.stringify({ type: "thread.started" }), JSON.stringify({ type: "turn.completed", usage: {} })])).toEqual({ model: null, durationMs: null });
  expect(parseRunStats([JSON.stringify({ type: "result", duration_ms: "12" }), JSON.stringify({ type: "system", subtype: "init", model: "" })])).toEqual({ model: null, durationMs: null });
  expect(parseRunStats(["[1,2]", "null", "42"])).toEqual({ model: null, durationMs: null });
});

test("stepNameFromTitle strips the pipeline-name prefix runStepAndSuccessors adds", () => {
  expect(stepNameFromTitle("Review-Handoff Loop: Reviewer", "Pipeline: Review-Handoff Loop")).toBe("Reviewer");
  expect(stepNameFromTitle("Other: Reviewer", "Pipeline: Review-Handoff Loop")).toBe("Other: Reviewer");
  expect(stepNameFromTitle("Loop: Reviewer", "Not a pipeline")).toBe("Loop: Reviewer");
});

test("GET /pipeline-runs/:runId summarizes a real run: steps in order with agent, model, duration and cost", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-run-summary-"));
  try {
    const board = new SqliteBoard();
    const registry = Registry.from([stepAgent("step-a"), stepAgent("step-b", "claude-haiku-4-5-20251001")]);
    let calls = 0;
    const executor: Executor = {
      id: "fake-pipeline",
      canHandle: (agent) => agent.outputContractFormat === "pipeline-handoff",
      run: async (task, agent) => {
        calls++;
        if (calls === 1) {
          // What a claude-cli step streams into the durable output.
          await appendTaskOutput(task.id, { type: "system", subtype: "init", model: "claude-opus-5-5" }, dir);
          await appendTaskOutput(task.id, { type: "result", subtype: "success", duration_ms: 4200, total_cost_usd: 0.12 }, dir);
          return { taskId: task.id, agentId: agent.id, ok: true, summary: "planned", actualCost: 0.12, pipelineHandoff: { next: "Build" } };
        }
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "built", pipelineHandoff: {} };
      },
    };
    const app = createApp(board, registry, undefined, { manualExecutors: [executor], taskOutputDir: dir });

    const pipeline = (await (await app(req("/pipelines", { method: "POST", body: JSON.stringify({ name: "Ship it", description: "", graph }) }))).json()) as { id: string };
    const root = (await (await app(req(`/pipelines/${pipeline.id}/run`, { method: "POST", body: JSON.stringify({ repo: "/tmp/repo", input: "go" }) }))).json()) as { id: string };

    const res = await app(req(`/pipeline-runs/${root.id}`));
    expect(res.status).toBe(200);
    const summary = (await res.json()) as PipelineRunSummary;
    expect(summary.root.id).toBe(root.id);
    expect(summary.root.status).toBe("done");
    expect(summary.pipeline).toEqual({ id: pipeline.id, name: "Ship it", stepCount: 2 });
    expect(summary.steps.map((s) => ({ ...s, taskId: typeof s.taskId }))).toEqual([
      { taskId: "string", stepId: "a", stepName: "Plan", attempt: 1, agentId: "step-a", harness: null, model: "claude-opus-5-5", modelSource: "output", status: "done", durationMs: 4200, cost: 0.12 },
      // No output: the model falls back to what config resolves, and says so.
      { taskId: "string", stepId: "b", stepName: "Build", attempt: 1, agentId: "step-b", harness: null, model: "claude-haiku-4-5-20251001", modelSource: "config", status: "done", durationMs: null, cost: null },
    ]);
    expect(summary.totalCost).toBe(0.12);

    // Only a run root has a summary: a step card's own id, a plain task
    // and an unknown id all 404.
    expect((await app(req(`/pipeline-runs/${summary.steps[0]!.taskId}`))).status).toBe(404);
    const plain = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "plain", body: "x", labels: [], repo: "/tmp/repo" }) }))).json()) as { id: string };
    expect((await app(req(`/pipeline-runs/${plain.id}`))).status).toBe(404);
    expect((await app(req("/pipeline-runs/nope"))).status).toBe(404);

    // Read-only: the summary changed nothing on the board.
    const before = JSON.stringify(await board.list());
    await app(req(`/pipeline-runs/${root.id}`));
    expect(JSON.stringify(await board.list())).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a step run twice counts attempts; a deleted definition falls back to titles; the stamped harness picks the config model", async () => {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const registry = Registry.from([stepAgent("step-a")]);
  const harnesses = HarnessPool.from([{ id: "h1", tool: "claude-cli", label: "H1", enabled: true, model: "claude-from-harness" }]);
  const def = await pipelines.create({ name: "Loop", description: "", graph });
  const root = await board.create({ title: "Pipeline: Loop", body: "in", labels: [], repo: "/r", pipelineId: def.id });
  const first = await board.create({ title: "Loop: Plan", body: "in", labels: [], repo: "/r", parentTaskId: root.id, pipelineId: def.id, pipelineRunId: root.id, pipelineStepId: "a" });
  await board.move(first.id, "failed");
  const second = await board.create({ title: "Loop: Plan", body: "in", labels: [], repo: "/r", parentTaskId: root.id, pipelineId: def.id, pipelineRunId: root.id, pipelineStepId: "a" });
  await board.setHarness(second.id, "h1");
  await board.recordResult({ taskId: second.id, agentId: "step-a", ok: true, summary: "ok", actualCost: 0.5, harnessId: "h1" });
  await pipelines.delete(def.id);

  const summary = await buildPipelineRunSummary({ board, pipelines, registry, harnesses, readOutput: async () => [] }, root.id);
  expect(summary?.pipeline).toBeNull();
  expect(summary?.steps.map((s) => [s.stepName, s.attempt, s.status, s.harness, s.model, s.modelSource, s.cost])).toEqual([
    // The failed first try never recorded a result: agent unknown, so no model either.
    ["Plan", 1, "failed", null, null, null, null],
    ["Plan", 2, "inbox", "h1", "claude-from-harness", "config", 0.5],
  ]);
  expect(summary?.totalCost).toBe(0.5);
  expect(await buildPipelineRunSummary({ board, pipelines, registry, harnesses, readOutput: async () => [] }, first.id)).toBeUndefined();
});
