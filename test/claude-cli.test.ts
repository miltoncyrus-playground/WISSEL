import { expect, test } from "bun:test";
import { runClaude, runViaBun, type CommandResult, type CommandRunner } from "../src/executors/claude-cli.ts";
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
  outputContractFormat: "review-verdict",
};

const plainAgent: AgentDef = {
  ...reviewerAgent,
  id: "triager",
  name: "Triager",
  outputContract: undefined,
};

const plannerAgent: AgentDef = {
  ...reviewerAgent,
  id: "planner",
  name: "Planner",
  outputContract: "Your final message must end with a ```subtask-plan``` block.",
  outputContractFormat: "subtask-plan",
};

const pipelineStepAgent: AgentDef = {
  ...reviewerAgent,
  id: "implementer",
  name: "Implementer",
  outputContract: "Your final message must end with a ```pipeline-handoff``` block.",
  outputContractFormat: "pipeline-handoff",
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

test("a planner run with a valid subtask-plan block stays ok: true and carries subtaskPlan", async () => {
  const raw = [
    "Here's the decomposition.",
    "",
    "```subtask-plan",
    '[{"title": "Add types", "body": "Add the interface.", "labels": ["code"]}]',
    "```",
  ].join("\n");
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: plannerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.subtaskPlan).toEqual([{ title: "Add types", body: "Add the interface.", labels: ["code"] }]);
});

test("a planner run missing the subtask-plan block becomes ok: false with a contract-violation summary", async () => {
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Here's my plan in prose, no block." }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: plannerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
  expect(result.summary).toContain("Here's my plan in prose, no block.");
  expect(result.subtaskPlan).toBeUndefined();
});

test("a planner run with a malformed subtask-plan block becomes ok: false, never silently spawns a partial plan", async () => {
  const raw = ["```subtask-plan", '[{"title": "x", "body": "y"', "```"].join("\n");
  const result = await runClaude({
    runner: stub({
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }),
      stderr: "",
      exitCode: 0,
    }),
    task,
    agent: plannerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
  expect(result.subtaskPlan).toBeUndefined();
});

test("a pipeline step run with a valid choose-shaped pipeline-handoff block stays ok: true and carries pipelineHandoff", async () => {
  const raw = ["Implemented the change.", "", "```pipeline-handoff", '{"next": "reviewer", "data": {"files": ["a.ts"]}, "note": "done"}', "```"].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }), stderr: "", exitCode: 0 }),
    task,
    agent: pipelineStepAgent,
    permissionMode: "acceptEdits",
  });
  expect(result.ok).toBe(true);
  expect(result.pipelineHandoff).toEqual({ next: "reviewer", data: { files: ["a.ts"] }, note: "done" });
});

test("a pipeline step run with a valid all/fan-out-shaped pipeline-handoff block (no next) stays ok: true", async () => {
  const raw = ["```pipeline-handoff", '{"note": "fanning out"}', "```"].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }), stderr: "", exitCode: 0 }),
    task,
    agent: pipelineStepAgent,
    permissionMode: "acceptEdits",
  });
  expect(result.ok).toBe(true);
  expect(result.pipelineHandoff).toEqual({ note: "fanning out" });
});

test("a pipeline step run missing the pipeline-handoff block becomes ok: false with a contract-violation summary", async () => {
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Just did the work, no block." }), stderr: "", exitCode: 0 }),
    task,
    agent: pipelineStepAgent,
    permissionMode: "acceptEdits",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
  expect(result.pipelineHandoff).toBeUndefined();
});

test("a pipeline step run with a malformed pipeline-handoff block becomes ok: false, never a guessed handoff", async () => {
  const raw = ["```pipeline-handoff", '{"next": "reviewer"', "```"].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }), stderr: "", exitCode: 0 }),
    task,
    agent: pipelineStepAgent,
    permissionMode: "acceptEdits",
  });
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("violated its output contract");
  expect(result.pipelineHandoff).toBeUndefined();
});

test("an agent with outputContractFormat: review-verdict is completely unaffected by the pipeline-handoff addition", async () => {
  const raw = ['```review-verdict', '{"verdict": "approve", "feedback": "fine"}', '```'].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: raw }), stderr: "", exitCode: 0 }),
    task,
    agent: reviewerAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.verdict).toBe("approve");
  expect(result.pipelineHandoff).toBeUndefined();
});

// --- Live task output streaming (docs/SDD-live-task-output.md §3.1) ------

test("omits stream-json/--include-partial-messages/--verbose entirely when onChunk isn't given — the default path is untouched", async () => {
  let seenCmd: string[] = [];
  await runClaude({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(seenCmd[seenCmd.indexOf("--output-format") + 1]).toBe("json");
  expect(seenCmd).not.toContain("--include-partial-messages");
  expect(seenCmd).not.toContain("--verbose");
  expect(seenCmd).not.toContain("stream-json");
});

test("onChunk switches --output-format to stream-json and adds --include-partial-messages --verbose", async () => {
  let seenCmd: string[] = [];
  await runClaude({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: plainAgent,
    permissionMode: "plan",
    onChunk: () => {},
  });
  expect(seenCmd[seenCmd.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(seenCmd).toContain("--include-partial-messages");
  expect(seenCmd).toContain("--verbose");
});

test("onChunk fires per parsed JSONL line, in order, as a streaming runner delivers them across ticks, and the final TaskResult matches the equivalent non-streaming call", async () => {
  const chunks = [
    { type: "system", subtype: "init" },
    { type: "stream_event", event: { type: "message_start" } },
    { type: "result", subtype: "success", is_error: false, result: "pong", total_cost_usd: 0.05 },
  ];
  const seen: unknown[] = [];
  const streamingRunner: CommandRunner = async (_cmd, opts) => {
    for (const c of chunks) {
      await Promise.resolve(); // simulates a real chunk arriving on its own tick
      opts.onChunk?.(c);
    }
    return { stdout: chunks.map((c) => JSON.stringify(c)).join("\n") + "\n", stderr: "", exitCode: 0 };
  };

  const result = await runClaude({
    runner: streamingRunner,
    task,
    agent: plainAgent,
    permissionMode: "plan",
    onChunk: (line) => seen.push(line),
  });

  expect(seen).toEqual(chunks);
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("pong");
  expect(result.actualCost).toBe(0.05);

  const nonStreaming = await runClaude({
    runner: stub({ stdout: JSON.stringify(chunks[2]), stderr: "", exitCode: 0 }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result).toEqual(nonStreaming);
});

test("parses only the final JSONL line as the TaskResult when stdout is multi-line streamed output — earlier lines are never mistaken for the result", async () => {
  const raw =
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "streamed pong" }),
    ].join("\n") + "\n";
  const result = await runClaude({
    runner: stub({ stdout: raw, stderr: "", exitCode: 0 }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.summary).toBe("streamed pong");
});

test("runViaBun streams onChunk per JSONL line, in order, across multiple real reads, while stdout still accumulates the exact full text", async () => {
  const seen: unknown[] = [];
  const result = await runViaBun(
    ["sh", "-c", "printf '%s\\n' '{\"n\":1}'; sleep 0.05; printf '%s\\n' '{\"n\":2}'; printf '%s\\n' 'not json'; printf '%s\\n' '{\"n\":3}'"],
    { cwd: "/tmp", onChunk: (line) => seen.push(line) },
  );
  expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  expect(result.stdout).toBe('{"n":1}\n{"n":2}\nnot json\n{"n":3}\n');
  expect(result.exitCode).toBe(0);
});

test("runViaBun without onChunk behaves exactly as before — full buffered stdout, no callback invoked, no crash on the missing option", async () => {
  const result = await runViaBun(["sh", "-c", "printf 'hello\\n'"], { cwd: "/tmp" });
  expect(result.stdout).toBe("hello\n");
  expect(result.exitCode).toBe(0);
});
