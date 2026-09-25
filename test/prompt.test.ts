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

// Memory (docs/SDD-memory-curator.md §9) — buildAgentPrompt itself never
// touches the filesystem; the caller (runClaude/runCodex) reads
// memory/lessons.md and passes its content through this parameter.

test("omits the memory section entirely when no memory content is given — first run, nothing to regress", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("Lessons learned from prior sessions");
});

test("omits the memory section for an explicitly empty string too, not just undefined", () => {
  const prompt = buildAgentPrompt(task, agent, "");
  expect(prompt).not.toContain("Lessons learned from prior sessions");
});

test("includes prior-session memory verbatim when given, ahead of any output/verification contract", () => {
  const memory = "- Always run `bun test` before reporting done.\n- Never touch node_modules directly.";
  const contract = 'End with a ```review-verdict``` block.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract }, memory);

  expect(prompt).toContain("Lessons learned from prior sessions:");
  expect(prompt).toContain(memory);
  expect(prompt.indexOf(memory)).toBeLessThan(prompt.indexOf(contract));
  // Still carries the normal task framing too.
  expect(prompt).toContain(task.title);
  expect(prompt).toContain(task.body);
});

// Regression: readonly agents (reviewer, planner, repo-briefer) run under
// --permission-mode plan, which has no ExitPlanMode/AskUserQuestion tool
// wired up in headless `claude -p` mode. Confirmed live 2026-09-24/25 —
// the model periodically tries to call ExitPlanMode anyway, fails, and
// writes a plan file instead of the required output-contract block,
// which the parser then correctly fails closed on (real paid runs
// wasted). buildAgentPrompt's planMode option is the fix.

test("omits the plan-mode note when planMode is not requested", () => {
  const prompt = buildAgentPrompt(task, agent);
  expect(prompt).not.toContain("ExitPlanMode");
});

test("omits the plan-mode note when planMode is explicitly false", () => {
  const prompt = buildAgentPrompt(task, agent, undefined, { planMode: false });
  expect(prompt).not.toContain("ExitPlanMode");
});

test("appends an explicit ExitPlanMode-unavailable note when planMode is requested", () => {
  const prompt = buildAgentPrompt(task, agent, undefined, { planMode: true });
  expect(prompt).toContain("ExitPlanMode");
  expect(prompt).toContain("no plan-approval step available");
});

test("plan-mode note comes after the output contract, so it's the last thing the model reads", () => {
  const contract = 'End with a ```review-verdict``` block.';
  const prompt = buildAgentPrompt(task, { ...agent, outputContract: contract }, undefined, { planMode: true });
  expect(prompt.indexOf(contract)).toBeLessThan(prompt.indexOf("ExitPlanMode"));
  expect(prompt.trim().endsWith("per the output contract above.")).toBe(true);
});
