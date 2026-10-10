import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";
import { runClaude, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";

// Per-card tool grants over the API, their persistence, and the
// structured permission refusals on a result (docs: src/core/allowed-tools.ts,
// src/core/permission-denials.ts).

const registry = await Registry.load();
const GRANTS = ["Bash(bun install:*)", "Bash(bunx playwright test:*)"];

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
}
const post = (path: string, body: unknown) => req(path, { method: "POST", body: JSON.stringify(body) });

async function newCard(board: SqliteBoard, over: Partial<TaskCard> = {}): Promise<TaskCard> {
  return board.create({ title: "t", body: "b", labels: ["code"], repo: "/tmp/repo", dependsOn: [], ...over });
}

test("POST /tasks stores validated grants and refuses bad ones", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, registry);
  const ok = await app(post("/tasks", { title: "t", body: "b", labels: ["code"], repo: "/tmp/repo", extraAllowedTools: [...GRANTS, GRANTS[0]] }));
  expect(ok.status).toBe(201);
  const created = (await ok.json()) as TaskCard;
  expect(created.extraAllowedTools).toEqual(GRANTS);
  expect((await board.get(created.id))!.extraAllowedTools).toEqual(GRANTS);

  const bad = await app(post("/tasks", { title: "t", body: "b", labels: ["code"], repo: "/tmp/repo", extraAllowedTools: ["Bash"] }));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toContain("not a command-scoped grant");
  const rm = await app(post("/tasks", { title: "t", body: "b", labels: ["code"], repo: "/tmp/repo", extraAllowedTools: ["Bash(rm -rf:*)"] }));
  expect(rm.status).toBe(400);
  expect((await board.list()).length).toBe(1);

  // No grants: stored as none, exactly as before.
  const plain = (await (await app(post("/tasks", { title: "t", body: "b", labels: ["code"], repo: "/tmp/repo", extraAllowedTools: [] }))).json()) as TaskCard;
  expect(plain.extraAllowedTools).toBeUndefined();
});

test("POST /tasks/:id/allowed-tools sets and clears grants on a card that isn't running", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, registry);
  const card = await newCard(board);
  const events: string[] = [];
  board.events.on("event", (e: { type: string }) => events.push(e.type));

  const set = await app(post(`/tasks/${card.id}/allowed-tools`, { extraAllowedTools: GRANTS }));
  expect(set.status).toBe(200);
  expect(((await set.json()) as TaskCard).extraAllowedTools).toEqual(GRANTS);
  expect((await board.get(card.id))!.extraAllowedTools).toEqual(GRANTS);
  expect(events).toContain("task.allowed-tools");

  const cleared = await app(post(`/tasks/${card.id}/allowed-tools`, { extraAllowedTools: [] }));
  expect(((await cleared.json()) as TaskCard).extraAllowedTools).toBeUndefined();
  expect((await board.get(card.id))!.extraAllowedTools).toBeUndefined();

  // An escalated card can be granted before a retry.
  await board.escalate(card.id, "blocked");
  expect((await app(post(`/tasks/${card.id}/allowed-tools`, { extraAllowedTools: GRANTS }))).status).toBe(200);
});

test("POST /tasks/:id/allowed-tools: 404 unknown, 409 running, 400 missing or invalid", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, registry);
  expect((await app(post("/tasks/nope/allowed-tools", { extraAllowedTools: GRANTS }))).status).toBe(404);

  const card = await newCard(board);
  expect((await app(post(`/tasks/${card.id}/allowed-tools`, {}))).status).toBe(400);
  const invalid = await app(post(`/tasks/${card.id}/allowed-tools`, { extraAllowedTools: ["Bash(curl:*)"] }));
  expect(invalid.status).toBe(400);
  expect((await board.get(card.id))!.extraAllowedTools).toBeUndefined();

  await board.move(card.id, "running");
  const running = await app(post(`/tasks/${card.id}/allowed-tools`, { extraAllowedTools: GRANTS }));
  expect(running.status).toBe(409);
  expect(((await running.json()) as { error: string }).error).toBe("task is running; change its tools once it stops");
});

test("POST /tasks/:id/escalation/retry keeps the card's grants and settings", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, registry);
  const card = await newCard(board, { extraAllowedTools: GRANTS, model: "claude-opus-5-5" });
  await board.escalate(card.id, "blocked by permissions");
  const res = await app(post(`/tasks/${card.id}/escalation/retry`, { body: "try again with the grants" }));
  expect(res.status).toBe(201);
  const next = (await res.json()) as TaskCard;
  expect(next.extraAllowedTools).toEqual(GRANTS);
  expect(next.model).toBe("claude-opus-5-5");
  expect((await board.get(next.id))!.extraAllowedTools).toEqual(GRANTS);
});

test("permissionDenials survive recordResult -> getResult, and an old task_results table is healed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-denials-"));
  try {
    const path = join(dir, "board.sqlite");
    // A board.sqlite from before the column existed.
    const old = new Database(path, { create: true });
    old.run(
      "CREATE TABLE task_results (taskId TEXT NOT NULL, agentId TEXT NOT NULL, ok INTEGER NOT NULL, summary TEXT NOT NULL, artifacts TEXT, worktree TEXT, actualCost REAL, harnessId TEXT, subagents TEXT, verdict TEXT, reviewFeedback TEXT, mcpCalls TEXT);",
    );
    old.close();

    const board = new SqliteBoard(path);
    await board.recordResult({ taskId: "a", agentId: "implementer", ok: true, summary: "done [1 permission denial(s)]", permissionDenials: ["Bash: bun install"] });
    await board.recordResult({ taskId: "b", agentId: "implementer", ok: true, summary: "done" });
    expect((await board.getResult("a"))!.permissionDenials).toEqual(["Bash: bun install"]);
    expect((await board.getResult("b"))!.permissionDenials).toBeUndefined();
    board.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runClaude puts the refused commands on the result, summary format unchanged", async () => {
  const agent: AgentDef = registry.get("implementer")!;
  const task: TaskCard = { id: "t1", title: "t", body: "b", labels: [], repo: "/tmp/repo", status: "running" };
  const runner: CommandRunner = async () => ({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      permission_denials: [
        { tool_name: "Bash", tool_use_id: "x", tool_input: { command: "cd app && timeout 300 bun install 2>&1 | tail -5" } },
        { tool_name: "Bash", tool_use_id: "y", tool_input: { command: "npm install --prefix app" } },
      ],
    }),
    stderr: "",
    exitCode: 0,
  });
  const result = await runClaude({ runner, task, agent, permissionMode: "acceptEdits" });
  expect(result.summary).toBe("done [2 permission denial(s)]");
  expect(result.permissionDenials).toEqual(["Bash: bun install", "Bash: npm install"]);

  const clean = await runClaude({
    runner: async () => ({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }), stderr: "", exitCode: 0 }),
    task,
    agent,
    permissionMode: "acceptEdits",
  });
  expect(clean.permissionDenials).toBeUndefined();
});
