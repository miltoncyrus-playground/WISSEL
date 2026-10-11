import { expect, test } from "bun:test";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { resumePipelineStep, startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import type { AgentDef, Executor, PipelineDef, PipelineGraph, TaskCard, TaskResult } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";

// A pipeline step that hits a session limit (429) is rescheduled to
// inbox with a retryAfter. Regression, 2026-10-11: both 06:00 podcast
// runs hit it on their gather step; nothing ever ran the step again
// (sweep() skips pipeline cards, the runner had returned) and settleRoot
// marked both roots "done" anyway. docs/SDD-pipelines.md §3.8.

function stepAgent(id: string): AgentDef {
  return {
    id,
    name: id,
    kind: "agent",
    tier: "readonly",
    description: "test pipeline step agent",
    whenToUse: "test only",
    tags: ["test"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
    outputContract: "",
    outputContractFormat: "pipeline-handoff",
  };
}

type Outcome = "ok" | "429-past" | "429-future";

/** Answers each call with the next scripted outcome for that step id,
 *  and records the call order and the peak number of calls in flight. */
function scriptedExecutor(script: Record<string, Outcome[]>) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const executor: Executor = {
    id: "fake-step",
    canHandle: () => true,
    async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      calls.push(task.pipelineStepId!);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const outcome = script[task.pipelineStepId!]?.shift() ?? "ok";
      if (outcome === "ok") return { taskId: task.id, agentId: agent.id, ok: true, summary: "did it", pipelineHandoff: { note: `from ${task.pipelineStepId}` } };
      const retryAfter = new Date(Date.now() + (outcome === "429-past" ? -1000 : 60_000)).toISOString();
      return { taskId: task.id, agentId: agent.id, ok: false, summary: "session limit", retryAfter };
    },
  };
  return { executor, calls, peak: () => peak };
}

const LINEAR: PipelineGraph = {
  steps: [
    { id: "gather", name: "Gather", agentId: "step-gather", transition: "all" },
    { id: "write", name: "Write", agentId: "step-write", transition: "all" },
  ],
  edges: [{ id: "e1", from: "gather", to: "write" }],
};

async function setup(graph: PipelineGraph, script: Record<string, Outcome[]>) {
  const board = new SqliteBoard();
  const registry = Registry.from(graph.steps.map((s) => stepAgent(s.agentId)));
  const fake = scriptedExecutor(script);
  const ctx: PipelineRunnerContext = { executors: [fake.executor], pipelines: new SqlitePipelineStore(board.db) };
  const def: PipelineDef = await ctx.pipelines.create({ name: "Podcast", description: "", graph });
  const orchestrator = (withResume = true) =>
    new Orchestrator(board, registry, new Router(registry), [], undefined, withResume ? { resumePipelineStep: (t) => resumePipelineStep(board, registry, t, ctx) } : {});
  const stepsOf = async (runId: string) => (await board.list()).filter((t) => t.pipelineRunId === runId);
  return { board, registry, ctx, def, fake, orchestrator, stepsOf };
}

test("a run whose step was rate-limited stays running, not done", async () => {
  const { board, registry, ctx, def, stepsOf } = await setup(LINEAR, { gather: ["429-future"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  expect(root.status).toBe("running");
  const [gather] = await stepsOf(root.id);
  expect(gather!.status).toBe("inbox");
  expect(gather!.retryAfter).toBeDefined();
});

test("sweep() resumes a due step and carries the run through its successors to done", async () => {
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  expect(fake.calls).toEqual(["gather"]);

  await orchestrator().sweep();

  expect(fake.calls).toEqual(["gather", "gather", "write"]);
  const steps = await stepsOf(root.id);
  expect(steps.map((s) => [s.pipelineStepId, s.status])).toEqual([
    ["gather", "done"],
    ["write", "done"],
  ]);
  // The resumed step is the same card, not a copy.
  expect(steps).toHaveLength(2);
  expect((await board.get(root.id))!.status).toBe("done");
  // The successor got the resumed step's handoff, as on a normal run.
  expect(steps[1]!.body).toContain("from gather");
});

test("sweep() leaves a step alone until its retryAfter passes", async () => {
  const { board, registry, ctx, def, fake, orchestrator } = await setup(LINEAR, { gather: ["429-future"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  await orchestrator().sweep();
  expect(fake.calls).toEqual(["gather"]);
  expect((await board.get(root.id))!.status).toBe("running");
});

test("without resumePipelineStep wired, sweep() still never touches a pipeline card", async () => {
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  await orchestrator(false).sweep();
  expect(fake.calls).toEqual(["gather"]);
  const [gather] = await stepsOf(root.id);
  expect(gather!.status).toBe("inbox");
  expect(gather!.routedTo).toBeUndefined();
});

test("a second 429 on resume sends the step back to wait and keeps the root running", async () => {
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(LINEAR, { gather: ["429-past", "429-future"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  await orchestrator().sweep();
  expect(fake.calls).toEqual(["gather", "gather"]);
  const [gather] = await stepsOf(root.id);
  expect(gather!.status).toBe("inbox");
  expect(new Date(gather!.retryAfter!).getTime()).toBeGreaterThan(Date.now());
  expect((await board.get(root.id))!.status).toBe("running");
});

test("a root already marked done before the fix is reopened, then settles", async () => {
  const { board, registry, ctx, def, orchestrator } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  await board.move(root.id, "done"); // what settleRoot used to do
  const moves: string[] = [];
  board.events.on("event", (e: { type: string; task?: TaskCard }) => {
    if (e.type === "task.moved" && e.task?.id === root.id) moves.push(e.task.status);
  });

  await orchestrator().sweep();

  expect(moves).toEqual(["running", "done"]);
  expect((await board.get(root.id))!.status).toBe("done");
});

test("two rate-limited entry steps of one run resume one at a time", async () => {
  const graph: PipelineGraph = {
    steps: [
      { id: "ai", name: "AI", agentId: "step-ai", transition: "all" },
      { id: "world", name: "World", agentId: "step-world", transition: "all" },
    ],
    edges: [],
  };
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(graph, { ai: ["429-past"], world: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  const o = orchestrator();

  await o.sweep(); // resumes one; the other waits for it
  await o.sweep();

  expect(fake.peak()).toBe(1);
  expect(fake.calls.slice(2).sort()).toEqual(["ai", "world"]);
  expect((await stepsOf(root.id)).every((s) => s.status === "done")).toBe(true);
  expect((await board.get(root.id))!.status).toBe("done");
});

test("a step deleted from the definition while waiting fails the run instead of waiting forever", async () => {
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  await ctx.pipelines.update(def.id, { name: def.name, description: def.description, graph: { steps: [LINEAR.steps[1]!], edges: [] } });

  await orchestrator().sweep();

  expect(fake.calls).toEqual(["gather"]);
  expect((await stepsOf(root.id)).map((s) => s.status)).toEqual(["failed"]);
  expect((await board.get(root.id))!.status).toBe("failed");
});

test("resumePipelineStep refuses a card that is not a waiting step", async () => {
  const { board, registry, ctx, def, stepsOf } = await setup(LINEAR, {});
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  const plain = await board.create({ title: "x", body: "", labels: [] });
  expect(await resumePipelineStep(board, registry, plain, ctx)).toBe(false);
  expect(await resumePipelineStep(board, registry, (await board.get(root.id))!, ctx)).toBe(false);
  const [done] = await stepsOf(root.id);
  expect(await resumePipelineStep(board, registry, done!, ctx)).toBe(false);
});

test("a started orchestrator resumes a step when its retryAfter comes due, with no board event", async () => {
  const { board, registry, ctx, def, fake, orchestrator } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  const [gather] = (await board.list()).filter((t) => t.pipelineRunId === root.id);
  await board.scheduleRetry(gather!.id, new Date(Date.now() + 300).toISOString());

  const o = orchestrator();
  o.start();
  try {
    const deadline = Date.now() + 3000;
    while ((await board.get(root.id))!.status !== "done" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect((await board.get(root.id))!.status).toBe("done");
    expect(fake.calls).toEqual(["gather", "gather", "write"]);
  } finally {
    o.stop();
  }
});

test("a due step waits while no harness is free, then runs once one is", async () => {
  const { board, registry, ctx, def, fake, orchestrator, stepsOf } = await setup(LINEAR, { gather: ["429-past"] });
  const root = await startPipelineRun(board, registry, def, undefined, "today", ctx);
  const harnesses = HarnessPool.from([{ id: "solo", tool: "claude-cli", label: "solo", enabled: true, maxConcurrent: 1 }]);
  (fake.executor as { harnessTool?: string }).harnessTool = "claude-cli";
  ctx.harnesses = harnesses;
  const busy = harnesses.acquire("claude-cli")!;

  await orchestrator().sweep();
  expect(fake.calls).toEqual(["gather"]);
  const [gather] = await stepsOf(root.id);
  expect(gather!.status).toBe("inbox"); // held, not failed
  expect((await board.get(root.id))!.status).toBe("running");

  harnesses.release(busy.id);
  await orchestrator().sweep();
  expect(fake.calls).toEqual(["gather", "gather", "write"]);
  expect((await board.get(root.id))!.status).toBe("done");
});
