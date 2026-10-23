import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard, type BoardEvent } from "../src/services/board.ts";
import { editRefusal } from "../src/services/board-actions.ts";
import { Registry } from "../src/core/registry.ts";

// PATCH /tasks/:id and GET /tasks?live=1, docs/SDD-card-edit.md.

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}
const post = (path: string, body: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => req(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function makeApp() {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  return { app: createApp(board, registry), board };
}

async function newCard(app: (r: Request) => Promise<Response>, over: Record<string, unknown> = {}) {
  const res = await app(post("/tasks", { title: "Jira card", body: "first body", labels: ["intake"], repo: "r", ...over }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; title: string; body: string; labels: string[]; repo?: string; mergeTarget?: string; harnessOverride?: string };
}

test("PATCH changes title, body, labels and mergeTarget on a queued card, and the board shows it", async () => {
  const { app, board } = await makeApp();
  const card = await newCard(app);
  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => events.push(e));

  const res = await app(patch(`/tasks/${card.id}`, { title: "ABC-940: edited", body: "second body", labels: ["intake", "extra"], mergeTarget: "spec/ABC-940-spec" }));
  expect(res.status).toBe(200);
  const updated = (await res.json()) as typeof card;
  expect(updated).toMatchObject({ id: card.id, title: "ABC-940: edited", body: "second body", labels: ["intake", "extra"], mergeTarget: "spec/ABC-940-spec", repo: "r" });

  const stored = await board.get(card.id);
  expect(stored).toMatchObject({ title: "ABC-940: edited", mergeTarget: "spec/ABC-940-spec", status: "inbox" });
  expect(events.map((e) => e.type)).toContain("task.updated");
});

test("PATCH changes only the keys it names", async () => {
  const { app, board } = await makeApp();
  const card = await newCard(app, { mergeTarget: "spec/a" });
  await app(patch(`/tasks/${card.id}`, { body: "only the body" }));
  expect(await board.get(card.id)).toMatchObject({ title: "Jira card", body: "only the body", labels: ["intake"], repo: "r", mergeTarget: "spec/a" });
});

test("PATCH with null clears an optional field", async () => {
  const { app, board } = await makeApp();
  const card = await newCard(app, { mergeTarget: "spec/a" });
  const res = await app(patch(`/tasks/${card.id}`, { mergeTarget: null }));
  expect(res.status).toBe(200);
  expect((await board.get(card.id))?.mergeTarget).toBeUndefined();
});

test("PATCH refuses a bad body: unknown field, empty, not an object, wrong type, empty title", async () => {
  const { app } = await makeApp();
  const card = await newCard(app);
  const bad: [unknown, RegExp][] = [
    [{ status: "done" }, /can't edit status/],
    [{ routedTo: "implementer", title: "x" }, /can't edit routedTo/],
    [{}, /names no field/],
    [[1], /JSON object/],
    ["not json", /JSON object/],
    [{ labels: "intake" }, /labels must be a list of strings/],
    [{ title: "" }, /title can't be empty/],
    [{ body: 5 }, /body must be a string/],
  ];
  for (const [body, message] of bad) {
    const res = await app(patch(`/tasks/${card.id}`, body));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(message);
  }
});

test("PATCH runs the same checks as creating a card: a bad mergeTarget and an edit that would need a repo are refused", async () => {
  const { app, board } = await makeApp();
  const card = await newCard(app);
  const badTarget = await app(patch(`/tasks/${card.id}`, { mergeTarget: "a b" }));
  expect(badTarget.status).toBe(400);
  expect(((await badTarget.json()) as { error: string }).error).toContain("mergeTarget");

  // Labels that route to a write-tier agent, with the repo cleared in the
  // same edit: creation refuses that card, so the edit does too.
  const needsRepo = await app(patch(`/tasks/${card.id}`, { labels: ["code", "python"], repo: null }));
  expect(needsRepo.status).toBe(400);
  // Nothing changed on a refused edit.
  expect(await board.get(card.id)).toMatchObject({ labels: ["intake"], repo: "r" });
});

test("PATCH is refused once a card is running, archived or replaced, and 404s on an unknown id", async () => {
  const { app, board } = await makeApp();

  const running = await newCard(app);
  await board.move(running.id, "running");
  const r1 = await app(patch(`/tasks/${running.id}`, { title: "x" }));
  expect(r1.status).toBe(409);
  expect(((await r1.json()) as { error: string }).error).toContain("running");

  const archived = await newCard(app);
  await board.move(archived.id, "done");
  await board.archive(archived.id);
  expect((await app(patch(`/tasks/${archived.id}`, { title: "x" }))).status).toBe(409);

  const old = await newCard(app);
  const next = await newCard(app);
  await board.setSupersededBy(old.id, next.id);
  const r3 = await app(patch(`/tasks/${old.id}`, { title: "x" }));
  expect(r3.status).toBe(409);
  expect(((await r3.json()) as { error: string }).error).toContain("replaced");

  expect((await app(patch("/tasks/no-such-id", { title: "x" }))).status).toBe(404);
});

test("editRefusal: queued and unrouted is the only editable state", () => {
  expect(editRefusal({ status: "inbox" })).toBeUndefined();
  expect(editRefusal({ status: "ready" })).toBeUndefined();
  expect(editRefusal({ status: "inbox", routedTo: "implementer" })).toContain("routed");
  expect(editRefusal({ status: "review" })).toContain("review");
  expect(editRefusal({ status: "inbox", archivedAt: "2026-10-21T00:00:00Z" })).toContain("archived");
  expect(editRefusal({ status: "inbox", supersededBy: "x" })).toContain("replaced");
});

test("GET /tasks?live=1 hides archived cards and cards replaced by a later attempt; without it everything shows", async () => {
  const { app, board } = await makeApp();
  const keep = await newCard(app, { title: "keep" });
  const archived = await newCard(app, { title: "archived" });
  const replaced = await newCard(app, { title: "replaced" });
  const later = await newCard(app, { title: "later attempt" });
  await board.move(archived.id, "done");
  await board.archive(archived.id);
  await board.setSupersededBy(replaced.id, later.id);

  const all = (await (await app(req("/tasks"))).json()) as { id: string }[];
  expect(all.map((t) => t.id).sort()).toEqual([keep.id, archived.id, replaced.id, later.id].sort());

  const live = (await (await app(req("/tasks?live=1"))).json()) as { id: string }[];
  expect(live.map((t) => t.id).sort()).toEqual([keep.id, later.id].sort());
  expect(((await (await app(req("/tasks?live=true"))).json()) as unknown[]).length).toBe(2);
});
