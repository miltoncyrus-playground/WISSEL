import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard, type BoardEvent } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, type OrchestratorOptions } from "../src/core/orchestrator.ts";
import { createCommandStartConditionChecker, filesNamedIn, findOverlaps, validateWaitsFor, type StartConditionChecker } from "../src/core/start-conditions.ts";
import type { AgentDef, Executor, StartCondition, TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.8: start conditions (TaskCard.waitsFor) and overlap warnings.

const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const base = { title: "t", body: "", labels: ["intake"], repo: "/repo/shop" };
const prMerged: StartCondition = { kind: "pr-merged", repo: "/repo/shop", number: 41 };
const pathOnMain: StartCondition = { kind: "path-on-main", repo: "/repo/shop", path: "src/a.ts" };

async function setup(seen: string[], opts?: OrchestratorOptions) {
  const executor: Executor = {
    id: "fake-readonly",
    harnessTool: "claude-cli",
    canHandle: (agent: AgentDef) => agent.tier === "readonly",
    run: async (task, agent) => (seen.push(task.id), { taskId: task.id, agentId: agent.id, ok: true, summary: "x" }),
  };
  const board = new SqliteBoard();
  const registry = await Registry.load();
  return { board, orchestrator: new Orchestrator(board, registry, new Router(registry), [executor], undefined, opts) };
}

function fakeChecker(state: { merged: boolean; onMain: boolean }, calls: string[]): StartConditionChecker {
  return {
    prMerged: async (repo, number) => (calls.push(`pr ${repo} ${number}`), state.merged),
    pathOnMain: async (repo, path) => (calls.push(`path ${repo} ${path}`), state.onMain),
  };
}

// ---------- validation ----------

test("validateWaitsFor accepts the three kinds, drops extra keys, and treats undefined/[] as none", () => {
  const ok = validateWaitsFor([{ kind: "card-done", cardId: "c1", extra: 1 }, prMerged, pathOnMain]);
  expect(ok).toEqual({ ok: true, waitsFor: [{ kind: "card-done", cardId: "c1" }, prMerged, pathOnMain] });
  expect(validateWaitsFor(undefined)).toEqual({ ok: true, waitsFor: undefined });
  expect(validateWaitsFor([])).toEqual({ ok: true, waitsFor: undefined });
});

test("validateWaitsFor refuses a non-list, an unknown kind and a malformed condition", () => {
  const bad = [
    "card-done", { kind: "card-done", cardId: "c1" }, [{ kind: "card-done" }], [{ kind: "card-done", cardId: " " }], [null],
    [{ kind: "pr-merged", repo: "/r", number: 0 }], [{ kind: "pr-merged", repo: "", number: 1 }], [{ kind: "path-on-main", repo: "/r" }], [{ kind: "label-added" }],
  ];
  for (const value of bad) {
    const check = validateWaitsFor(value);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toStartWith("waitsFor must be a list of");
  }
});

// ---------- board ----------

test("board round-trips waitsFor through create and updateFields, and heals a DB from before the column", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, labels TEXT NOT NULL, repo TEXT NOT NULL, status TEXT NOT NULL, routedTo TEXT, dependsOn TEXT NOT NULL DEFAULT '[]');");
    legacy.run("INSERT INTO tasks (id, title, body, labels, repo, status) VALUES ('old', 'old card', '', '[]', 'r', 'inbox')");
    legacy.close();

    const board = new SqliteBoard(dbPath);
    expect((await board.get("old"))!.waitsFor).toBeUndefined();
    const card = await board.create({ ...base, waitsFor: [prMerged] });
    expect((await board.get(card.id))!.waitsFor).toEqual([prMerged]);
    expect((await board.create(base)).waitsFor).toBeUndefined();
    expect((await board.updateFields(card.id, { waitsFor: [pathOnMain] })).waitsFor).toEqual([pathOnMain]);
    expect((await board.updateFields(card.id, { waitsFor: undefined })).waitsFor).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- sweep ----------

test("sweep skips a card until the card it waits for is done, like dependsOn", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup(seen);
  const b = await board.create({ ...base, title: "b" });
  const a = await board.create({ ...base, title: "a", waitsFor: [{ kind: "card-done", cardId: b.id }] });
  await orchestrator.sweep();
  expect(seen).toEqual([b.id]);
  expect((await board.get(a.id))!.status).toBe("inbox");
  await orchestrator.sweep();
  expect(seen).toEqual([b.id, a.id]);
});

test("sweep holds a card on pr-merged and path-on-main until the checker says both hold; no checker means hold", async () => {
  const seen: string[] = [];
  const state = { merged: false, onMain: false };
  const calls: string[] = [];
  const { board, orchestrator } = await setup(seen, { startConditions: fakeChecker(state, calls) });
  const card = await board.create({ ...base, waitsFor: [prMerged, pathOnMain] });

  await orchestrator.sweep();
  expect(seen).toEqual([]);
  expect(calls).toEqual(["pr /repo/shop 41"]); // stops at the first unmet condition
  state.merged = true;
  await orchestrator.sweep();
  expect(seen).toEqual([]);
  expect(calls.slice(1)).toEqual(["pr /repo/shop 41", "path /repo/shop src/a.ts"]);
  state.onMain = true;
  await orchestrator.sweep();
  expect(seen).toEqual([card.id]);
  expect((await board.get(card.id))!.waitsFor).toEqual([prMerged, pathOnMain]); // kept on the card

  const bare = await setup([], {});
  const held = await bare.board.create({ ...base, waitsFor: [prMerged] });
  await bare.orchestrator.sweep();
  expect((await bare.board.get(held.id))!.status).toBe("inbox");
});

test("the command checker asks gh for the PR state and git for the path on main, never writing", async () => {
  const argv: string[][] = [];
  let out = { stdout: "", exitCode: 0 };
  const checker = createCommandStartConditionChecker(async (cmd, opts) => (argv.push([opts.cwd, ...cmd]), { ...out, stderr: "" }));

  out = { stdout: '{"state":"MERGED"}', exitCode: 0 };
  expect(await checker.prMerged("/repo/shop", 41)).toBe(true);
  expect(argv[0]).toEqual(["/repo/shop", "gh", "pr", "view", "41", "--json", "state"]);
  out = { stdout: '{"state":"OPEN"}', exitCode: 0 };
  expect(await checker.prMerged("/repo/shop", 41)).toBe(false);
  out = { stdout: "", exitCode: 1 };
  expect(await checker.prMerged("/repo/shop", 41)).toBe(false);

  out = { stdout: "src/a.ts\n", exitCode: 0 };
  expect(await checker.pathOnMain("/repo/shop", "src/a.ts")).toBe(true);
  expect(argv[3]).toEqual(["/repo/shop", "git", "ls-tree", "--name-only", "origin/main", "--", "src/a.ts"]);
  out = { stdout: "", exitCode: 0 };
  expect(await checker.pathOnMain("/repo/shop", "src/a.ts")).toBe(false);
});

// ---------- overlap ----------

test("filesNamedIn lists the paths a body names, once each, and skips URLs and prose abbreviations", () => {
  const body = "Edit `src/services/board.ts` and src/core/types.ts (see ./docs/SDD-coordinator.md, §4.8, e.g. README.md).\nNot https://example.com/a/b.ts; src/core/types.ts again.";
  expect(filesNamedIn(body)).toEqual(["src/services/board.ts", "src/core/types.ts", "docs/SDD-coordinator.md", "README.md"]);
});

test("findOverlaps names the open cards and PRs in the same repo that touch the same files", () => {
  const me: TaskCard = { id: "me", title: "A", body: "change src/a.ts and src/b.ts", labels: [], repo: "/r", status: "inbox" };
  const b = (id: string, title: string, extra: Partial<TaskCard>): TaskCard => ({ id, title, body: "src/b.ts", labels: [], repo: "/r", status: "inbox", ...extra });
  const others: TaskCard[] = [
    { id: "o1", title: "B", body: "also src/a.ts", labels: [], repo: "/r", status: "running", pr: { number: 7, url: "u", head: "h" } },
    b("o2", "C", { status: "done" }), b("o3", "D", { repo: "/other" }), b("o4", "E", { archivedAt: "2026-11-01T00:00:00Z" }), b("o5", "F", { status: "review" }), me,
  ];
  expect(findOverlaps(me, others)).toEqual([{ file: "src/a.ts", taskId: "o1", title: "B", pr: 7 }, { file: "src/b.ts", taskId: "o5", title: "F" }]);
});

test("a starting card with an overlap emits task.overlap with the warning list and still runs", async () => {
  const seen: string[] = [];
  const { board, orchestrator } = await setup(seen);
  const other = await board.create({ ...base, title: "other", body: "touch src/a.ts" });
  await board.move(other.id, "running");
  const card = await board.create({ ...base, title: "mine", body: "edit src/a.ts too" });
  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => void (e.type === "task.overlap" && events.push(e)));

  await orchestrator.sweep();
  expect(seen).toEqual([card.id]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "task.overlap", task: { id: card.id }, warnings: [{ file: "src/a.ts", taskId: other.id, title: "other" }] });
});

// ---------- API ----------

test("POST /tasks validates waitsFor and stores it; POST /tasks/:id/waits-for sets, clears and refuses", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, await Registry.load());
  const bad = await app(post("/tasks", { ...base, waitsFor: [{ kind: "pr-merged", repo: "/r" }] }));
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toStartWith("waitsFor must be a list of");

  const created = await app(post("/tasks", { ...base, waitsFor: [prMerged] }));
  expect(created.status).toBe(201);
  const card = (await created.json()) as TaskCard;
  expect((await board.get(card.id))!.waitsFor).toEqual([prMerged]);

  const self = await app(post(`/tasks/${card.id}/waits-for`, { waitsFor: [{ kind: "card-done", cardId: card.id }] }));
  expect(self.status).toBe(400);
  const set = await app(post(`/tasks/${card.id}/waits-for`, { waitsFor: [pathOnMain] }));
  expect(set.status).toBe(200);
  expect((await board.get(card.id))!.waitsFor).toEqual([pathOnMain]);
  const cleared = await app(post(`/tasks/${card.id}/waits-for`, { waitsFor: null }));
  expect(cleared.status).toBe(200);
  expect((await board.get(card.id))!.waitsFor).toBeUndefined();
  expect((await app(post("/tasks/nope/waits-for", { waitsFor: [] }))).status).toBe(404);
});
