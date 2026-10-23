import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, isChainCard, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import type { AgentDef, Executor } from "../src/core/types.ts";

// WISSEL_AUTO_CHAIN: a chain-only sweep, docs/SDD-auto-chain.md.

async function setup(executors: Executor[], opts?: OrchestratorOptions) {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, opts);
  return { board, orchestrator };
}

function recorder(seen: string[]): Executor {
  return {
    id: "fake-readonly",
    harnessTool: "claude-cli",
    canHandle: (agent: AgentDef) => agent.tier === "readonly",
    run: async (task, agent) => {
      seen.push(task.id);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
    },
  };
}

test("isChainCard: a card in a review lineage, never a pipeline card, never a fresh one", () => {
  expect(isChainCard({ reviewLineageId: "L1" })).toBe(true);
  expect(isChainCard({})).toBe(false);
  expect(isChainCard({ reviewLineageId: "L1", pipelineId: "p" })).toBe(false);
});

test("chainOnly: the sweep runs a card in a review lineage and leaves a fresh card in the inbox", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup([recorder(seen)], { chainOnly: true });
  const fresh = await board.create({ title: "fresh", body: "", labels: ["intake"], repo: "r" });
  const chained = await board.create({ title: "rework", body: "", labels: ["intake"], repo: "r", reviewLineageId: "L1", pushbackCount: 1 });

  await orchestrator.sweep();

  expect(seen).toEqual([chained.id]);
  expect((await board.get(chained.id))?.status).toBe("done");
  const waiting = await board.get(fresh.id);
  expect(waiting?.status).toBe("inbox");
  expect(waiting?.routedTo).toBeUndefined();
});

test("without chainOnly the same sweep runs both cards, as before", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup([recorder(seen)]);
  const fresh = await board.create({ title: "fresh", body: "", labels: ["intake"], repo: "r" });
  const chained = await board.create({ title: "rework", body: "", labels: ["intake"], repo: "r", reviewLineageId: "L1" });
  await orchestrator.sweep();
  expect(seen.sort()).toEqual([fresh.id, chained.id].sort());
});

test("chainOnly still honours the other sweep gates: archived, blocked by a dependency, and the concurrency cap", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup([recorder(seen)], { chainOnly: true, maxConcurrentTasks: 1 });
  const dep = await board.create({ title: "dep", body: "", labels: ["intake"], repo: "r" });
  const blocked = await board.create({ title: "blocked", body: "", labels: ["intake"], repo: "r", reviewLineageId: "L2", dependsOn: [dep.id] });
  const archived = await board.create({ title: "archived", body: "", labels: ["intake"], repo: "r", reviewLineageId: "L3" });
  await board.move(archived.id, "done");
  await board.archive(archived.id);

  await orchestrator.sweep();

  // `dep` is fresh (not chain), so it never runs, so `blocked` stays blocked.
  expect(seen).toEqual([]);
  expect((await board.get(blocked.id))?.status).toBe("inbox");
});
