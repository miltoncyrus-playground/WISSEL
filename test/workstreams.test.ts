import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import { SqliteWorkstreamStore, validateNewWorkstream, validateRoleChange, validateWorkstreamPatch, type Workstream } from "../src/services/workstreams.ts";

// Workstreams and roles (docs/SDD-coordinator.md §3.1, §4.13, §5): a
// workstream groups projects, each with a role; only the owner changes a
// role, through a confirm step, and the change is recorded with a time.

const P1 = "11111111-1111-4000-8000-000000000001";
const P2 = "22222222-2222-4000-8000-000000000002";
const EMPTY = { decideAlone: [], mustAsk: [], never: [] };

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

test("validateNewWorkstream: name required, projects need a known role, lists default empty, chat is not accepted", () => {
  const ok = validateNewWorkstream({ name: "checkout redesign", ticket: "SHOP-12", projects: [{ projectId: P1, role: "follow", decider: "Ana" }] });
  expect(ok).toEqual({ ok: true, workstream: { name: "checkout redesign", ticket: "SHOP-12", projects: [{ projectId: P1, role: "follow", decider: "Ana", ...EMPTY }] } });
  const body = {
    name: "w",
    spec: { repo: "/r", path: "docs/spec.md" },
    channel: { adapter: "file", target: "/tmp/c.jsonl" },
    quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Amsterdam" },
    digests: [{ cron: "0 9 * * 1-5", timezone: "Europe/Amsterdam" }],
    projects: [{ projectId: P1, role: "decide", decideAlone: ["naming"], mustAsk: ["schema"], never: ["pr.arm"] }],
  };
  expect(validateNewWorkstream(body)).toEqual({ ok: true, workstream: body as never });
  const badProjects = [[{ role: "follow" }], [{ projectId: P1 }], [{ projectId: P1, role: "boss" }], [{ projectId: P1, role: "follow", never: [1] }], [{ projectId: P1, role: "follow" }, { projectId: P1, role: "decide" }]];
  for (const bad of [
    ...[undefined, null, {}, { name: " " }, { name: "w", projects: "x" }],
    ...badProjects.map((projects) => ({ name: "w", projects })),
    ...[{ spec: { repo: "/r" } }, { quietHours: { start: "22:00" } }, { digests: [{ cron: "" }] }, { chat: { adapter: "slack", channel: "#x" } }].map((f) => ({ name: "w", ...f })),
  ]) {
    expect(validateNewWorkstream(bad).ok).toBe(false);
  }
});

test("validateWorkstreamPatch and validateRoleChange: partial patch with null clearing; confirm:true is the confirm step", () => {
  expect(validateWorkstreamPatch({ name: "renamed", ticket: null, digests: [] })).toEqual({ ok: true, patch: { name: "renamed", ticket: null, digests: [] } });
  for (const bad of [undefined, {}, { name: "" }, { name: null }, { projects: [] }, { unknown: 1 }, { chat: null }]) expect(validateWorkstreamPatch(bad).ok).toBe(false);

  expect(validateRoleChange({ confirm: true, role: "decide" })).toEqual({ ok: true, change: { role: "decide" } });
  expect(validateRoleChange({ confirm: true, role: "shadow", decider: "Bo", decideAlone: ["a"], never: ["pr.arm"] })).toEqual({ ok: true, change: { role: "shadow", decider: "Bo", decideAlone: ["a"], never: ["pr.arm"] } });
  const unconfirmed = validateRoleChange({ role: "decide" });
  expect(unconfirmed).toMatchObject({ ok: false, error: expect.stringContaining("confirm") });
  for (const bad of [undefined, { confirm: "yes", role: "decide" }, { confirm: true }, { confirm: true, role: "owner" }, { confirm: true, role: "decide", decider: 3 }, { confirm: true, role: "decide", never: "x" }]) {
    expect(validateRoleChange(bad).ok).toBe(false);
  }
});

test("store: create, get, list in creation order, update, delete, and a role change stamped with its time", async () => {
  const store = new SqliteWorkstreamStore(new SqliteBoard().db);
  const a = await store.create({ name: "a", projects: [{ projectId: P1, role: "shadow", ...EMPTY }] });
  const b = await store.create({ name: "b", projects: [] });
  expect(a.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(await store.get(a.id)).toEqual(a);
  expect(await store.get("nope")).toBeUndefined();
  expect((await store.list()).map((w) => w.name)).toEqual(["a", "b"]);

  const renamed = await store.update(a.id, { name: "a2", ticket: "T-1", quietHours: { start: "22:00", end: "07:00", timezone: "UTC" } });
  expect(renamed).toMatchObject({ id: a.id, name: "a2", ticket: "T-1", createdAt: a.createdAt, projects: a.projects });
  const cleared = await store.update(a.id, { ticket: null, quietHours: null });
  expect(cleared.ticket).toBeUndefined();
  expect(cleared.quietHours).toBeUndefined();
  await expect(store.update("nope", { name: "x" })).rejects.toThrow(/workstream not found/);

  const before = Date.now();
  const changed = await store.setRole(a.id, P1, { role: "decide", decider: "Ana", never: ["pr.arm"] });
  const entry = changed.projects[0]!;
  expect(entry).toMatchObject({ projectId: P1, role: "decide", decider: "Ana", decideAlone: [], mustAsk: [], never: ["pr.arm"] });
  expect(Date.parse(entry.roleChangedAt!)).toBeGreaterThanOrEqual(before - 1000);
  // Lists and decider not named are kept.
  const kept = await store.setRole(a.id, P1, { role: "follow", mustAsk: ["schema"] });
  expect(kept.projects[0]).toMatchObject({ role: "follow", decider: "Ana", mustAsk: ["schema"], never: ["pr.arm"] });
  await expect(store.setRole(a.id, P2, { role: "follow" })).rejects.toThrow(/not in workstream/);
  await expect(store.setRole("nope", P1, { role: "follow" })).rejects.toThrow(/workstream not found/);

  await store.delete(a.id);
  expect(await store.get(a.id)).toBeUndefined();
  expect((await store.list()).map((w) => w.id)).toEqual([b.id]);
  await expect(store.delete(a.id)).rejects.toThrow(/workstream not found/);
});

test("API: /workstreams CRUD, projects must exist, and a role change needs confirm:true", async () => {
  const board = new SqliteBoard();
  const projects = new SqliteProjectStore(board.db);
  const dir = `${process.env.TMPDIR ?? "/tmp"}/wissel-ws-${Math.random().toString(36).slice(2)}`;
  await Bun.write(`${dir}/.keep`, "");
  const added = await projects.addLocalProject(dir, { initGit: false }, async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  if ("error" in added) throw new Error(added.error);
  const project = added.project;
  const app = createApp(board, await Registry.load(), undefined, { projects });

  expect((await app(req("/workstreams", "POST", { projects: [] }))).status).toBe(400);
  const unknown = await app(req("/workstreams", "POST", { name: "w", projects: [{ projectId: P2, role: "follow" }] }));
  expect(unknown.status).toBe(400);
  expect(await unknown.json()).toMatchObject({ error: expect.stringContaining(P2) });

  const created = await app(req("/workstreams", "POST", { name: "checkout", projects: [{ projectId: project.id, role: "shadow" }] }));
  expect(created.status).toBe(201);
  const ws = (await created.json()) as Workstream;
  expect(ws.projects).toEqual([{ projectId: project.id, role: "shadow", ...EMPTY }]);
  expect(await (await app(req("/workstreams"))).json()).toEqual([ws]);
  expect(await (await app(req(`/workstreams/${ws.id}`))).json()).toEqual(ws);
  expect((await app(req("/workstreams/nope"))).status).toBe(404);

  const patched = await app(req(`/workstreams/${ws.id}`, "PATCH", { name: "checkout redesign", ticket: "SHOP-1" }));
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ name: "checkout redesign", ticket: "SHOP-1", projects: ws.projects });
  expect((await app(req(`/workstreams/${ws.id}`, "PATCH", { projects: [] }))).status).toBe(400);
  expect((await app(req("/workstreams/nope", "PATCH", { name: "x" }))).status).toBe(404);

  // The confirm step: without confirm:true the role stays as it was.
  const refused = await app(req(`/workstreams/${ws.id}/projects/${project.id}/role`, "POST", { role: "decide" }));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: expect.stringContaining("confirm") });
  expect(((await (await app(req(`/workstreams/${ws.id}`))).json()) as Workstream).projects[0]!.role).toBe("shadow");

  const changed = await app(req(`/workstreams/${ws.id}/projects/${project.id}/role`, "POST", { confirm: true, role: "decide", decider: "Ana" }));
  expect(changed.status).toBe(200);
  const after = (await changed.json()) as Workstream;
  expect(after.projects[0]).toMatchObject({ role: "decide", decider: "Ana", roleChangedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
  expect((await app(req(`/workstreams/${ws.id}/projects/${P2}/role`, "POST", { confirm: true, role: "decide" }))).status).toBe(404);
  expect((await app(req(`/workstreams/nope/projects/${project.id}/role`, "POST", { confirm: true, role: "decide" }))).status).toBe(404);

  expect((await app(req(`/workstreams/${ws.id}`, "DELETE"))).status).toBe(204);
  expect((await app(req(`/workstreams/${ws.id}`))).status).toBe(404);
  expect((await app(req(`/workstreams/${ws.id}`, "DELETE"))).status).toBe(404);
});
