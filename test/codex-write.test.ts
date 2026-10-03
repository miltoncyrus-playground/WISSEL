import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import type { AgentDef, McpServer, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "implementer",
  name: "Implementer",
  kind: "agent",
  tier: "write",
  description: "Writes code for a card with clear acceptance criteria.",
  whenToUse: "Card has clear acceptance criteria and needs code written.",
  tags: ["code"],
  executor: "codex",
  inputs: ["task-card"],
  outputs: ["diff"],
  trustLevel: "high",
  toolAccess: ["read", "write", "bash"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.6 },
};

const task: TaskCard = {
  id: "t1",
  title: "Build the thing",
  body: "Implement the SDD.",
  labels: ["code"],
  repo: "/tmp",
  status: "dispatched",
};

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-codex-write-test-"));
}

test("canHandle only accepts write-tier agents with executor: codex", () => {
  const executor = new CodexWriteExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, executor: "handoff" })).toBe(false);
});

test("runs codex with the workspace-write sandbox inside an isolated worktree and parses a successful result", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    let seenCwd = "";
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        seenCwd = opts.cwd;
        return {
          stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"shipped"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await executor.run(task, agent);

    expect(seenCmd[seenCmd.indexOf("-s") + 1]).toBe("workspace-write");
    expect(seenCwd).toBe(join(home, ".wissel", "worktrees", "t1"));
    expect(seenCwd).not.toBe(task.repo);
    expect(result).toEqual({
      taskId: "t1",
      agentId: "implementer",
      ok: true,
      summary: "shipped",
      actualCost: undefined,
      worktree: { path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// docs/SDD-live-task-output.md §3.2/§4 — the executor closes over
// task.id so runCodex's own onChunk (line-only) becomes the store's
// (taskId, line) shape without the store needing to know about tasks.
// Wired for consistency with CodexReadOnlyExecutor even though the SDD's
// subtask 3 text names only ReadOnlyExecutor/WriteExecutor/
// CodexReadOnlyExecutor explicitly — leaving write-tier codex tasks with
// no live output while every other executor has it would be a visible,
// avoidable gap given subtask 1 already covers codex-cli.ts cleanly.
test("onChunk, when given, fires with (task.id, line) for every parsed JSONL line runCodex sees, in order", async () => {
  const home = await fakeHome();
  try {
    const seen: Array<[string, unknown]> = [];
    const chunks = [{ type: "item.completed", item: { id: "i", type: "agent_message", text: "shipped" } }, { type: "turn.completed" }];
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd: string[], opts: { onChunk?: (line: unknown) => void }) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Real risk this executor's ok computation exists to catch (SDD §6.1/§7.2):
// a sandbox-denied write can leave exit 0 with no turn.failed, visible only
// as a failed file_change item — confirmed live, not hypothetical.
test("a sandbox-denied write is reported as ok: false even though codex itself exits 0", async () => {
  const home = await fakeHome();
  try {
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        return {
          stdout: [
            '{"type":"item.completed","item":{"id":"item_1","type":"file_change","status":"failed"}}',
            '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"blocked"}}',
            '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a pushback re-attempt (reviewLineageId set) keys its worktree off the lineage id, not its own task id", async () => {
  const home = await fakeHome();
  try {
    let seenCwd = "";
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCwd = opts.cwd;
        return {
          stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"shipped"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1}}',
          stderr: "",
          exitCode: 0,
        };
      },
    });

    const reattempt: TaskCard = { ...task, id: "t2", reviewLineageId: "t1" };
    const result = await executor.run(reattempt, agent);

    // Same worktree path/branch as the original attempt (task.id "t1"),
    // not a fresh one under "t2" — the whole point of lineage reuse.
    expect(seenCwd).toBe(join(home, ".wissel", "worktrees", "t1"));
    expect(result.worktree).toEqual({ path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a worktree creation failure becomes a failed TaskResult without ever calling codex", async () => {
  const home = await fakeHome();
  try {
    let codexCalled = false;
    const executor = new CodexWriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd[0] === "git") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
        codexCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to create worktree");
    expect(codexCalled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- MCP grants (docs/SDD-mcp-orchestration.md §3.2) --------------------
// See runCodex's own doc comment (codex-cli.ts) — a resolved grant fails
// loud rather than being wired into the invocation, since codex's real
// MCP CLI surface is unverified, unlike claude-cli's.

test("an agent with no mcpAccess gets identical argv whether or not an mcpServers pool is wired up on the executor", async () => {
  const home = await fakeHome();
  try {
    const mcpServer: McpServer = { id: "slack", label: "Slack", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true };
    const pool = McpServerPool.from([mcpServer]);
    const codexResult = { stdout: '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"shipped"}}', stderr: "", exitCode: 0 };

    let cmdWithoutPool: string[] = [];
    await new CodexWriteExecutor({ homeDir: home, runner: async (cmd) => (cmd[0] === "git" ? { stdout: "", stderr: "", exitCode: 0 } : ((cmdWithoutPool = cmd), codexResult)) }).run(task, agent);
    let cmdWithPool: string[] = [];
    await new CodexWriteExecutor({ homeDir: home, mcpServers: pool, runner: async (cmd) => (cmd[0] === "git" ? { stdout: "", stderr: "", exitCode: 0 } : ((cmdWithPool = cmd), codexResult)) }).run(task, agent);

    expect(cmdWithPool).toEqual(cmdWithoutPool);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a declared, resolvable mcpAccess grant surfaces as a loud failure, not a silently-ignored one", async () => {
  const home = await fakeHome();
  try {
    const mcpServer: McpServer = {
      id: "slack",
      label: "Slack",
      transport: { kind: "stdio", command: "/bin/true", args: [] },
      tools: [{ name: "send_message", trust: "auto" }],
      enabled: true,
    };
    const pool = McpServerPool.from([mcpServer]);
    const executor = new CodexWriteExecutor({
      homeDir: home,
      mcpServers: pool,
      runner: async (cmd) => (cmd[0] === "git" ? { stdout: "", stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 }),
    });
    const grantedAgent: AgentDef = { ...agent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] };

    const result = await executor.run(task, grantedAgent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not yet implemented");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
