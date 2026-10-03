import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexReadOnlyExecutor } from "../src/executors/codex-readonly.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import type { AgentDef, McpServer, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "triager",
  name: "Triager",
  kind: "agent",
  tier: "readonly",
  description: "Turns raw input into a structured task card.",
  whenToUse: "Unstructured input with no labels yet.",
  tags: ["intake"],
  executor: "codex",
  inputs: ["raw-text"],
  outputs: ["task-card"],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.03 },
};

const task: TaskCard = {
  id: "t1",
  title: "Triage this",
  body: "Some raw input.",
  labels: ["intake"],
  repo: "/tmp",
  status: "ready",
};

test("canHandle only accepts readonly-tier agents with executor: codex", () => {
  const executor = new CodexReadOnlyExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "write" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "api" })).toBe(false);
});

test("runs codex with the read-only sandbox and parses a successful result", async () => {
  let seenCmd: string[] = [];
  let seenCwd = "";
  const executor = new CodexReadOnlyExecutor({
    runner: async (cmd, opts) => {
      seenCmd = cmd;
      seenCwd = opts.cwd;
      return {
        stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"triaged"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
        stderr: "",
        exitCode: 0,
      };
    },
  });

  const result = await executor.run(task, agent);

  expect(seenCwd).toBe("/tmp");
  expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("read-only");
  expect(result).toEqual({ taskId: "t1", agentId: "triager", ok: true, summary: "triaged" });
});

// docs/SDD-live-task-output.md §3.2/§4 — the executor closes over
// task.id so runCodex's own onChunk (line-only) becomes the store's
// (taskId, line) shape without the store needing to know about tasks.
test("onChunk, when given, fires with (task.id, line) for every parsed JSONL line runCodex sees, in order", async () => {
  const seen: Array<[string, unknown]> = [];
  const chunks = [{ type: "item.completed", item: { id: "i", type: "agent_message", text: "triaged" } }, { type: "turn.completed" }];
  const executor = new CodexReadOnlyExecutor({
    runner: async (_cmd, opts) => {
      for (const c of chunks) opts.onChunk?.(c);
      return { stdout: chunks.map((c) => JSON.stringify(c)).join("\n"), stderr: "", exitCode: 0 };
    },
    onChunk: (taskId, line) => seen.push([taskId, line]),
  });
  const result = await executor.run(task, agent);
  expect(seen).toEqual([
    ["t1", chunks[0]],
    ["t1", chunks[1]],
  ]);
  expect(result.ok).toBe(true);
});

test("reports harnessId on the result when a harness was picked", async () => {
  const executor = new CodexReadOnlyExecutor({
    runner: async () => ({
      stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
      stderr: "",
      exitCode: 0,
    }),
  });

  const result = await executor.run(task, agent, { id: "codex-personal", tool: "codex-cli", label: "Codex — personal", enabled: true });
  expect(result.harnessId).toBe("codex-personal");
});

// --- optional repo / scratch workspace (docs/SDD-mcp-orchestration.md §3.3/§4, Subtask 5) ---

test("a repo-less task's cwd resolves to a real, created ~/.wissel/scratch/<taskId> directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-codex-readonly-scratch-test-"));
  try {
    let seenCwd = "";
    const executor = new CodexReadOnlyExecutor({
      homeDir: home,
      runner: async (_cmd, opts) => {
        seenCwd = opts.cwd;
        return {
          stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });
    const repoLessTask: TaskCard = { ...task, repo: undefined };

    await executor.run(repoLessTask, agent);

    expect(seenCwd).toBe(join(home, ".wissel", "scratch", "t1"));
    expect(existsSync(seenCwd)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Regression: a task with a real repo is unaffected by the scratch-
// workspace fallback above.
test("a task with a real repo still uses that repo as cwd, never the scratch fallback", async () => {
  let seenCwd = "";
  const executor = new CodexReadOnlyExecutor({
    runner: async (_cmd, opts) => {
      seenCwd = opts.cwd;
      return { stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}', stderr: "", exitCode: 0 };
    },
  });
  await executor.run(task, agent);
  expect(seenCwd).toBe("/tmp");
});

// --- MCP grants (docs/SDD-mcp-orchestration.md §3.2) --------------------
// See runCodex's own doc comment (codex-cli.ts) for why a resolved grant
// fails loud here rather than being wired into the invocation — codex's
// real MCP CLI surface is unverified, unlike claude-cli's.

test("an agent with no mcpAccess gets identical argv whether or not an mcpServers pool is wired up on the executor", async () => {
  const mcpServer: McpServer = { id: "slack", label: "Slack", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true };
  const pool = McpServerPool.from([mcpServer]);
  const codexResult = {
    stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"triaged"}}',
    stderr: "",
    exitCode: 0,
  };

  let cmdWithoutPool: string[] = [];
  await new CodexReadOnlyExecutor({ runner: async (cmd) => ((cmdWithoutPool = cmd), codexResult) }).run(task, agent);
  let cmdWithPool: string[] = [];
  await new CodexReadOnlyExecutor({ mcpServers: pool, runner: async (cmd) => ((cmdWithPool = cmd), codexResult) }).run(task, agent);

  expect(cmdWithPool).toEqual(cmdWithoutPool);
});

test("a declared, resolvable mcpAccess grant surfaces as a loud failure, not a silently-ignored one", async () => {
  const mcpServer: McpServer = {
    id: "slack",
    label: "Slack",
    transport: { kind: "stdio", command: "/bin/true", args: [] },
    tools: [{ name: "send_message", trust: "auto" }],
    enabled: true,
  };
  const pool = McpServerPool.from([mcpServer]);
  const executor = new CodexReadOnlyExecutor({ mcpServers: pool, runner: async () => ({ stdout: "", stderr: "", exitCode: 0 }) });
  const grantedAgent: AgentDef = { ...agent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] };

  const result = await executor.run(task, grantedAgent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("not yet implemented");
  expect(result.summary).toContain("slack");
});
