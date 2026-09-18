import { expect, test } from "bun:test";
import { RuleStrategy, Router } from "../src/core/router.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

function agent(overrides: Partial<AgentDef> & Pick<AgentDef, "id" | "tier" | "tags">): AgentDef {
  return {
    name: overrides.id,
    description: "",
    whenToUse: "",
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: [],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
    ...overrides,
  };
}

const agents: AgentDef[] = [
  agent({ id: "a", tier: "readonly", tags: ["security", "node"] }),
  agent({ id: "b", tier: "write", tags: ["docs"] }),
];

const task: TaskCard = {
  id: "t1", title: "", body: "", labels: ["security", "node", "typescript"],
  repo: "x", status: "ready",
};

test("ranks by tag overlap and returns every candidate", async () => {
  const ranked = await new RuleStrategy().rank(task, agents);
  expect(ranked.length).toBe(2);
  expect(ranked[0]!.agentId).toBe("a");
  expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
});

test("a clear top score is a confident, dispatchable decision", async () => {
  const router = new Router(Registry.from(agents));
  const decision = await router.route(task);
  expect(decision.confident).toBe(true);
  expect(decision.selected).toBe("a");
  expect(decision.candidates.length).toBe(2);
});

test("zero tag overlap never auto-dispatches", async () => {
  const router = new Router(Registry.from(agents));
  const decision = await router.route({ ...task, labels: ["nothing-anyone-declares"] });
  expect(decision.confident).toBe(false);
  expect(decision.selected).toBeNull();
  expect(decision.candidates.length).toBe(2); // still visible, just not picked
});

test("a tie for first place never auto-dispatches", async () => {
  const tied = [
    agent({ id: "a", tier: "readonly", tags: ["ci"] }),
    agent({ id: "b", tier: "readonly", tags: ["ci"] }),
  ];
  const router = new Router(Registry.from(tied));
  const decision = await router.route({ ...task, labels: ["ci"] });
  expect(decision.confident).toBe(false);
  expect(decision.selected).toBeNull();
  expect(decision.reason).toContain("tie");
});

test("no candidates at all is a refusal, not a throw", async () => {
  const router = new Router(Registry.from([]));
  const decision = await router.route(task);
  expect(decision.confident).toBe(false);
  expect(decision.selected).toBeNull();
  expect(decision.candidates).toEqual([]);
});
