import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import type { AgentDef, Executor, TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import type { GateCommandRunner } from "../src/services/merge-gate.ts";
import { deriveNeedsYou, ownerTaskNeedsYou } from "../src/services/needs-you.ts";
import { completeOwnerTask, SqliteOwnerTaskStore, validateNewOwnerTask, type OwnerTask } from "../src/services/owner-tasks.ts";

// Owner tasks (docs/SDD-coordinator.md §3.4, §5): work only Milton can
// do, kept in the board database, shown in Needs a human, holding the
// cards they block until Done, which runs the task's check first.

const A = "aaaaaaaa-1111-4000-8000-000000000001";
const B = "bbbbbbbb-2222-4000-8000-000000000002";

function req(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? undefined : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function fakeRunner(exitCode: number, output = "", timedOut = false): GateCommandRunner & { calls: { argv: string[]; timeoutMs: number }[] } {
  const calls: { argv: string[]; timeoutMs: number }[] = [];
  const runner: GateCommandRunner = async (argv, opts) => {
    calls.push({ argv, timeoutMs: opts.timeoutMs });
    return { exitCode: timedOut ? null : exitCode, output, timedOut };
  };
  return Object.assign(runner, { calls });
}

test("validateNewOwnerTask: title and why required, steps/check/blocks are string arrays", () => {
  expect(validateNewOwnerTask({ title: "Log in to gh", why: "PR pushes need it" })).toMatchObject({ ok: true, task: { title: "Log in to gh", why: "PR pushes need it", steps: [], blocks: [] } });
  const full = validateNewOwnerTask({ title: "t", why: "w", steps: ["a", "b"], check: ["gh", "auth", "status"], blocks: [A] });
  expect(full).toMatchObject({ ok: true, task: { steps: ["a", "b"], check: ["gh", "auth", "status"], blocks: [A] } });
  for (const bad of [undefined, null, "x", {}, { title: "t" }, { title: " ", why: "w" }, { title: "t", why: "w", steps: "a" }, { title: "t", why: "w", check: [] }, { title: "t", why: "w", check: ["", "x"] }, { title: "t", why: "w", blocks: [1] }]) {
    expect(validateNewOwnerTask(bad).ok).toBe(false);
  }
});

test("store: create, list open first, get, setStatus, and the cards open tasks hold", async () => {
  const store = new SqliteOwnerTaskStore(new SqliteBoard().db);
  const t1 = await store.create({ title: "one", why: "w", steps: ["s"], blocks: [A] });
  const t2 = await store.create({ title: "two", why: "w", steps: [], check: ["true"], blocks: [B] });
  expect(t1.status).toBe("open");
  expect(await store.get(t1.id)).toEqual(t1);
  expect(await store.get("nope")).toBeUndefined();
  expect((await store.list()).map((t) => t.id)).toEqual([t1.id, t2.id]);
  expect(await store.heldCardIds()).toEqual(new Set([A, B]));
  const done = await store.setStatus(t1.id, "done");
  expect(done.status).toBe("done");
  await store.setStatus(t2.id, "dismissed");
  expect(await store.heldCardIds()).toEqual(new Set());
  expect((await store.list()).map((t) => t.status)).toEqual(["done", "dismissed"]);
  await expect(store.setStatus("nope", "done")).rejects.toThrow(/owner task not found/);
});

test("completeOwnerTask: no check marks done; a passing check marks done; a failing or timed-out check leaves it open with the output", async () => {
  const store = new SqliteOwnerTaskStore(new SqliteBoard().db);
  const plain = await store.create({ title: "p", why: "w", steps: [], blocks: [] });
  expect(await completeOwnerTask(store, plain.id, { runner: fakeRunner(1, "never called"), cwd: "/tmp" })).toMatchObject({ ok: true, value: { status: "done" } });

  const checked = await store.create({ title: "c", why: "w", steps: [], check: ["gh", "auth", "status"], blocks: [] });
  const failing = fakeRunner(1, "You are not logged into any GitHub hosts.\n");
  const failed = await completeOwnerTask(store, checked.id, { runner: failing, cwd: "/tmp" });
  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.status).toBe(409);
    expect(failed.error).toContain("exited 1");
    expect(failed.output).toContain("not logged into");
  }
  expect(failing.calls).toEqual([{ argv: ["gh", "auth", "status"], timeoutMs: 60_000 }]);
  expect((await store.get(checked.id))!.status).toBe("open");

  const slow = await completeOwnerTask(store, checked.id, { runner: fakeRunner(0, "", true), cwd: "/tmp" });
  expect(slow.ok).toBe(false);
  if (!slow.ok) expect(slow.error).toContain("timed out");
  expect((await store.get(checked.id))!.status).toBe("open");

  const passed = await completeOwnerTask(store, checked.id, { runner: fakeRunner(0, "Logged in\n"), cwd: "/tmp" });
  expect(passed).toMatchObject({ ok: true, value: { id: checked.id, status: "done" } });
  expect(await completeOwnerTask(store, "nope", { runner: fakeRunner(0), cwd: "/tmp" })).toMatchObject({ ok: false, status: 404 });
});

test("needs-you: an open owner task is a human item with its why and steps; a held card points at it", () => {
  const owner: OwnerTask = { id: "o1", title: "Log in to gh", why: "Pushing a PR needs a logged-in gh.", steps: ["Run gh auth login", "Pick HTTPS"], check: ["gh", "auth", "status"], blocks: [A], status: "open" };
  const ny = ownerTaskNeedsYou(owner);
  expect(ny).toMatchObject({ kind: "owner-task", lane: "human", value: "owner-task:o1", line: "Log in to gh", why: owner.why });
  expect(ny.checklist).toEqual(["Run gh auth login", "Pick HTTPS", "Done runs: gh auth status"]);
  expect(ny.action).toEqual({ label: "Done", href: "/owner-tasks/o1/done", method: "POST" });
  expect(ownerTaskNeedsYou({ ...owner, steps: [], check: undefined }).checklist).toEqual(["Do it, then press Done"]);

  const card: TaskCard = { id: A, title: "Open the PR", body: "", labels: [], status: "inbox" };
  const held = deriveNeedsYou(card, { byId: new Map([[A, card]]), hasWorktree: () => false, heldBy: [owner] })!;
  expect(held).toMatchObject({ kind: "held", lane: "next-step", value: "held:o1", line: "Waiting for you: Log in to gh" });
  expect(held.action).toEqual({ label: "Done", href: "/owner-tasks/o1/done", method: "POST" });
  expect(deriveNeedsYou(card, { byId: new Map([[A, card]]), hasWorktree: () => false, heldBy: [{ ...owner, status: "done" }] })).toBeUndefined();
});

test("orchestrator: a card an open owner task blocks is not routed until the task is done", async () => {
  const board = new SqliteBoard();
  const store = new SqliteOwnerTaskStore(board.db);
  const seen: string[] = [];
  const executor: Executor = {
    id: "fake-readonly",
    harnessTool: "claude-cli",
    canHandle: (agent: AgentDef) => agent.tier === "readonly",
    run: async (task, agent) => {
      seen.push(task.id);
      return { taskId: task.id, agentId: agent.id, ok: true, summary: "x" };
    },
  };
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), [executor], undefined, { heldCardIds: () => store.heldCardIds() });
  const card = await board.create({ title: "Review the schema", body: "read only", labels: ["review"] });
  const owner = await store.create({ title: "o", why: "w", steps: [], blocks: [card.id] });
  await orchestrator.sweep();
  expect(seen).toEqual([]);
  await store.setStatus(owner.id, "done");
  await orchestrator.sweep();
  expect(seen).toEqual([card.id]);
});

test("API: GET/POST /owner-tasks and POST /owner-tasks/:id/done; held cards show it in GET /tasks", async () => {
  const board = new SqliteBoard();
  const runner = fakeRunner(1, "not logged in");
  const app = createApp(board, await Registry.load(), undefined, { ownerTaskCheckRunner: runner });
  const card = await board.create({ title: "Open the PR", body: "", labels: [] });

  expect((await app(req("/owner-tasks", { title: "x" }))).status).toBe(400);
  const created = await app(req("/owner-tasks", { title: "Log in to gh", why: "PRs need it", steps: ["gh auth login"], check: ["gh", "auth", "status"], blocks: [card.id] }));
  expect(created.status).toBe(201);
  const owner = (await created.json()) as OwnerTask & { needsYou: { kind: string } };
  expect(owner.status).toBe("open");
  expect(owner.needsYou.kind).toBe("owner-task");

  const listed = (await (await app(req("/owner-tasks"))).json()) as (OwnerTask & { needsYou?: unknown })[];
  expect(listed.map((t) => t.id)).toEqual([owner.id]);
  expect(listed[0]!.needsYou).toBeDefined();

  const tasks = (await (await app(req("/tasks"))).json()) as TaskCard[];
  expect(tasks[0]!.needsYou).toMatchObject({ kind: "held", value: `held:${owner.id}` });

  const refused = await app(req(`/owner-tasks/${owner.id}/done`, {}));
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("exited 1"), output: "not logged in" });
  expect(runner.calls[0]!.argv).toEqual(["gh", "auth", "status"]);

  runner.calls.length = 0;
  const passing = createApp(board, await Registry.load(), undefined, { ownerTaskCheckRunner: fakeRunner(0, "ok") });
  const done = await passing(req(`/owner-tasks/${owner.id}/done`, {}));
  expect(done.status).toBe(200);
  expect(((await done.json()) as OwnerTask).status).toBe("done");
  const after = (await (await passing(req("/tasks"))).json()) as TaskCard[];
  expect(after[0]!.needsYou).toBeUndefined();
  expect((await passing(req("/owner-tasks/nope/done", {}))).status).toBe(404);
});
