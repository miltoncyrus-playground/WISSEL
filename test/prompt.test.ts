import { expect, test } from "bun:test";
import { buildAgentPrompt } from "../src/core/prompt.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "reviewer",
  name: "Reviewer",
  kind: "agent",
  tier: "readonly",
  description: "Reviews a diff against repo conventions and prior decisions.",
  whenToUse: "A branch or PR exists and needs review before merge.",
  tags: ["review"],
  executor: "readonly",
  inputs: ["diff"],
  outputs: ["approval-decision"],
  trustLevel: "medium",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.12 },
};

const task: TaskCard = {
  id: "t1",
  title: "Review this diff",
  body: "Check it against conventions.",
  labels: ["review"],
  repo: "/tmp",
  status: "ready",
};

test("omits any contract framing when outputContract is undefined", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("review-verdict");
});

test("appends outputContract verbatim to the end of the prompt when present", () => {
  const contract = 'End with a ```review-verdict``` block containing {"verdict": ..., "feedback": ...}.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract });
  expect(prompt.endsWith(contract)).toBe(true);
  // Still carries the normal task framing ahead of the contract.
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
  expect(prompt.indexOf(task.body)).toBeLessThan(prompt.indexOf(contract));
});
