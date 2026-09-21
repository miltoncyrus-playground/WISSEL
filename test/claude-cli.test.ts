import { expect, test } from "bun:test";
import { runClaude, type CommandResult } from "../src/executors/claude-cli.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const reviewerAgent: AgentDef = {
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
  outputContract: "Your final message must end with a ```review-verdict``` block.",
};

const plainAgent: AgentDef = {
  ...reviewerAgent,
  id: "triager",
  name: "Triager",
  outputContract: undefined,
};

const task: TaskCard = {
  id: "t1",
  title: "Review this diff",
  body: "Check it against conventions.",
  labels: ["review"],
  repo: "/tmp",
  status: "ready",
};

function stub(result: CommandResult) {
  return async () => result;
}

test("a reviewer run with a valid review-verdict block stays ok: true", async () => {
  const raw = ['Reviewed the diff.', '', '```review-verdict', '{"verdict": "approve", "feedback": "Looks good."}', '```'].join("\n");
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: reviewerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe(raw);
});

test("a reviewer run missing the review-verdict block becomes ok: false with a contract-violation summary", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Looks fine to me, approved." }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: reviewerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
  expect(result.summary).toContain("Looks fine to me, approved.");
});

test("a reviewer run with a malformed review-verdict block becomes ok: false, never silently approved", async () => {
  const raw = ['```review-verdict', '{"verdict": "approve"', '```'].join("\n");
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: reviewerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
});

test("a reviewer run that already failed (is_error) is not re-labeled as a contract violation", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "claude crashed" }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: reviewerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toBe("claude crashed");
  expect(result.summary).not.toContain("violated its output contract");
});

test("an agent without outputContract is never contract-checked, even with prose-only output", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Just plain prose, no fenced block anywhere." }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("Just plain prose, no fenced block anywhere.");
});
