import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { SqliteBoard } from "../src/services/board.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { createApp } from "../src/api/server.ts";
import {
  abandonEscalation,
  approveMcpRequest,
  cardSettingsRefusal,
  denyMcpRequest,
  disableHarness,
  disableMcpServer,
  discardTask,
  enableHarness,
  enableMcpServer,
  escalationRefusal,
  mcpApprovalRefusal,
  mergeTask,
  setAllowedTools,
  setHarnessDefaultModel,
  setMcpToolTrust,
  setTaskHarnessOverride,
  worktreeRefusal,
  type HarnessControlDeps,
  type McpControlDeps,
} from "../src/services/board-actions.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

// docs/SDD-wissel-app.md §3.7: the bodies of the board's endpoints, moved
// out of server.ts so the routes and Ask run the same code. The routes'
// own behaviour is covered by test/api.test.ts and friends; this checks
// each function directly, and the one new route, POST /tasks/:id/harness.

const dir = await mkdtemp(join(tmpdir(), "wissel-board-actions-"));
afterAll(() => rm(dir, { recursive: true, force: true }));

const runs: string[][] = [];
const gitRunner: CommandRunner = async (cmd) => {
  runs.push(cmd);
  if (cmd[0] === "git" && cmd[1] === "status") return { stdout: "", stderr: "", exitCode: 0 };
  return { stdout: "", stderr: "", exitCode: 0 };
};

async function reviewCard(board: SqliteBoard, worktree = true) {
  const t = await board.create({ title: "Work", body: "", labels: ["code"], repo: join(dir, "repo") });
  await board.move(t.id, "review");
  if (worktree) await board.recordResult({ taskId: t.id, agentId: "implementer", ok: true, summary: "ok", worktree: { path: join(dir, "wt"), branch: "wissel/work" } });
  return (await board.get(t.id))!;
}

describe("predicates", () => {
  test("each says why not, or undefined", () => {
    expect(worktreeRefusal(undefined, "merge")).toBe("task has no worktree to merge");
    expect(worktreeRefusal({ worktree: { path: "/w", branch: "b" } }, "discard")).toBeUndefined();
    expect(escalationRefusal({ status: "failed" })).toBe("task is not escalated");
    expect(escalationRefusal({ status: "escalated" })).toBeUndefined();
    expect(mcpApprovalRefusal({ status: "review" })).toBe("task has no pending MCP approval request");
    expect(mcpApprovalRefusal({ status: "review", pendingMcpApproval: { server: "s", tool: "t", args: {}, reason: "r" } })).toBeUndefined();
    expect(cardSettingsRefusal({ status: "dispatched" }, "tools")).toBe("task is dispatched; change its tools once it stops");
    expect(cardSettingsRefusal({ status: "inbox" }, "harness")).toBeUndefined();
  });
});

describe("task actions", () => {
  // The merge itself (gate, ff landing, every refusal, done + mergedSha)
  // runs against real git in test/merge-path.test.ts.
  test("mergeTask: 404, 409 without a worktree", async () => {
    const board = new SqliteBoard();
    expect(await mergeTask(board, "nope", gitRunner)).toEqual({ ok: false, status: 404, error: "not found" });
    const bare = await reviewCard(board, false);
    expect(await mergeTask(board, bare.id, gitRunner)).toEqual({ ok: false, status: 409, error: "task has no worktree to merge" });
  });

  test("discardTask: removes the worktree and moves to failed", async () => {
    const board = new SqliteBoard();
    const t = await reviewCard(board);
    runs.length = 0;
    const out = await discardTask(board, t.id, gitRunner);
    expect(out.ok && out.value).toMatchObject({ discarded: true, task: { status: "failed" } });
    expect(runs).toContainEqual(["git", "worktree", "remove", "--force", join(dir, "wt")]);
  });

  test("abandonEscalation, approveMcpRequest, denyMcpRequest refuse the wrong state with 400", async () => {
    const board = new SqliteBoard();
    const t = await board.create({ title: "T", body: "", labels: ["docs"] });
    expect(await abandonEscalation(board, t)).toEqual({ ok: false, status: 400, error: "task is not escalated" });
    expect(await approveMcpRequest(board, t)).toEqual({ ok: false, status: 400, error: "task has no pending MCP approval request" });
    expect(await denyMcpRequest(board, t)).toEqual({ ok: false, status: 400, error: "task has no pending MCP approval request" });

    const esc = await board.escalate(t.id, "why");
    expect((await abandonEscalation(board, esc)).ok && (await board.get(t.id))!.status).toBe("failed");

    const asks = await board.create({ title: "Post", body: "", labels: ["docs"] });
    const waiting = await board.requestMcpApproval(asks.id, { server: "slack", tool: "post", args: { a: 1 }, reason: "r" });
    const approved = await approveMcpRequest(board, waiting);
    expect(approved.ok && approved.value).toMatchObject({ title: "Approved MCP call: slack/post", mcpAccessOverride: [{ server: "slack", tools: ["post"] }] });
    expect((await board.get(asks.id))!).toMatchObject({ status: "done", supersededBy: approved.ok ? approved.value.id : "" });

    const asks2 = await board.create({ title: "Post 2", body: "", labels: ["docs"] });
    const denied = await denyMcpRequest(board, await board.requestMcpApproval(asks2.id, { server: "slack", tool: "post", args: {}, reason: "r" }));
    expect(denied.ok && denied.value.status).toBe("failed");
  });

  test("setAllowedTools: 409 while running, 400 without a list or for a bad grant, else stored", async () => {
    const board = new SqliteBoard();
    const t = await board.create({ title: "T", body: "", labels: ["code"] });
    expect(await setAllowedTools(board, t, undefined)).toEqual({ ok: false, status: 400, error: "body needs extraAllowedTools (a list; [] clears)" });
    expect((await setAllowedTools(board, t, ["Bash(*)"])).ok).toBe(false);
    const ok = await setAllowedTools(board, t, ["Bash(npm test:*)"]);
    expect(ok.ok && ok.value.extraAllowedTools).toEqual(["Bash(npm test:*)"]);
    const running = await board.move(t.id, "running");
    expect(await setAllowedTools(board, running, [])).toEqual({ ok: false, status: 409, error: "task is running; change its tools once it stops" });
  });

  test("setTaskHarnessOverride: sets, clears with null, refuses an unknown harness or a running card", async () => {
    const board = new SqliteBoard();
    const pool = HarnessPool.from([{ id: "codex", tool: "codex-cli", label: "Codex", enabled: true }]);
    const t = await board.create({ title: "T", body: "", labels: ["code"] });
    const set = await setTaskHarnessOverride(board, pool, t, "codex");
    expect(set.ok && set.value.harnessOverride).toBe("codex");
    expect((await board.get(t.id))!.harnessOverride).toBe("codex");
    const cleared = await setTaskHarnessOverride(board, pool, t, null);
    expect(cleared.ok && cleared.value.harnessOverride).toBeUndefined();
    expect((await board.get(t.id))!.harnessOverride).toBeUndefined();
    expect(await setTaskHarnessOverride(board, pool, t, "nope")).toEqual({ ok: false, status: 400, error: 'unknown harness "nope"' });
    expect(await setTaskHarnessOverride(board, pool, t, undefined)).toEqual({ ok: false, status: 400, error: "body needs harness (a harness id, or null to clear)" });
    const running = await board.move(t.id, "running");
    expect((await setTaskHarnessOverride(board, pool, running, "codex")).ok).toBe(false);
  });
});

describe("harness and MCP actions", () => {
  const harnessDeps = async (authOk: boolean): Promise<HarnessControlDeps & { swept: number }> => {
    const path = join(await mkdtemp(join(dir, "h-")), "harnesses.yaml");
    const cache = join(dir, `models-${Math.random()}.json`);
    await writeFile(cache, JSON.stringify({ a: { models: ["m1", "m2"], refreshedAt: "2026-10-11T00:00:00Z" } }));
    const deps = {
      harnesses: HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false }]),
      harnessesPath: path,
      harnessRunner: (async () => ({ stdout: JSON.stringify({ loggedIn: authOk }), stderr: "", exitCode: 0 })) as CommandRunner,
      modelsCachePath: cache,
      swept: 0,
      afterEnable: () => {
        deps.swept++;
      },
    };
    return deps;
  };

  test("enableHarness re-checks auth: 409 and stays disabled when not signed in", async () => {
    const deps = await harnessDeps(false);
    expect(await enableHarness(deps, deps.harnesses.get("a")!)).toEqual({ ok: false, status: 409, error: "still not authenticated" });
    expect(deps.harnesses.get("a")!).toMatchObject({ enabled: false, disabledReason: "not authenticated" });
    expect(deps.swept).toBe(0);
  });

  test("enableHarness persists, flips the pool and sweeps; disableHarness persists and flips back", async () => {
    const deps = await harnessDeps(true);
    expect((await enableHarness(deps, deps.harnesses.get("a")!)).ok).toBe(true);
    expect(deps.harnesses.get("a")!.enabled).toBe(true);
    expect(deps.swept).toBe(1);
    expect((parse(await readFile(deps.harnessesPath, "utf8")) as { harnesses: { id: string; enabled: boolean }[] }).harnesses.find((h) => h.id === "a")!.enabled).toBe(true);
    expect((await disableHarness(deps, deps.harnesses.get("a")!)).ok).toBe(true);
    expect(deps.harnesses.get("a")!.enabled).toBe(false);
  });

  test("setHarnessDefaultModel refuses a model outside the cached list and clears with undefined", async () => {
    const deps = await harnessDeps(true);
    const h = deps.harnesses.get("a")!;
    expect(await setHarnessDefaultModel(deps, h, "m9")).toEqual({ ok: false, status: 400, error: 'model "m9" is not in the known model list for harness "a"' });
    expect((await setHarnessDefaultModel(deps, h, "m2")).ok && deps.harnesses.get("a")!.model).toBe("m2");
    expect((await setHarnessDefaultModel(deps, h, undefined)).ok && deps.harnesses.get("a")!.model).toBeUndefined();
  });

  test("MCP: enable re-checks reachability, disable persists, trust validates tool and value", async () => {
    const mcpDeps = (reachable: boolean): McpControlDeps => ({
      mcpServers: McpServerPool.from([{ id: "jira", label: "Jira", transport: { kind: "http", url: "http://jira.invalid" }, tools: [{ name: "search", trust: "auto" }], enabled: false }]),
      mcpServersPath: join(dir, `mcp-${Math.random()}.yaml`),
      reachability: { fetchImpl: (async () => (reachable ? new Response(null, { status: 200 }) : Promise.reject(new Error("refused")))) as unknown as typeof fetch },
    });
    const down = mcpDeps(false);
    const refused = await enableMcpServer(down, down.mcpServers.get("jira")!);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.status).toBe(409);

    const up = mcpDeps(true);
    expect((await enableMcpServer(up, up.mcpServers.get("jira")!)).ok && up.mcpServers.get("jira")!.enabled).toBe(true);
    expect((await disableMcpServer(up, up.mcpServers.get("jira")!)).ok && up.mcpServers.get("jira")!.enabled).toBe(false);
    expect(await setMcpToolTrust(up, up.mcpServers.get("jira")!, "nope", "auto")).toEqual({ ok: false, status: 404, error: "not found" });
    expect(await setMcpToolTrust(up, up.mcpServers.get("jira")!, "search", "always")).toEqual({ ok: false, status: 400, error: 'trust must be "auto" or "approval-required", got "always"' });
    const trusted = await setMcpToolTrust(up, up.mcpServers.get("jira")!, "search", "approval-required");
    expect(trusted.ok && trusted.value.tools).toEqual([{ name: "search", trust: "approval-required" }]);
  });
});

describe("POST /tasks/:id/harness", () => {
  test("sets and clears a card's harness; 404, 400 and 409 like the other card settings", async () => {
    const board = new SqliteBoard();
    const app = createApp(board, await Registry.load(), undefined, { harnesses: HarnessPool.from([{ id: "codex", tool: "codex-cli", label: "Codex", enabled: true }]) });
    const post = (path: string, body: unknown) => app(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const t = await board.create({ title: "T", body: "", labels: ["code"] });

    const set = await post(`/tasks/${t.id}/harness`, { harness: "codex" });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { harnessOverride?: string }).harnessOverride).toBe("codex");
    expect((await post(`/tasks/${t.id}/harness`, { harness: null })).status).toBe(200);
    expect((await board.get(t.id))!.harnessOverride).toBeUndefined();
    expect((await post(`/tasks/${t.id}/harness`, { harness: "nope" })).status).toBe(400);
    expect((await post(`/tasks/${t.id}/harness`, {})).status).toBe(400);
    expect((await post("/tasks/nope/harness", { harness: "codex" })).status).toBe(404);
    await board.move(t.id, "running");
    expect((await post(`/tasks/${t.id}/harness`, { harness: "codex" })).status).toBe(409);
  });
});
