import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { AuthorizationLog, withAuthorizationRecords } from "../src/services/authorization.ts";
import { PolicyRevisions } from "../src/services/policy-revision.ts";
import { WorkstreamStore, workstreamCheck } from "../src/services/workstreams.ts";

// docs/SDD-coordinator.md §3.1, §4.13, phase 3 card 12: workstreams, the
// role of each project in one, and the rule that only the owner changes a
// role, with a confirm step, as a policy change.

const known = (id: string) => ["p1", "p2"].includes(id);
const FULL = {
  name: "Checkout redesign",
  ticket: "SHOP-12",
  projects: [{ projectId: "p1", role: "follow", decider: "Dana", decideAlone: ["triage-red"], mustAsk: ["pr.arm"], never: ["chat.post"] }],
  channel: { adapter: "claude-docs", target: "https://claude.ai/artifact/x" },
  quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Madrid" },
  digests: [{ cron: "0 9 * * 1-5", timezone: "Europe/Madrid" }],
};

describe("validation", () => {
  test("a full workstream is accepted and normalised; each bad field is named", () => {
    const ok = workstreamCheck(FULL, known);
    expect(ok.ok && ok.input.projects).toEqual([{ projectId: "p1", role: "follow", decider: "Dana", decideAlone: ["triage-red"], mustAsk: ["pr.arm"], never: ["chat.post"] }]);
    const bad = (over: object) => {
      const r = workstreamCheck({ ...FULL, ...over }, known);
      return r.ok ? "accepted" : r.error;
    };
    expect(bad({ projects: [{ projectId: "p9", role: "follow" }] })).toContain("no such project");
    expect(bad({ projects: [{ projectId: "p1", role: "boss" }] })).toContain("role must be one of");
    expect(bad({ projects: [{ projectId: "p1", role: "decide", decideAlone: ["plan-batch"], mustAsk: ["plan-batch"] }] })).toContain("both decided alone and always asked");
    expect(bad({ projects: [{ projectId: "p1", role: "decide", never: ["rm -rf"] }] })).toContain("never must list");
    expect(bad({ projects: [{ projectId: "p1", role: "decide" }, { projectId: "p1", role: "follow" }] })).toContain("listed twice");
    expect(bad({ quietHours: { start: "25:00", end: "07:00", timezone: "Europe/Madrid" } })).toContain("quietHours");
    expect(bad({ quietHours: { start: "22:00", end: "07:00", timezone: "Mars/Olympus" } })).toContain("not a timezone");
    expect(bad({ digests: [{ cron: "@daily", timezone: "UTC" }] })).toContain("digests");
    expect(bad({ owner: "me" })).toContain('unknown workstream field "owner"');
    expect(workstreamCheck({ name: "x" }, known).ok).toBe(false);
    expect(workstreamCheck({ name: "renamed" }, known, true)).toEqual({ ok: true, input: { name: "renamed" } });
  });
});

describe("the store", () => {
  test("a project is in one workstream; PATCH can't change a role; setRole previews, then changes on confirm", () => {
    const store = new WorkstreamStore(new SqliteBoard().db);
    const a = store.create({ name: "A", projects: [{ projectId: "p1", role: "follow", decideAlone: [], mustAsk: [], never: [] }] });
    expect(a.ok).toBe(true);
    const id = a.ok ? a.workstream.id : "";
    expect(store.create({ name: "B", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }] })).toEqual({ ok: false, error: 'project p1 is already in workstream "A"' });
    expect(store.update(id, { projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }] })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("/role") });
    expect(store.update(id, { projects: [{ projectId: "p1", role: "follow", decideAlone: [], mustAsk: [], never: [] }, { projectId: "p2", role: "shadow", decideAlone: [], mustAsk: [], never: [] }] }).ok).toBe(true);
    expect(store.setRole(id, "p1", "decide", undefined)).toMatchObject({ ok: true, changed: false, from: "follow", to: "decide" });
    expect(store.get(id)!.projects[0]!.role).toBe("follow");
    expect(store.setRole(id, "p1", "decide", true)).toMatchObject({ ok: true, changed: true });
    expect(store.get(id)!.projects[0]!.role).toBe("decide");
    expect(store.forProject("p2")?.id).toBe(id);
    expect(store.setRole(id, "p9", "decide", true)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("the API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-workstreams-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function setup(principal = "owner") {
    const board = new SqliteBoard();
    const log = new AuthorizationLog(board.db);
    log.ensureOwner("me");
    const policy = new PolicyRevisions(board.db);
    const inner = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), authorization: { log, principalFor: () => principal, policy } });
    const app = withAuthorizationRecords(inner, log, { principalFor: () => principal, policy });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
      const text = await r.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        parsed = { text };
      }
      return { status: r.status, body: parsed };
    };
    const projectIds: string[] = [];
    for (const name of ["shop", "api"]) {
      const repo = join(dir, name);
      mkdirSync(repo);
      Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
      projectIds.push(((await call("POST", "/projects/local", { path: repo })).body as { id: string }).id);
    }
    return { board, call, policy, projectIds, repos: [join(dir, "shop"), join(dir, "api")] };
  }

  test("create, read, edit and delete; every write is a policy revision", async () => {
    const { call, policy, projectIds } = await setup();
    const made = await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId: projectIds[0], role: "follow" }] });
    expect(made.status).toBe(201);
    const id = made.body!.id as string;
    expect(policy.current()).toBe("r1");
    expect((await call("GET", "/workstreams")).body).toHaveLength(1);
    expect((await call("PATCH", `/workstreams/${id}`, { name: "Checkout v2" })).body!.name).toBe("Checkout v2");
    expect(policy.current()).toBe("r2");
    expect((await call("DELETE", `/workstreams/${id}`)).status).toBe(204);
    expect(policy.current()).toBe("r3");
    expect((await call("GET", `/workstreams/${id}`)).status).toBe(404);
  });

  test("a role change: a preview changes nothing and bumps nothing; confirm changes it as a policy revision", async () => {
    const { call, policy, projectIds } = await setup();
    const id = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId: projectIds[0], role: "follow" }] })).body!.id as string;
    const preview = await call("POST", `/workstreams/${id}/projects/${projectIds[0]}/role`, { role: "decide" });
    expect(preview).toMatchObject({ status: 409, body: { confirmRequired: true, from: "follow", to: "decide" } });
    expect(policy.current()).toBe("r1");
    const done = await call("POST", `/workstreams/${id}/projects/${projectIds[0]}/role`, { role: "decide", confirm: true });
    expect(done.status).toBe(200);
    expect((done.body!.projects as Array<{ role: string }>)[0]!.role).toBe("decide");
    expect(policy.current()).toBe("r2");
  });

  test("only the owner changes a role", async () => {
    const someone = await setup("alice");
    const wsId = (await someone.call("POST", "/workstreams", { name: "Other", projects: [{ projectId: someone.projectIds[0], role: "follow" }] })).body!.id as string;
    const r = await someone.call("POST", `/workstreams/${wsId}/projects/${someone.projectIds[0]}/role`, { role: "decide", confirm: true });
    expect(r).toMatchObject({ status: 403, body: { error: "only the owner changes a role" } });
  });

  test("cards: a workstream must exist; a key is unique across the workstream's projects; open cards keep it from being deleted", async () => {
    const { call, projectIds, repos } = await setup();
    const id = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId: projectIds[0], role: "follow" }, { projectId: projectIds[1], role: "follow" }] })).body!.id as string;
    const card = (body: object) => call("POST", "/tasks", { title: "t", body: "", labels: [], ...body });
    expect((await card({ repo: repos[0], workstreamId: "nope" })).status).toBe(400);
    expect((await card({ repo: repos[0], workstreamId: id, key: "A4" })).status).toBe(201);
    const clash = await card({ repo: repos[1], workstreamId: id, key: "A4" });
    expect(clash).toMatchObject({ status: 400, body: { error: expect.stringContaining("in this workstream") } });
    expect((await card({ repo: repos[1], key: "A4" })).status).toBe(201);
    expect((await call("DELETE", `/workstreams/${id}`)).status).toBe(409);
    const tasks = (await call("GET", "/tasks")).body as unknown as Array<{ workstreamId?: string }>;
    expect(tasks.filter((t) => t.workstreamId === id)).toHaveLength(1);
  });
});
