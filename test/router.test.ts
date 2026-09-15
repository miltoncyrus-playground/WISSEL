import { expect, test } from "bun:test";
import { RuleStrategy } from "../src/core/router.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agents: AgentDef[] = [
  { id: "a", name: "A", tier: "readonly", description: "", whenToUse: "", tags: ["security", "node"], executor: "readonly" },
  { id: "b", name: "B", tier: "write", description: "", whenToUse: "", tags: ["docs"], executor: "worktree-claude" },
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
