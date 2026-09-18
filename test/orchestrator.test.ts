import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, finishResult, resolveHandoffAllowlist, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";

// agents/manifest.yaml's real tags: "intake" -> triager (readonly),
// "code" -> implementer (write). Using the real registry/router (not
// mocks) means these tests exercise real tag-overlap routing, not a
// fabricated decision.
async function setup(executors: Executor[], opts?: OrchestratorOptions) {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, opts);
  return { board, registry, orchestrator };
}

function fakeExecutor(tier: "readonly" | "write", run: Executor["run"]): Executor {
  return { id: `fake-${tier}`, canHandle: (agent: AgentDef) => agent.tier === tier, run };
}

test("sweep routes an unblocked task and runs it on the matching executor", async () => {
  const seen: TaskCard[] = [];
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => {
      seen.push(task);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" };
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("done");
  expect(updated!.routedTo).toBe("triager");
  expect(seen.map((t) => t.id)).toEqual([task.id]);
});

test("a write-tier task is handed off, not run — wissel never spawns execution itself", async () => {
  const { board, orchestrator } = await setup([
    // A write-tier executor here would prove the bug: the orchestrator
    // must never reach for it.
    fakeExecutor("write", async () => {
      throw new Error("orchestrator must not execute write-tier work itself");
    }),
  ]);

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("dispatched");
  expect(updated!.routedTo).toBe("implementer");
});

test("with executeWriteTier on, a write-tier task runs on a registered write executor instead of being handed off", async () => {
  const seen: TaskCard[] = [];
  const { board, orchestrator } = await setup(
    [
      fakeExecutor("write", async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "opened a PR" };
      }),
    ],
    { executeWriteTier: true },
  );

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  // Success still gates on review, not done — running it locally doesn't
  // relax the human-look-at-the-diff policy.
  expect(updated!.status).toBe("review");
  expect(updated!.routedTo).toBe("implementer");
  expect(seen.map((t) => t.id)).toEqual([task.id]);
});

test("executeWriteTier on with no write executor registered errors out instead of silently handing off", async () => {
  const { board, orchestrator } = await setup([], { executeWriteTier: true });

  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });
  await orchestrator.sweep();

  const updated = await board.get(task.id);
  expect(updated!.status).toBe("inbox");
  expect(updated!.routedTo).toBeUndefined();
});

test("finishResult moves a successful write-tier report to review, not done", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "implementer", ok: true, summary: "opened a PR" });

  expect((await board.get(task.id))!.status).toBe("review");
});

test("finishResult moves a successful readonly report straight to done", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "triage", body: "", labels: ["intake"], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "triager", ok: true, summary: "triaged" });

  expect((await board.get(task.id))!.status).toBe("done");
});

test("finishResult moves any failed report to failed", async () => {
  const { board, registry } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await finishResult(board, registry, { taskId: task.id, agentId: "implementer", ok: false, summary: "broke" });

  expect((await board.get(task.id))!.status).toBe("failed");
});

test("a failed run ends in failed", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: false, summary: "broke" })),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("failed");
});

test("an executor throwing becomes a failed result, not a crash", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async () => {
      throw new Error("boom");
    }),
  ]);

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("failed");
});

test("zero tag overlap stops the task before dispatch — never a silent guess", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async () => {
      throw new Error("should never run — nothing matched confidently");
    }),
  ]);

  const task = await board.create({ title: "??", body: "", labels: ["no-such-label"], repo: "r" });
  await orchestrator.sweep();

  const after = await board.get(task.id);
  expect(after!.status).toBe("no-match");
  expect(after!.routedTo).toBeUndefined();
});

test("a task blocked on an unfinished dependency is left alone until it's done", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  const dep = await board.create({ title: "design", body: "", labels: ["intake"], repo: "r" });
  const blocked = await board.create({ title: "build", body: "", labels: ["code"], repo: "r", dependsOn: [dep.id] });

  await orchestrator.sweep();
  expect((await board.get(dep.id))!.status).toBe("done"); // unblocked, processed
  const stillBlocked = await board.get(blocked.id);
  expect(stillBlocked!.status).toBe("inbox"); // dependency wasn't done yet at sweep time
  expect(stillBlocked!.routedTo).toBeUndefined();

  await orchestrator.sweep();
  expect((await board.get(blocked.id))!.status).toBe("dispatched"); // now unblocked, write-tier handed off
});

test("a dangling dependsOn id blocks forever rather than being treated as satisfied", async () => {
  const { board, orchestrator } = await setup([fakeExecutor("readonly", async () => {
    throw new Error("should never run");
  })]);

  const task = await board.create({ title: "x", body: "", labels: ["intake"], repo: "r", dependsOn: ["no-such-task"] });
  await orchestrator.sweep();

  expect((await board.get(task.id))!.status).toBe("inbox");
});

test("no matching executor leaves the task unrouted instead of stranding it", async () => {
  const { board, orchestrator } = await setup([]); // no executors at all
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });

  await orchestrator.sweep();

  const after = await board.get(task.id);
  expect(after!.status).toBe("inbox");
  expect(after!.routedTo).toBeUndefined();
});

test("concurrent sweeps don't double-run the same task", async () => {
  let runs = 0;
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
    }),
  ]);

  await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await Promise.all([orchestrator.sweep(), orchestrator.sweep(), orchestrator.sweep()]);

  expect(runs).toBe(1);
});

test("a follow-up task is restricted to its parent agent's declared handoffs, excluding a would-otherwise-win candidate", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  // Parent routes to triager (handoffs: [planner] in the real manifest).
  const parent = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });
  await orchestrator.sweep();
  expect((await board.get(parent.id))!.routedTo).toBe("triager");

  // "ci" is a perfect tag match for fixer, which would win unrestricted —
  // but fixer isn't in triager's handoffs, only planner is.
  const child = await board.create({
    title: "follow-up", body: "", labels: ["ci"], repo: "r", parentTaskId: parent.id,
  });
  await orchestrator.sweep();

  const after = await board.get(child.id);
  expect(after!.status).toBe("no-match");
  expect(after!.routedTo).toBeUndefined();
  const decision = await board.getDecision(child.id);
  expect(decision!.reason).toContain("restricted to declared handoffs: planner");
  expect(decision!.candidates.map((c) => c.agentId)).toEqual(["planner"]);
});

test("a follow-up under a parent whose agent never declared handoffs routes unrestricted", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);

  // reviewer never declares `handoffs` in the real manifest.
  const parent = await board.create({ title: "review this", body: "", labels: ["review"], repo: "r" });
  await orchestrator.sweep();
  expect((await board.get(parent.id))!.routedTo).toBe("reviewer");

  const child = await board.create({
    title: "follow-up", body: "", labels: ["ci"], repo: "r", parentTaskId: parent.id,
  });
  await orchestrator.sweep();

  expect((await board.get(child.id))!.routedTo).toBe("fixer");
});

test("resolveHandoffAllowlist", async () => {
  const board = new SqliteBoard();
  const registry = Registry.from([
    { id: "a", name: "A", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", handoffs: ["b"], inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
    { id: "no-graph", name: "No graph", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
    { id: "dead-end", name: "Dead end", kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor: "readonly", handoffs: [], inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model: "m", estUsdPerTask: 0.01 } },
  ]);

  expect(await resolveHandoffAllowlist(board, registry, undefined)).toBeUndefined();

  const unrouted = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  expect(await resolveHandoffAllowlist(board, registry, unrouted.id)).toBeUndefined();
  expect(await resolveHandoffAllowlist(board, registry, "no-such-task")).toBeUndefined();

  const routedToA = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToA.id, matchedTags: [], candidates: [], selected: "a", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  expect(await resolveHandoffAllowlist(board, registry, routedToA.id)).toEqual(["b"]);

  const routedToNoGraph = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToNoGraph.id, matchedTags: [], candidates: [], selected: "no-graph", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  expect(await resolveHandoffAllowlist(board, registry, routedToNoGraph.id)).toBeUndefined();

  const routedToDeadEnd = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.recordDecision({
    taskId: routedToDeadEnd.id, matchedTags: [], candidates: [], selected: "dead-end", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });
  // [] is a real, deliberate restriction — must come back as [], not undefined.
  expect(await resolveHandoffAllowlist(board, registry, routedToDeadEnd.id)).toEqual([]);
});

test("start() reacts to a task created after it begins watching", async () => {
  const { board, orchestrator } = await setup([
    fakeExecutor("readonly", async (task, agent) => ({ taskId: task.id, agentId: agent.id, ok: true, summary: "ok" })),
  ]);
  orchestrator.start();

  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });

  const deadline = Date.now() + 1000;
  let status: TaskCard["status"] = "inbox";
  while (Date.now() < deadline) {
    status = (await board.get(task.id))!.status;
    if (status !== "inbox") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(status).toBe("done");
});

test("runNow executes a write-tier task immediately even without executeWriteTier on — a human's per-task decision overrides the blanket gate", async () => {
  const { board, orchestrator } = await setup([]); // no auto executors, no executeWriteTier
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await orchestrator.runNow(task.id, [
    fakeExecutor("write", async (t, agent) => ({ taskId: t.id, agentId: agent.id, ok: true, summary: "opened a PR" })),
  ]);
  // runNow returns once the run is in flight, not once it's done —
  // wait for the background process() to land.
  await waitForStatus(board, task.id, "review");

  const updated = await board.get(task.id);
  expect(updated!.routedTo).toBe("implementer");
  expect(updated!.status).toBe("review");
});

test("runNow throws synchronously for an unknown task, before touching anything", async () => {
  const { orchestrator } = await setup([]);
  await expect(orchestrator.runNow("no-such-task", [])).rejects.toThrow("task not found");
});

test("runNow throws if a run for that task is already in flight", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const { board, orchestrator } = await setup([]);
  const task = await board.create({ title: "build the thing", body: "", labels: ["code"], repo: "r" });

  await orchestrator.runNow(task.id, [
    fakeExecutor("write", async (t, agent) => {
      await blocked;
      return { taskId: t.id, agentId: agent.id, ok: true, summary: "ok" };
    }),
  ]);

  await expect(orchestrator.runNow(task.id, [])).rejects.toThrow("already running");
  release();
  await waitForStatus(board, task.id, "review");
});

async function waitForStatus(board: SqliteBoard, taskId: string, status: TaskCard["status"]): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((await board.get(taskId))!.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} never reached status ${status}`);
}
