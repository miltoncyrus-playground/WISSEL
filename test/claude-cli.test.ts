import { expect, test } from "bun:test";
import { runClaude, runViaBun, type CommandResult, type CommandRunner } from "../src/executors/claude-cli.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import type { AgentDef, McpServer, TaskCard } from "../src/core/types.ts";

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

// --- MCP grants (docs/SDD-mcp-orchestration.md §3.2/§3.4) ---------------

function mcpServer(overrides: Partial<McpServer> & Pick<McpServer, "id">): McpServer {
  return {
    label: overrides.id,
    transport: { kind: "stdio", command: "/usr/local/bin/example-mcp-server", args: [] },
    tools: [],
    enabled: true,
    ...overrides,
  };
}

async function captureCmd(extra: Partial<Parameters<typeof runClaude>[0]> = {}): Promise<string[]> {
  let seenCmd: string[] = [];
  const agent = extra.agent ?? plainAgent;
  await runClaude({
    runner: async (cmd) => {
      seenCmd = cmd;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent,
    permissionMode: "plan",
    // Mirrors exactly what every real executor (readonly.ts/write.ts)
    // does: pass agent.mcpAccess through as its own top-level option —
    // runClaude never reads it off `agent` itself, same as allowedTools
    // is never derived from agent.toolAccess automatically.
    mcpAccess: agent.mcpAccess,
    ...extra,
  });
  return seenCmd;
}

test("an agent with no mcpAccess gets byte-for-byte identical argv to before mcpAccess existed, even with a real pool wired up", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack" })]);
  const withoutPool = await captureCmd({});
  const withPoolButNoGrant = await captureCmd({ mcpServers: pool });
  expect(withPoolButNoGrant).toEqual(withoutPool);
  expect(withPoolButNoGrant).not.toContain("--mcp-config");
  expect(withPoolButNoGrant).not.toContain("--strict-mcp-config");
  expect(withPoolButNoGrant).not.toContain("--allowedTools");
  expect(withPoolButNoGrant[withPoolButNoGrant.indexOf("--output-format") + 1]).toBe("json");
});

test("every real agent in agents/manifest.yaml that doesn't declare mcpAccess gets identical argv whether or not a real McpServerPool is wired up", async () => {
  // `mcp-tool-caller` (agents/manifest.yaml) is the one deliberate
  // exception — added by MCP orchestration subtask 7 specifically to
  // carry a real mcpAccess grant (see docs/SDD-mcp-orchestration.md §6
  // Subtask 7) — excluded from this loop and covered by its own
  // assertion below instead. Every other agent in the manifest must
  // still see zero behavior change from a pool being wired up, exactly
  // as before that agent existed.
  const { Registry } = await import("../src/core/registry.ts");
  const registry = await Registry.load();
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "auto" }] })]);
  for (const agent of registry.all()) {
    if (agent.id === "mcp-tool-caller") continue;
    expect(agent.mcpAccess).toBeUndefined();
    const withoutPool = await captureCmd({ agent, permissionMode: "plan" });
    const withPool = await captureCmd({ agent, permissionMode: "plan", mcpServers: pool });
    expect(withPool).toEqual(withoutPool);
  }
});

test("mcp-tool-caller's own manifest-declared mcpAccess is inert against a pool that doesn't register its server (e.g. the real mcp-servers.yaml today)", async () => {
  const { Registry } = await import("../src/core/registry.ts");
  const registry = await Registry.load();
  const agent = registry.get("mcp-tool-caller")!;
  expect(agent.mcpAccess).toEqual([{ server: "wissel-echo-mcp", tools: ["echo", "echo_sensitive"] }]);

  const withoutPool = await captureCmd({ agent, permissionMode: "plan" });
  // A pool with servers registered, but never "wissel-echo-mcp" — same
  // "unknown/disabled server is silently dropped" contract
  // resolveMcpGrants already holds (src/executors/mcp-config.ts).
  const poolMissingServer = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "auto" }] })]);
  const withUnrelatedPool = await captureCmd({ agent, permissionMode: "plan", mcpServers: poolMissingServer });
  expect(withUnrelatedPool).toEqual(withoutPool);
  expect(withUnrelatedPool).not.toContain("--mcp-config");
});

test("a grant naming a server not in the pool (or disabled) is dropped — same byte-identical argv as no mcpAccess at all", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", enabled: false })]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] }, mcpServers: pool });
  expect(cmd).not.toContain("--mcp-config");
  expect(cmd).not.toContain("--allowedTools");
  expect(cmd[cmd.indexOf("--output-format") + 1]).toBe("json");
});

test("an agent with mcpAccess: [{server:'x', tools:['y']}] gets exactly that server+tool pair built into --mcp-config and --allowedTools, no more, no less", async () => {
  const pool = McpServerPool.from([
    mcpServer({ id: "x", transport: { kind: "stdio", command: "/bin/x-server", args: ["--flag"] }, tools: [{ name: "y", trust: "auto" }] }),
    mcpServer({ id: "unrelated", tools: [{ name: "z", trust: "auto" }] }),
  ]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "x", tools: ["y"] }] }, mcpServers: pool });

  expect(cmd).toContain("--strict-mcp-config");
  const configIdx = cmd.indexOf("--mcp-config");
  expect(configIdx).toBeGreaterThan(-1);
  const config = JSON.parse(cmd[configIdx + 1]!);
  expect(config).toEqual({ mcpServers: { x: { command: "/bin/x-server", args: ["--flag"] } } });
  expect(Object.keys(config.mcpServers)).toEqual(["x"]); // never "unrelated" — only the granted server

  const toolsIdx = cmd.indexOf("--allowedTools");
  expect(toolsIdx).toBeGreaterThan(-1);
  expect(cmd.slice(toolsIdx + 1)).toEqual(["mcp__x__y"]);
});

test("MCP allowedTools entries are appended alongside an existing allowedTools list, not replacing it", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "x", tools: [{ name: "y", trust: "auto" }] })]);
  const cmd = await captureCmd({
    agent: { ...plainAgent, mcpAccess: [{ server: "x", tools: ["y"] }] },
    mcpServers: pool,
    allowedTools: ["Bash(bun test:*)"],
    permissionMode: "acceptEdits",
  });
  const idx = cmd.indexOf("--allowedTools");
  expect(cmd.slice(idx + 1)).toEqual(["Bash(bun test:*)", "mcp__x__y"]);
});

test("non-empty grants force stream-json/--include-partial-messages/--verbose even when the caller never asked for onChunk", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "x", tools: [{ name: "y", trust: "auto" }] })]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "x", tools: ["y"] }] }, mcpServers: pool });
  expect(cmd[cmd.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(cmd).toContain("--include-partial-messages");
  expect(cmd).toContain("--verbose");
});

test("a granted server's own env is merged into the spawned process's env, but never overrides the forced-empty ANTHROPIC_* vars", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "x", env: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN" }, tools: [{ name: "y", trust: "auto" }] })]);
  let seenEnv: Record<string, string> | undefined;
  await runClaude({
    runner: async (_cmd, opts) => {
      seenEnv = opts.env;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "x", tools: ["y"] }] },
    mcpAccess: [{ server: "x", tools: ["y"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(seenEnv).toEqual({ SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" });
});

test("mcpCalls is populated on the TaskResult when the stream carries a matching granted tool call", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "auto" }] })]);
  const stdout = [
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: { text: "hi" } }] },
    }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "sent", is_error: false }] } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ].join("\n");

  const result = await runClaude({
    runner: async () => ({ stdout, stderr: "", exitCode: 0 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });

  expect(result.ok).toBe(true);
  expect(result.mcpCalls).toEqual([{ server: "slack", tool: "send_message", args: { text: "hi" }, result: "sent", ok: true }]);
});

test("mcpCalls is undefined when the agent has no mcpAccess, even if the (non-streamed) stdout happened to mention tool_use-shaped JSON", async () => {
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 }),
    task,
    agent: plainAgent,
    permissionMode: "plan",
  });
  expect(result.mcpCalls).toBeUndefined();
});

test("mcpCalls is still attached on a failed run (e.g. a non-zero exit) when a granted call happened before the failure", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "auto" }] })]);
  const stdout = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__slack__send_message", input: {} }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "sent", is_error: false }] } }),
  ].join("\n");

  const result = await runClaude({
    runner: async () => ({ stdout, stderr: "crashed after the tool call", exitCode: 1 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });

  expect(result.ok).toBe(false);
  expect(result.mcpCalls).toEqual([{ server: "slack", tool: "send_message", args: {}, result: "sent", ok: true }]);
});

// --- Per-tool trust tiers + v1 approval gate (docs/SDD-mcp-orchestration.md §3.5) ---

test("an approval-required tool is never present in --allowedTools or --mcp-config, regardless of what mcpAccess declares", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] }, mcpServers: pool });
  expect(cmd).not.toContain("--mcp-config");
  expect(cmd).not.toContain("--strict-mcp-config");
  expect(cmd).not.toContain("--allowedTools");
});

test("a mixed grant builds --mcp-config/--allowedTools from only the auto tool, excluding the approval-required one", async () => {
  const pool = McpServerPool.from([
    mcpServer({
      id: "slack",
      tools: [
        { name: "read_messages", trust: "auto" },
        { name: "send_message", trust: "approval-required" },
      ],
    }),
  ]);
  const cmd = await captureCmd({
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["read_messages", "send_message"] }] },
    mcpServers: pool,
  });
  const configIdx = cmd.indexOf("--mcp-config");
  expect(configIdx).toBeGreaterThan(-1);
  expect(JSON.parse(cmd[configIdx + 1]!)).toEqual({ mcpServers: { slack: { command: "/usr/local/bin/example-mcp-server", args: [] } } });
  const toolsIdx = cmd.indexOf("--allowedTools");
  expect(cmd.slice(toolsIdx + 1)).toEqual(["mcp__slack__read_messages"]);
});

test("a tool not declared on the server at all is excluded from --allowedTools too — fails closed, never assumes auto", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [] })]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["undeclared"] }] }, mcpServers: pool });
  expect(cmd).not.toContain("--mcp-config");
  expect(cmd).not.toContain("--allowedTools");
});

test("a run with only an approval-required grant doesn't force streaming — there's no auto tool call to capture a transcript for", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const cmd = await captureCmd({ agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] }, mcpServers: pool });
  expect(cmd[cmd.indexOf("--output-format") + 1]).toBe("json");
});

test("an agent with zero approval-required grants (every existing agent today) sees byte-identical behavior — no prompt change, no mcpApprovalRequest field", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "auto" }] })]);
  let seenPrompt = "";
  const result = await runClaude({
    runner: async (cmd) => {
      seenPrompt = cmd[2]!;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(seenPrompt).not.toContain("mcp-approval-request");
  expect(result.mcpApprovalRequest).toBeUndefined();
  expect(result.ok).toBe(true);
});

test("an agent with a pending-approval grant gets the prompt instruction naming the blocked tool", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  let seenPrompt = "";
  await runClaude({
    runner: async (cmd) => {
      seenPrompt = cmd[2]!;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(seenPrompt).toContain("slack/send_message");
  expect(seenPrompt).toContain("```mcp-approval-request");
});

test("a well-formed mcp-approval-request block naming a real pending tool attaches mcpApprovalRequest, stays ok: true", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const resultText = [
    "I can't send this directly.",
    "",
    "```mcp-approval-request",
    '{"server": "slack", "tool": "send_message", "args": {"text": "hi"}, "reason": "notify the team"}',
    "```",
  ].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }), stderr: "", exitCode: 0 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.mcpApprovalRequest).toEqual({ server: "slack", tool: "send_message", args: { text: "hi" }, reason: "notify the team" });
});

test("a pending-approval run where the agent has nothing to request (no block at all) stays ok: true with mcpApprovalRequest undefined", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Nothing to do here, task complete." }), stderr: "", exitCode: 0 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(true);
  expect(result.mcpApprovalRequest).toBeUndefined();
});

test("a malformed mcp-approval-request block (attempted but garbled) fails the run closed, never silently drops it", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const resultText = ["```mcp-approval-request", "not even json", "```"].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }), stderr: "", exitCode: 0 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.mcpApprovalRequest).toBeUndefined();
  expect(result.summary).toContain("malformed");
});

test("an mcp-approval-request naming a server/tool this run wasn't actually blocked on fails the run closed", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const resultText = ["```mcp-approval-request", '{"server": "jira", "tool": "create_ticket", "args": {}, "reason": "x"}', "```"].join("\n");
  const result = await runClaude({
    runner: stub({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: resultText }), stderr: "", exitCode: 0 }),
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    permissionMode: "plan",
  });
  expect(result.ok).toBe(false);
  expect(result.mcpApprovalRequest).toBeUndefined();
  expect(result.summary).toContain("isn't one of this run's pending-approval grants");
});

test("mcpAccessPreApproved: true bypasses the trust-tier split — a tool the server declares approval-required reaches --allowedTools/--mcp-config anyway", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const cmd = await captureCmd({
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    mcpAccessPreApproved: true,
  });
  expect(cmd).toContain("--mcp-config");
  const configIdx = cmd.indexOf("--mcp-config");
  expect(JSON.parse(cmd[configIdx + 1]!)).toEqual({ mcpServers: { slack: { command: "/usr/local/bin/example-mcp-server", args: [] } } });
  const toolsIdx = cmd.indexOf("--allowedTools");
  expect(cmd.slice(toolsIdx + 1)).toEqual(["mcp__slack__send_message"]);
});

test("mcpAccessPreApproved: true also skips the pending-approval prompt instruction entirely — the agent isn't told to describe-not-call a tool it can now actually call", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  let seenPrompt = "";
  const result = await runClaude({
    runner: async (cmd) => {
      seenPrompt = cmd[2]!;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
    },
    task,
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
    mcpAccessPreApproved: true,
    permissionMode: "plan",
  });
  expect(seenPrompt).not.toContain("mcp-approval-request");
  expect(result.mcpApprovalRequest).toBeUndefined();
});

test("omitting mcpAccessPreApproved (every call before this option existed) keeps the approval-required tool gated — the bypass is opt-in, never a default", async () => {
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  const cmd = await captureCmd({
    agent: { ...plainAgent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] },
    mcpAccess: [{ server: "slack", tools: ["send_message"] }],
    mcpServers: pool,
  });
  expect(cmd).not.toContain("--mcp-config");
  expect(cmd).not.toContain("--allowedTools");
});

test("every real agent in agents/manifest.yaml that doesn't declare mcpAccess sees identical argv/prompt whether or not a server declares approval-required tools", async () => {
  // Same `mcp-tool-caller` exclusion as the test above — see its own
  // comment. A pool here that declares its granted "echo"/"echo_sensitive"
  // tools under the real "wissel-echo-mcp" server id would legitimately
  // change this agent's argv, which is exactly the point of that agent
  // existing — not a regression to assert away.
  const { Registry } = await import("../src/core/registry.ts");
  const registry = await Registry.load();
  const pool = McpServerPool.from([mcpServer({ id: "slack", tools: [{ name: "send_message", trust: "approval-required" }] })]);
  for (const agent of registry.all()) {
    if (agent.id === "mcp-tool-caller") continue;
    expect(agent.mcpAccess).toBeUndefined();
    const withoutPool = await captureCmd({ agent, permissionMode: "plan" });
    const withPool = await captureCmd({ agent, permissionMode: "plan", mcpServers: pool });
    expect(withPool).toEqual(withoutPool);
  }
});

test("addDir builds --add-dir with exactly the given paths", async () => {
  const cmd = await captureCmd({ addDir: ["/some/other/repo"] });
  const addDirIndex = cmd.indexOf("--add-dir");
  expect(addDirIndex).toBeGreaterThan(-1);
  expect(cmd[addDirIndex + 1]).toBe("/some/other/repo");
});

test("addDir with multiple paths passes every one of them to --add-dir", async () => {
  const cmd = await captureCmd({ addDir: ["/repo/a", "/repo/b"] });
  const addDirIndex = cmd.indexOf("--add-dir");
  expect(cmd.slice(addDirIndex + 1, addDirIndex + 3)).toEqual(["/repo/a", "/repo/b"]);
});

test("omitting addDir (every call before this option existed) never adds --add-dir — byte-identical argv", async () => {
  const withoutAddDir = await captureCmd({});
  expect(withoutAddDir).not.toContain("--add-dir");
});

test("addDir: [] (present but empty) is treated the same as omitted — no --add-dir, not an empty flag", async () => {
  const cmd = await captureCmd({ addDir: [] });
  expect(cmd).not.toContain("--add-dir");
});

test("every real agent in agents/manifest.yaml gets byte-identical argv when addDir is omitted, proving this option changes nothing for the default case", async () => {
  const { Registry } = await import("../src/core/registry.ts");
  const registry = await Registry.load();
  for (const agent of registry.all()) {
    const withoutAddDirOption = await captureCmd({ agent, permissionMode: "plan" });
    const withAddDirExplicitlyUndefined = await captureCmd({ agent, permissionMode: "plan", addDir: undefined });
    expect(withAddDirExplicitlyUndefined).toEqual(withoutAddDirOption);
  }
});
