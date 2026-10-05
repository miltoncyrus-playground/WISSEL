import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteExecutor } from "../src/executors/write.ts";
import type { CommandResult, CommandRunner } from "../src/executors/claude-cli.ts";
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
  executor: "handoff",
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
  return mkdtemp(join(tmpdir(), "wissel-write-executor-test-"));
}

/** Every test here needs the worktree machinery to succeed before it
 *  ever reaches the claude call — this fakes `git worktree add`
 *  (and the idempotency check before it) as always-clean, and routes
 *  every other command to the given claude-result stub. Mirrors the
 *  runner-injection pattern every other executor test already uses;
 *  the worktree step is real plumbing now, not something to bypass. */
function fakeRunner(claudeResult: CommandResult): CommandRunner {
  return async (cmd: string[]) => {
    if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
    return claudeResult;
  };
}

test("canHandle only accepts write-tier agents", () => {
  const executor = new WriteExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, tier: "readonly" })).toBe(false);
});

// Added alongside CodexWriteExecutor — that's its territory now, not
// array order in whatever pool they're both registered in.
test("canHandle excludes executor: codex — that's CodexWriteExecutor's territory, not array order", () => {
  const executor = new WriteExecutor();
  expect(executor.canHandle({ ...agent, executor: "codex" })).toBe(false);
});

test("runs claude in acceptEdits mode inside an isolated worktree and parses a successful result", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result).toEqual({
      taskId: "t1",
      agentId: "implementer",
      ok: true,
      summary: "shipped",
      worktree: { path: join(home, ".wissel", "worktrees", "t1"), branch: "wissel/t1" },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// docs/SDD-live-task-output.md §3.2/§4 — the executor closes over
// task.id so runClaude's own onChunk (line-only) becomes the store's
// (taskId, line) shape without the store needing to know about tasks.
test("onChunk, when given, fires with (task.id, line) for every parsed JSONL line runClaude sees, in order", async () => {
  const home = await fakeHome();
  try {
    const seen: Array<[string, unknown]> = [];
    const chunks = [{ type: "system" }, { type: "result", subtype: "success", is_error: false, result: "shipped" }];
    const executor = new WriteExecutor({
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

test("omitting onChunk never passes one through to runClaude — identical to today's behavior", async () => {
  const home = await fakeHome();
  try {
    let sawOnChunk: unknown = "unset";
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd: string[], opts: { onChunk?: (line: unknown) => void }) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        sawOnChunk = opts.onChunk;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(sawOnChunk).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runs claude inside the worktree, not task.repo directly — the whole point of this executor", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    let seenCwd = "";
    let seenStdin: string | undefined;
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        seenCwd = opts.cwd;
        seenStdin = opts.stdin;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);

    expect(seenCwd).toBe(join(home, ".wissel", "worktrees", "t1"));
    expect(seenCwd).not.toBe(task.repo);
    expect(seenCmd[0]).toBe("claude");
    expect(seenCmd).toContain("--permission-mode");
    expect(seenCmd[seenCmd.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    // The prompt still describes the task itself, not the worktree path
    // it happens to run in — buildAgentPrompt never reads task.repo. It's
    // piped via stdin, never an argv element (see CommandRunner's
    // `stdin` doc comment in claude-cli.ts for the E2BIG this avoids).
    expect(seenCmd).not.toContain(agent.description);
    const prompt = seenStdin!;
    expect(prompt).toContain(agent.description);
    expect(prompt).toContain(task.title);
    expect(prompt).toContain(task.body);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("always passes the narrow self-verification Bash allowlist — acceptEdits alone gates Bash behind an approval prompt a headless run can't answer", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    const idx = seenCmd.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(seenCmd.slice(idx + 1, idx + 3)).toEqual(["Bash(bun test:*)", "Bash(bun run typecheck:*)"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("defaults --model to the routed agent's own costProfile.model", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe(agent.costProfile.model);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an explicit constructor model overrides the agent's own costProfile.model", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      model: "claude-haiku-4-5-20251001",
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenCmd[seenCmd.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("surfaces is_error from claude as ok: false", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("boom");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("appends permission denial count to the summary — e.g. a Bash call acceptEdits doesn't cover", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", permission_denials: [{}] }),
        stderr: "",
        exitCode: 0,
      }),
    });
    const result = await executor.run(task, agent);
    expect(result.summary).toBe("done [1 permission denial(s)]");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a non-zero exit from claude becomes a failed TaskResult, not a throw", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: fakeRunner({ stdout: "", stderr: "command not found: claude", exitCode: 127 }),
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("exited 127");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a spawn failure (e.g. claude not on PATH) becomes a failed TaskResult, not a throw", async () => {
  const home = await fakeHome();
  try {
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        throw new Error("ENOENT");
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to spawn claude");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a pushback re-attempt (reviewLineageId set) keys its worktree off the lineage id, not its own task id", async () => {
  const home = await fakeHome();
  try {
    let seenCwd = "";
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCwd = opts.cwd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }), stderr: "", exitCode: 0 };
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

test("a worktree creation failure becomes a failed TaskResult without ever calling claude", async () => {
  const home = await fakeHome();
  try {
    let claudeCalled = false;
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[1] === "worktree" && cmd[2] === "list") return { stdout: "", stderr: "", exitCode: 0 };
        if (cmd[0] === "git") return { stdout: "", stderr: "fatal: not a git repository", exitCode: 128 };
        claudeCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await executor.run(task, agent);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("failed to create worktree");
    expect(claudeCalled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- MCP grants (docs/SDD-mcp-orchestration.md §3.2) --------------------

test("an agent with no mcpAccess gets identical argv whether or not an mcpServers pool is wired up on the executor", async () => {
  const home = await fakeHome();
  try {
    const mcpServer: McpServer = { id: "slack", label: "Slack", transport: { kind: "stdio", command: "/bin/true", args: [] }, tools: [], enabled: true };
    const pool = McpServerPool.from([mcpServer]);
    const claudeResult = { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };

    let cmdWithoutPool: string[] = [];
    await new WriteExecutor({ homeDir: home, runner: async (cmd) => (cmd[0] === "git" ? { stdout: "", stderr: "", exitCode: 0 } : ((cmdWithoutPool = cmd), claudeResult)) }).run(task, agent);

    let cmdWithPool: string[] = [];
    await new WriteExecutor({ homeDir: home, mcpServers: pool, runner: async (cmd) => (cmd[0] === "git" ? { stdout: "", stderr: "", exitCode: 0 } : ((cmdWithPool = cmd), claudeResult)) }).run(task, agent);

    expect(cmdWithPool).toEqual(cmdWithoutPool);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("passes agent.mcpAccess and the executor's own mcpServers pool through to runClaude", async () => {
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
    const grantedAgent: AgentDef = { ...agent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] };

    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      mcpServers: pool,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, grantedAgent);
    expect(seenCmd).toContain("--mcp-config");
    expect(seenCmd.join(" ")).toContain("mcp__slack__send_message");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task.mcpAccessOverride naming an approval-required tool actually reaches --allowedTools — the approved follow-up call is pre-approved, not re-gated", async () => {
  const home = await fakeHome();
  try {
    const mcpServer: McpServer = {
      id: "slack",
      label: "Slack",
      transport: { kind: "stdio", command: "/bin/true", args: [] },
      tools: [{ name: "send_message", trust: "approval-required" }],
      enabled: true,
    };
    const pool = McpServerPool.from([mcpServer]);
    const overriddenTask: TaskCard = { ...task, mcpAccessOverride: [{ server: "slack", tools: ["send_message"] }] };

    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      mcpServers: pool,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    // The routed agent declares no mcpAccess at all — the grant comes
    // entirely from the task-level override, same as the real
    // human-approved-follow-up task the approve endpoint creates.
    await executor.run(overriddenTask, agent);
    expect(seenCmd).toContain("--mcp-config");
    expect(seenCmd.join(" ")).toContain("mcp__slack__send_message");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- extraAllowedDirs / --add-dir (docs/SDD-crash-recovery.md §3.3) ----

test("task.extraAllowedDirs reaches runClaude as --add-dir — the mechanism maybeSpawnConflictIntegrator relies on to let the integrator touch the original repo outside its own worktree", async () => {
  const home = await fakeHome();
  try {
    const grantedTask: TaskCard = { ...task, extraAllowedDirs: ["/some/other/repo"] };
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(grantedTask, agent);
    const idx = seenCmd.indexOf("--add-dir");
    expect(idx).toBeGreaterThan(-1);
    expect(seenCmd[idx + 1]).toBe("/some/other/repo");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a task with no extraAllowedDirs gets identical argv to before this field existed — no --add-dir at all", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenCmd).not.toContain("--add-dir");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- extraAllowedTools / --allowedTools (docs/SDD-crash-recovery.md §3.3) ----

test("task.extraAllowedTools reaches runClaude's --allowedTools, appended after the fixed Bash(bun ...) pair", async () => {
  const home = await fakeHome();
  try {
    const grantedTask: TaskCard = { ...task, extraAllowedTools: ["Bash(git -C /some/other/repo status:*)", "Bash(git -C /some/other/repo commit:*)"] };
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(grantedTask, agent);
    const idx = seenCmd.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(seenCmd.slice(idx + 1)).toEqual([
      "Bash(bun test:*)",
      "Bash(bun run typecheck:*)",
      "Bash(git -C /some/other/repo status:*)",
      "Bash(git -C /some/other/repo commit:*)",
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a task with no extraAllowedTools gets identical --allowedTools to before this field existed — just the fixed Bash(bun ...) pair", async () => {
  const home = await fakeHome();
  try {
    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    const idx = seenCmd.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(seenCmd.slice(idx + 1)).toEqual(["Bash(bun test:*)", "Bash(bun run typecheck:*)"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an agent's own regular mcpAccess grant for an approval-required tool stays gated even with a pool wired up — only task.mcpAccessOverride bypasses the gate", async () => {
  const home = await fakeHome();
  try {
    const mcpServer: McpServer = {
      id: "slack",
      label: "Slack",
      transport: { kind: "stdio", command: "/bin/true", args: [] },
      tools: [{ name: "send_message", trust: "approval-required" }],
      enabled: true,
    };
    const pool = McpServerPool.from([mcpServer]);
    const grantedAgent: AgentDef = { ...agent, mcpAccess: [{ server: "slack", tools: ["send_message"] }] };

    let seenCmd: string[] = [];
    const executor = new WriteExecutor({
      homeDir: home,
      mcpServers: pool,
      runner: async (cmd) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenCmd = cmd;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, grantedAgent);
    expect(seenCmd).not.toContain("--mcp-config");
    // WriteExecutor always adds its own fixed Bash(bun ...) allowedTools
    // regardless of MCP grants (see write.ts), so --allowedTools itself
    // is expected here — the actual gate is that the mcp tool name never
    // joins that list.
    expect(seenCmd.join(" ")).not.toContain("mcp__slack__send_message");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// --- memory injection toggle (docs/SDD-memory-injection-toggle.md) -----

test("injectMemory omitted on the constructor: a real memoryPath's content never reaches the prompt", async () => {
  const home = await fakeHome();
  const memDir = await mkdtemp(join(tmpdir(), "wissel-write-executor-memory-test-"));
  try {
    const memoryPath = join(memDir, "lessons.md");
    await writeFile(memoryPath, "SENTINEL-SESSION-LESSON-abc123");
    let seenStdin: string | undefined;
    const executor = new WriteExecutor({
      homeDir: home,
      memoryPath,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenStdin = opts.stdin;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenStdin).not.toContain("SENTINEL-SESSION-LESSON-abc123");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(memDir, { recursive: true, force: true });
  }
});

test("injectMemory: true on the constructor folds the memoryPath's content into the prompt", async () => {
  const home = await fakeHome();
  const memDir = await mkdtemp(join(tmpdir(), "wissel-write-executor-memory-test-"));
  try {
    const memoryPath = join(memDir, "lessons.md");
    await writeFile(memoryPath, "SENTINEL-SESSION-LESSON-abc123");
    let seenStdin: string | undefined;
    const executor = new WriteExecutor({
      homeDir: home,
      memoryPath,
      injectMemory: true,
      runner: async (cmd, opts) => {
        if (cmd[0] === "git") return { stdout: "", stderr: "", exitCode: 0 };
        seenStdin = opts.stdin;
        return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "shipped" }), stderr: "", exitCode: 0 };
      },
    });
    await executor.run(task, agent);
    expect(seenStdin).toContain("SENTINEL-SESSION-LESSON-abc123");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(memDir, { recursive: true, force: true });
  }
});
