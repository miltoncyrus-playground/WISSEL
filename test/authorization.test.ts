import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorizationLog, describeAction, OWNER_PRINCIPAL_ID, withAuthorizationRecords } from "../src/services/authorization.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";

function fixedClock(start = Date.parse("2026-11-26T12:00:00Z")) {
  let t = start;
  return () => new Date((t += 1000));
}

describe("AuthorizationLog", () => {
  test("ensureOwner creates one stable owner principal", () => {
    const log = new AuthorizationLog(new Database(":memory:"));
    const a = log.ensureOwner("milton");
    const b = log.ensureOwner("someone-else");
    expect(a.id).toBe(OWNER_PRINCIPAL_ID);
    expect(b).toEqual(a);
    expect(a.handle).toBe("milton");
    expect(a.kind).toBe("person");
  });

  test("a record is written queued before the action and completed once after", () => {
    const log = new AuthorizationLog(new Database(":memory:"), fixedClock());
    const rec = log.begin({ action: { kind: "card.start", target: "/tasks" }, principalId: "owner", via: "direct" });
    expect(log.get(rec.id)?.outcome).toBe("queued");
    expect(log.get(rec.id)?.completedAt).toBeUndefined();
    log.complete(rec.id, "allowed", { effect: { taskId: "t1" } });
    const done = log.get(rec.id)!;
    expect(done.outcome).toBe("allowed");
    expect(done.effect).toEqual({ taskId: "t1" });
    expect(done.completedAt).toBeDefined();
  });

  test("the log is append-only: a finished record cannot change and no record can be deleted", () => {
    const db = new Database(":memory:");
    const log = new AuthorizationLog(db);
    const rec = log.begin({ action: { kind: "card.start", target: "/tasks" }, principalId: "owner", via: "direct" });
    log.complete(rec.id, "allowed");
    expect(() => log.complete(rec.id, "failed")).toThrow(/already completed/);
    expect(() => db.run("DELETE FROM authorization_records")).toThrow(/append-only/);
    expect(log.get(rec.id)?.outcome).toBe("allowed");
  });

  test("list is newest first and filters by principal, task and kind", () => {
    const log = new AuthorizationLog(new Database(":memory:"), fixedClock());
    const a = log.begin({ action: { kind: "card.start", target: "/tasks" }, principalId: "owner", via: "direct", effect: { taskId: "t1" } });
    const b = log.begin({ action: { kind: "POST /tasks/:id/merge", target: "t1" }, principalId: "owner", via: "direct" });
    const c = log.begin({ action: { kind: "POST /tasks/:id/run", target: "t2" }, principalId: "other", via: "policy" });
    expect(log.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(log.list({ principalId: "other" }).map((r) => r.id)).toEqual([c.id]);
    expect(log.list({ taskId: "t1" }).map((r) => r.id)).toEqual([b.id, a.id]);
    expect(log.list({ kind: "card.start" }).map((r) => r.id)).toEqual([a.id]);
    expect(log.list({ limit: 1 })).toHaveLength(1);
  });
});

describe("describeAction", () => {
  test("names card creation as card.start and templates ids", () => {
    expect(describeAction("POST", "/tasks")).toEqual({ kind: "card.start", target: "/tasks" });
    const id = "1a2b3c4d-0000-4000-8000-000000000001";
    expect(describeAction("POST", `/tasks/${id}/merge`)).toEqual({ kind: "POST /tasks/:id/merge", target: id, taskId: id });
    expect(describeAction("POST", "/harnesses/claude-work/enable")).toEqual({ kind: "POST /harnesses/:id/enable", target: "claude-work" });
    expect(describeAction("DELETE", `/tasks/${id}`).kind).toBe("DELETE /tasks/:id");
  });
});

describe("withAuthorizationRecords", () => {
  const log = () => new AuthorizationLog(new Database(":memory:"), fixedClock());
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  test("reads pass straight through with no record", async () => {
    const l = log();
    const f = withAuthorizationRecords(() => ok([]), l, { principalFor: () => "owner" });
    await f(new Request("http://x/tasks"));
    expect(l.list()).toEqual([]);
  });

  test("the record exists before the action runs", async () => {
    const l = log();
    let seen: string | undefined;
    const f = withAuthorizationRecords(() => {
      seen = l.list()[0]?.outcome;
      return ok({ id: "t9" });
    }, l, { principalFor: () => "owner" });
    await f(new Request("http://x/tasks", { method: "POST", body: "{}" }));
    expect(seen).toBe("queued");
  });

  test("a created card is attributed and named in the effect", async () => {
    const l = log();
    const attributed: Array<[string, string]> = [];
    const f = withAuthorizationRecords(() => ok({ id: "t9" }, 201), l, { principalFor: () => "owner", onCardCreated: (id, p) => attributed.push([id, p]) });
    await f(new Request("http://x/tasks", { method: "POST", body: "{}" }));
    expect(attributed).toEqual([["t9", "owner"]]);
    expect(l.list()[0]).toMatchObject({ action: { kind: "card.start" }, outcome: "allowed", principalId: "owner", via: "direct", effect: { taskId: "t9" } });
  });

  test("outcomes follow the response: 4xx/5xx failed, 401/403 denied, a throw failed", async () => {
    const l = log();
    await withAuthorizationRecords(() => ok({ error: "nope" }, 409), l, { principalFor: () => "owner" })(new Request("http://x/tasks/t1/merge", { method: "POST" }));
    await withAuthorizationRecords(() => ok({}, 403), l, { principalFor: () => "owner" })(new Request("http://x/tasks/t1/run", { method: "POST" }));
    const boom = withAuthorizationRecords(() => { throw new Error("kaput"); }, l, { principalFor: () => "owner" });
    await expect(boom(new Request("http://x/tasks/t1/run", { method: "POST" }))).rejects.toThrow("kaput");
    const [thrown, denied, failed] = l.list();
    expect(failed).toMatchObject({ outcome: "failed", reason: '{"error":"nope"}' });
    expect(denied?.outcome).toBe("denied");
    expect(thrown).toMatchObject({ outcome: "failed", reason: "kaput" });
  });

  test("no unrecorded writes: if the record cannot be written, the action does not run", async () => {
    const db = new Database(":memory:");
    const l = new AuthorizationLog(db);
    db.run("DROP TABLE authorization_records");
    let ran = false;
    const f = withAuthorizationRecords(() => { ran = true; return ok({}); }, l, { principalFor: () => "owner" });
    const res = await f(new Request("http://x/tasks", { method: "POST" }));
    expect(res.status).toBe(503);
    expect(ran).toBe(false);
  });
});

describe("task attribution", () => {
  test("attribute stamps creator and authorizer once and never moves them", async () => {
    const board = new SqliteBoard(":memory:");
    const t = await board.create({ title: "x", body: "", labels: [] });
    board.attribute(t.id, "owner");
    board.attribute(t.id, "someone-else");
    const got = await board.get(t.id);
    expect(got?.createdByPrincipalId).toBe("owner");
    expect(got?.authorizedByPrincipalId).toBe("owner");
  });

  test("a spawned card inherits its parent's authority but has no creator", async () => {
    const board = new SqliteBoard(":memory:");
    const parent = await board.create({ title: "p", body: "", labels: [] });
    board.attribute(parent.id, "owner");
    const child = await board.create({ title: "Review: p", body: "", labels: [], parentTaskId: parent.id });
    const got = await board.get(child.id);
    expect(got?.authorizedByPrincipalId).toBe("owner");
    expect(got?.createdByPrincipalId).toBeUndefined();
  });

  test("an on-disk database from before these columns heals on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-authz-"));
    try {
      const path = join(dir, "board.sqlite");
      const first = new SqliteBoard(path);
      const t = await first.create({ title: "old", body: "", labels: [] });
      first.db.run("ALTER TABLE tasks DROP COLUMN createdByPrincipalId");
      first.db.run("ALTER TABLE tasks DROP COLUMN authorizedByPrincipalId");
      first.db.close();
      const healed = new SqliteBoard(path);
      healed.attribute(t.id, "owner");
      const again = await healed.create({ title: "new", body: "", labels: [] });
      expect((await healed.get(t.id))?.createdByPrincipalId).toBe("owner");
      expect((await healed.get(again.id))?.title).toBe("new");
      healed.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GET /audit and GET /me", () => {
  test("through the real app: a card created over HTTP is attributed and its record is readable", async () => {
    const board = new SqliteBoard(":memory:");
    const log = new AuthorizationLog(board.db);
    const owner = log.ensureOwner("milton");
    const registry = await Registry.load();
    const principalFor = () => owner.id;
    const app = withAuthorizationRecords(createApp(board, registry, undefined, { authorization: { log, principalFor } }), log, {
      principalFor,
      onCardCreated: (id, p) => board.attribute(id, p),
    });

    const created = await app(new Request("http://x/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Audit me", body: "x", labels: ["code"], repo: "." }) }));
    expect(created.ok).toBe(true);
    const id = ((await created.json()) as { id: string }).id;
    expect((await board.get(id))?.authorizedByPrincipalId).toBe("owner");

    const audit = (await (await app(new Request(`http://x/audit?task=${id}`))).json()) as Array<{ action: { kind: string }; outcome: string; principalId: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: { kind: "card.start" }, outcome: "allowed", principalId: "owner" });

    const me = (await (await app(new Request("http://x/me"))).json()) as { principal: { handle: string } };
    expect(me.principal.handle).toBe("milton");
  });

  test("without the authorization option the routes do not exist", async () => {
    const app = createApp(new SqliteBoard(":memory:"), await Registry.load(), undefined, {});
    expect((await app(new Request("http://x/audit"))).status).toBe(404);
  });
});
