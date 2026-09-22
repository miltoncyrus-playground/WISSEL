import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { wireAutoIntegrator, resolveHandoffAllowlist } from "../src/core/orchestrator.ts";
import type { AgentDef } from "../src/core/types.ts";

async function settle(): Promise<void> {
  // wireAutoIntegrator's listener runs its async work fire-and-forget
  // (see its own doc comment on why: board.events emitters are
  // synchronous, the spawn logic isn't) — one microtask/macrotask tick
  // is enough for a same-process, in-memory SQLite board.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("spawns exactly one integrator card once every sibling under a parent is done, not one per sibling", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  wireAutoIntegrator(board, registry);

  const parent = await board.create({ title: "Feature X", body: "", labels: ["planning"], repo: "/repo" });
  const c1 = await board.create({ title: "Subtask 1", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });
  const c2 = await board.create({ title: "Subtask 2", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });
  const c3 = await board.create({ title: "Subtask 3", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });

  const siblingsOf = async () => (await board.list()).filter((t) => t.parentTaskId === parent.id);
  const integratorsOf = async () => (await siblingsOf()).filter((t) => t.labels.includes("integration"));

  await board.move(c1.id, "done");
  await settle();
  expect((await integratorsOf()).length).toBe(0);

  await board.move(c2.id, "done");
  await settle();
  expect((await integratorsOf()).length).toBe(0); // c3 still not done

  await board.move(c3.id, "done");
  await settle();
  const integrators = await integratorsOf();
  expect(integrators.length).toBe(1);
  expect(integrators[0]!.title).toBe("Integrate: Feature X");
  expect(integrators[0]!.repo).toBe("/repo");
  expect(integrators[0]!.parentTaskId).toBe(parent.id);
  expect(integrators[0]!.body).toContain(c1.id);
  expect(integrators[0]!.body).toContain(c2.id);
  expect(integrators[0]!.body).toContain(c3.id);

  // A duplicate/racy "done" event for an already-done sibling must not
  // spawn a second integrator card.
  await board.move(c1.id, "done");
  await settle();
  expect((await integratorsOf()).length).toBe(1);
});

// Real bug, found live the first time the sweep loop actually ran for
// real: parentTaskId means two different things depending on which
// task carries it (subtask-decomposition vs. review-lineage chaining —
// see maybeSpawnIntegrator's own doc comment). A reviewer task reaches
// `done` on every single review pass, approve or reject — this must
// never be mistaken for "every subtask under a parent is done."
test("a reviewer task reaching done never spawns an integrator card, even though it has a parentTaskId", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  wireAutoIntegrator(board, registry);

  const implementer = await board.create({ title: "Do the thing", body: "", labels: ["code"], repo: "/repo" });
  const reviewer = await board.create({
    title: `Review: ${implementer.title}`, body: "", labels: ["review"], repo: "/repo",
    parentTaskId: implementer.id, pushbackCount: 0,
  });

  await board.move(reviewer.id, "done");
  await settle();

  const all = await board.list();
  expect(all.filter((t) => t.labels.includes("integration")).length).toBe(0);
});

// Same root cause, one level deeper: a pushback re-attempt's
// parentTaskId points at the reviewer that rejected it, not at a
// planner — reaching done (e.g. approved on a later round, or merged)
// must not spawn an integrator scoped to that reviewer either.
test("a pushback re-attempt reaching done never spawns an integrator card", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  wireAutoIntegrator(board, registry);

  const implementer = await board.create({ title: "Do the thing", body: "", labels: ["code"], repo: "/repo" });
  const reviewer = await board.create({
    title: `Review: ${implementer.title}`, body: "", labels: ["review"], repo: "/repo",
    parentTaskId: implementer.id, pushbackCount: 0,
  });
  const pushback = await board.create({
    title: implementer.title, body: "", labels: ["code"], repo: "/repo",
    parentTaskId: reviewer.id, pushbackCount: 1,
  });

  await board.move(pushback.id, "done");
  await settle();

  const all = await board.list();
  expect(all.filter((t) => t.labels.includes("integration")).length).toBe(0);
});

test("the integrator task itself reaching done does not spawn a second integrator card", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  wireAutoIntegrator(board, registry);

  const parent = await board.create({ title: "Feature X", body: "", labels: ["planning"], repo: "/repo" });
  const c1 = await board.create({ title: "Subtask 1", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });
  await board.move(c1.id, "done");
  await settle();

  const integratorTask = (await board.list()).find((t) => t.labels.includes("integration"))!;
  expect(integratorTask).toBeDefined();

  await board.move(integratorTask.id, "done");
  await settle();

  const integrators = (await board.list()).filter((t) => t.parentTaskId === parent.id && t.labels.includes("integration"));
  expect(integrators.length).toBe(1);
});

test("a task with no parentTaskId reaching done spawns nothing", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  wireAutoIntegrator(board, registry);

  const task = await board.create({ title: "standalone", body: "", labels: ["code"], repo: "/repo" });
  await board.move(task.id, "done");
  await settle();

  const all = await board.list();
  expect(all.filter((t) => t.labels.includes("integration")).length).toBe(0);
});

test("no integrator agent registered — spawns nothing, doesn't throw", async () => {
  const board = new SqliteBoard();
  const noIntegrator: AgentDef = {
    id: "implementer", name: "Implementer", kind: "agent", tier: "write", description: "d", whenToUse: "w",
    tags: ["code"], executor: "handoff", inputs: [], outputs: [], trustLevel: "high", toolAccess: [],
    costProfile: { model: "m", estUsdPerTask: 0.1 },
  };
  const registry = Registry.from([noIntegrator]);
  wireAutoIntegrator(board, registry);

  const parent = await board.create({ title: "Feature X", body: "", labels: [], repo: "/repo" });
  const c1 = await board.create({ title: "Subtask 1", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });
  await board.move(c1.id, "done");
  await settle();

  const all = await board.list();
  expect(all.filter((t) => t.labels.includes("integration")).length).toBe(0);
});

test("the auto-created integrator card actually routes to the integrator agent with confidence, honoring planner's handoffs restriction", async () => {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const router = new Router(registry);
  wireAutoIntegrator(board, registry);

  const parent = await board.create({ title: "Feature X", body: "", labels: ["planning"], repo: "/repo" });
  // parentTaskId restriction only kicks in once the parent is actually
  // routed (see resolveHandoffAllowlist) — real pipelines always have
  // this by the time subtasks exist, so this reproduces that exactly:
  // without planner listed in `integrator`'s own... no — without
  // "integrator" in *planner's* declared handoffs, this would land on
  // no-match regardless of tag overlap (see agents/manifest.yaml's
  // planner.handoffs comment).
  await board.recordDecision({
    taskId: parent.id, matchedTags: [], candidates: [], selected: "planner", confident: true,
    reason: "r", strategy: "manual", decidedAt: new Date().toISOString(),
  });

  const c1 = await board.create({ title: "Subtask 1", body: "", labels: ["code"], repo: "/repo", parentTaskId: parent.id });
  await board.move(c1.id, "done");
  await settle();

  const integratorTask = (await board.list()).find((t) => t.labels.includes("integration"))!;
  expect(integratorTask).toBeDefined();

  const allowIds = await resolveHandoffAllowlist(board, registry, integratorTask.parentTaskId);
  const decision = await router.route(integratorTask, allowIds);
  expect(decision.confident).toBe(true);
  expect(decision.selected).toBe("integrator");
});
