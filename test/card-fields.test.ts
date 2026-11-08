import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";

// docs/SDD-coordinator.md §3.3: key, round, pr and workstreamId on a card.

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}
const post = (path: string, body: unknown) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => req(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function makeApp() {
  const board = new SqliteBoard();
  const registry = await Registry.load();
  return { app: createApp(board, registry), board };
}

const pr = { number: 41, url: "https://github.com/acme/shop/pull/41", head: "wissel/a4-round-2" };
const base = { title: "A4: card keys", body: "b", labels: ["intake"], repo: "r" };

test("board: create round-trips key, round, pr and workstreamId; all undefined when omitted", async () => {
  const board = new SqliteBoard();
  const card = await board.create({ ...base, key: "A4", round: 2, pr, workstreamId: "ws-1" });
  expect(card).toMatchObject({ key: "A4", round: 2, pr, workstreamId: "ws-1" });
  expect(await board.get(card.id)).toEqual(card);

  const bare = await board.create(base);
  const fetched = (await board.get(bare.id))!;
  expect(fetched.key).toBeUndefined();
  expect(fetched.round).toBeUndefined();
  expect(fetched.pr).toBeUndefined();
  expect(fetched.workstreamId).toBeUndefined();
});

test("board: updateFields sets and clears the new fields", async () => {
  const board = new SqliteBoard();
  const card = await board.create(base);
  const set = await board.updateFields(card.id, { key: "A4", round: 1, pr, workstreamId: "ws-1" });
  expect(set).toMatchObject({ key: "A4", round: 1, pr, workstreamId: "ws-1" });
  const cleared = await board.updateFields(card.id, { key: undefined, round: undefined, pr: undefined, workstreamId: undefined });
  expect(cleared.key).toBeUndefined();
  expect(cleared.round).toBeUndefined();
  expect(cleared.pr).toBeUndefined();
  expect(cleared.workstreamId).toBeUndefined();
});

test("board: opens and heals a pre-existing on-disk DB from before the §3.3 columns existed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-legacy-"));
  const dbPath = join(dir, "board.sqlite");
  try {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        routedTo TEXT,
        dependsOn TEXT NOT NULL DEFAULT '[]'
      );
    `);
    legacy.run("INSERT INTO tasks (id, title, body, labels, repo, status) VALUES ('old', 'old card', '', '[]', 'r', 'inbox')");
    legacy.close();

    const board = new SqliteBoard(dbPath);
    const old = (await board.get("old"))!;
    expect(old.key).toBeUndefined();
    expect(old.pr).toBeUndefined();
    const card = await board.create({ ...base, key: "A4", round: 1, pr, workstreamId: "ws-1" });
    expect(await board.get(card.id)).toMatchObject({ key: "A4", round: 1, pr, workstreamId: "ws-1" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /tasks accepts the fields and GET /tasks, GET /tasks/:id return them", async () => {
  const { app } = await makeApp();
  const res = await app(post("/tasks", { ...base, key: "A4", round: 2, pr, workstreamId: "ws-1" }));
  expect(res.status).toBe(201);
  const created = (await res.json()) as { id: string };
  const expected = { id: created.id, key: "A4", round: 2, pr, workstreamId: "ws-1" };
  expect(created).toMatchObject(expected);
  expect(await (await app(req(`/tasks/${created.id}`))).json()).toMatchObject(expected);
  const list = (await (await app(req("/tasks"))).json()) as { id: string }[];
  expect(list.find((t) => t.id === created.id)).toMatchObject(expected);
});

test("POST /tasks refuses a key already used in the same workstream; other workstreams and no workstream are not checked", async () => {
  const { app } = await makeApp();
  expect((await app(post("/tasks", { ...base, key: "A4", workstreamId: "ws-1" }))).status).toBe(201);
  const dup = await app(post("/tasks", { ...base, key: "A4", workstreamId: "ws-1" }));
  expect(dup.status).toBe(400);
  const { error } = (await dup.json()) as { error: string };
  expect(error).toContain('key "A4"');
  expect(error).toContain('workstream "ws-1"');
  expect((await app(post("/tasks", { ...base, key: "A4", workstreamId: "ws-2" }))).status).toBe(201);
  expect((await app(post("/tasks", { ...base, key: "A4" }))).status).toBe(201);
  expect((await app(post("/tasks", { ...base, key: "A4" }))).status).toBe(201);
});

test("PATCH /tasks/:id sets and clears the fields, keeps a card's own key, and refuses another card's key", async () => {
  const { app, board } = await makeApp();
  const a = (await (await app(post("/tasks", { ...base, key: "A4", workstreamId: "ws-1" }))).json()) as { id: string };
  const b = (await (await app(post("/tasks", base))).json()) as { id: string };

  const set = await app(patch(`/tasks/${b.id}`, { key: "B1", round: 1, pr, workstreamId: "ws-1" }));
  expect(set.status).toBe(200);
  expect(await board.get(b.id)).toMatchObject({ key: "B1", round: 1, pr, workstreamId: "ws-1" });

  // Re-sending its own key, or editing something else, is not a duplicate.
  expect((await app(patch(`/tasks/${a.id}`, { key: "A4", title: "A4: renamed" }))).status).toBe(200);
  expect((await app(patch(`/tasks/${a.id}`, { body: "new body" }))).status).toBe(200);

  const dup = await app(patch(`/tasks/${b.id}`, { key: "A4" }));
  expect(dup.status).toBe(400);
  expect(((await dup.json()) as { error: string }).error).toContain('key "A4"');
  expect((await board.get(b.id))!.key).toBe("B1");

  // Moving into a workstream where the key is taken is a duplicate too.
  const c = (await (await app(post("/tasks", { ...base, key: "A4", workstreamId: "ws-2" }))).json()) as { id: string };
  expect((await app(patch(`/tasks/${c.id}`, { workstreamId: "ws-1" }))).status).toBe(400);

  const cleared = await app(patch(`/tasks/${b.id}`, { key: null, round: null, pr: null, workstreamId: null }));
  expect(cleared.status).toBe(200);
  const after = (await board.get(b.id))!;
  expect(after.key).toBeUndefined();
  expect(after.round).toBeUndefined();
  expect(after.pr).toBeUndefined();
  expect(after.workstreamId).toBeUndefined();
});

test("POST and PATCH refuse a malformed key, round, pr or workstreamId", async () => {
  const { app } = await makeApp();
  const card = (await (await app(post("/tasks", base))).json()) as { id: string };
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ key: "" }, /key/],
    [{ key: "  " }, /key/],
    [{ key: 4 }, /key/],
    [{ round: 0 }, /round/],
    [{ round: 1.5 }, /round/],
    [{ round: "2" }, /round/],
    [{ pr: { number: 1, url: "u" } }, /pr/],
    [{ pr: { number: "1", url: "u", head: "h" } }, /pr/],
    [{ pr: "41" }, /pr/],
    [{ workstreamId: "" }, /workstreamId/],
    [{ workstreamId: 7 }, /workstreamId/],
  ];
  for (const [fields, message] of bad) {
    const created = await app(post("/tasks", { ...base, ...fields }));
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toMatch(message);
    const edited = await app(patch(`/tasks/${card.id}`, fields));
    expect(edited.status).toBe(400);
    expect(((await edited.json()) as { error: string }).error).toMatch(message);
  }
});
