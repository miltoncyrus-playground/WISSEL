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

test("a 429 session-limit failure surfaces retryAfter and the real actualCost, instead of a plain fail()", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "You've hit your session limit · resets 3:10pm (UTC)",
        total_cost_usd: 2.37,
        api_error_status: 429,
      }),
      stderr: "",
      exitCode: 1,
    }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.actualCost).toBe(2.37);
  expect(result.retryAfter).toBeDefined();
  expect(new Date(result.retryAfter!).toISOString().endsWith("Z")).toBe(true);
});

test("a non-429 non-zero exit with valid JSON still captures actualCost, but never sets retryAfter", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "something else broke", total_cost_usd: 0.42 }),
      stderr: "",
      exitCode: 1,
    }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.actualCost).toBe(0.42);
  expect(result.retryAfter).toBeUndefined();
});

test("a 429 whose result text has no parseable reset time falls back to a plain failure, not a guessed retry", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "session limit hit", api_error_status: 429, total_cost_usd: 0.1 }),
      stderr: "",
      exitCode: 1,
    }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.retryAfter).toBeUndefined();
  expect(result.actualCost).toBe(0.1);
  expect(result.summary).toContain("claude exited 1");
});

test("a non-zero exit with unparseable stdout falls back to raw stderr/stdout exactly like before, no actualCost", async () => {
  const result = await runClaude({
    runner: stub({ stdout: "", stderr: "command not found: claude", exitCode: 127 }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toBe("claude exited 127: command not found: claude");
  expect(result.actualCost).toBeUndefined();
  expect(result.retryAfter).toBeUndefined();
});

test("allowedTools, when given, is passed through as --allowedTools", async () => {
  let seenCmd: string[] = [];
  await runClaude({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: plainAgent,
    permissionMode: "acceptEdits",
    allowedTools: ["Bash(bun test:*)", "Bash(bun run typecheck:*)"],
  });
  const idx = seenCmd.indexOf("--allowedTools");
  expect(idx).toBeGreaterThan(-1);
  expect(seenCmd.slice(idx + 1, idx + 3)).toEqual(["Bash(bun test:*)", "Bash(bun run typecheck:*)"]);
});

test("allowedTools omitted (the default) never adds the flag at all", async () => {
  let seenCmd: string[] = [];
  await runClaude({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: plainAgent,
    permissionMode: "acceptEdits",
  });
  expect(seenCmd).not.toContain("--allowedTools");
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
