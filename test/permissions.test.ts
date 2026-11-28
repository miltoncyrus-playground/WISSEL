import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthorizationLog, OWNER_PRINCIPAL_ID, withAuthorizationRecords } from "../src/services/authorization.ts";
import { IdentityStore } from "../src/services/identity.ts";
import { GrantStore, matchRoute, PERMISSIONS, requirementFor, WRITE_ROUTES, type Place } from "../src/services/permissions.ts";
import { wasPermitted, withPermissions } from "../src/api/permission-door.ts";
import { principalOf, withIdentityRoutes, withSignIn } from "../src/api/sign-in.ts";

// docs/SDD-identity-and-permissions.md §3.3, §4.3, §4.8, §6, §8; build
// plan card 6: one check, denied by default; grants by scope.

/** Every write route src/api/server.ts handles, as a concrete request. */
const SERVER_WRITES: [string, string][] = [
  ["POST", "/tasks"], ["PATCH", "/tasks/t1"], ["DELETE", "/tasks/t1"],
  ...["move", "depends-on", "decision", "result", "run", "harness", "not-before", "hold", "release", "allowed-tools", "pr", "re-review", "merge", "close", "discard", "override", "archive", "unarchive"].map((a): [string, string] => ["POST", `/tasks/t1/${a}`]),
  ...["approve", "abandon", "retry", "grant-and-retry"].map((a): [string, string] => ["POST", `/tasks/t1/escalation/${a}`]),
  ["POST", "/tasks/t1/mcp-approval/approve"], ["POST", "/tasks/t1/mcp-approval/deny"],
  ["POST", "/owner-tasks"], ["POST", "/owner-tasks/o1/done"], ["POST", "/owner-tasks/o1/dismiss"],
  ["POST", "/pipelines"], ["PUT", "/pipelines/p1"], ["DELETE", "/pipelines/p1"], ["POST", "/pipelines/p1/run"],
  ["POST", "/schedules"], ["PATCH", "/schedules/s1"], ["DELETE", "/schedules/s1"], ["POST", "/schedules/s1/run-now"],
  ["POST", "/projects/local"], ["POST", "/projects/clone"], ["DELETE", "/projects/p1"], ["POST", "/projects/p1/merge-gate"], ["POST", "/projects/p1/settings"],
  ["POST", "/harnesses/h1/enable"], ["POST", "/harnesses/h1/disable"], ["POST", "/harnesses/h1/model"],
  ["POST", "/mcp-servers"], ["POST", "/mcp-servers/m1/enable"], ["POST", "/mcp-servers/m1/disable"], ["POST", "/mcp-servers/m1/tools/search/trust"],
  ["POST", "/tickets/ABC-1/comment"], ["POST", "/tickets/ABC-1/transition"],
  ["POST", "/ask"], ["POST", "/ask/actions/a1/confirm"], ["POST", "/ask/actions/a1/cancel"], ["POST", "/ask/c1/audio"], ["POST", "/voice"], ["POST", "/route/preview"],
  ["POST", "/workstreams"], ["PATCH", "/workstreams/w1"], ["DELETE", "/workstreams/w1"], ["POST", "/workstreams/w1/projects/p1/role"], ["POST", "/workstreams/w1/duties/claims"],
  ...["import", "digest", "actions"].map((a): [string, string] => ["POST", `/workstreams/w1/${a}`]),
  ["POST", "/workstreams/w1/owner-comments/read"], ["POST", "/workstreams/w1/channel/flush"], ["POST", "/workstreams/w1/decisions/start"],
  ["POST", "/decisions/d1/flip"], ["POST", "/inbox"], ["POST", "/lessons/k1/approve"], ["POST", "/lessons/k1/reject"],
  ["POST", "/admin/shadow"], ["POST", "/admin/restart-when-idle"], ["DELETE", "/admin/restart-when-idle"], ["POST", "/admin/pr-watch"],
  ["POST", "/members"], ["POST", "/members/m1/disable"], ["POST", "/members/m1/tokens"], ["POST", "/members/m1/grants"], ["DELETE", "/grants/g1"],
  ["POST", "/tokens"], ["DELETE", "/tokens/t1"], ["POST", "/auth/logout"],
];

describe("the route table", () => {
  test("every write route the server handles declares what it needs", () => {
    const missing = SERVER_WRITES.filter(([m, p]) => !matchRoute(m, p)).map(([m, p]) => `${m} ${p}`);
    expect(missing).toEqual([]);
    for (const rule of WRITE_ROUTES) {
      expect(rule.needs === "self" || (rule.needs.length > 0 && rule.needs.every((p) => (PERMISSIONS as readonly string[]).includes(p)))).toBe(true);
    }
  });

  test("an undeclared write is the owner's alone; reads need board.read, the audit audit.read", () => {
    expect(requirementFor("POST", "/something-new").needs).toBe("owner");
    expect(requirementFor("GET", "/tasks").needs).toEqual(["board.read"]);
    expect(requirementFor("GET", "/audit").needs).toEqual(["audit.read"]);
    expect(requirementFor("GET", "/me").needs).toBe("self");
  });
});

function store() {
  const db = new Database(":memory:");
  const log = new AuthorizationLog(db);
  log.ensureOwner("milton");
  const identity = new IdentityStore(db);
  const grants = new GrantStore(db);
  const person = (h: string) => (identity.addPerson(h, h) as { principal: { id: string } }).principal.id;
  return { db, log, identity, grants, person };
}

describe("grants", () => {
  test("the owner can do anything; others hold what their grants say, by scope", () => {
    const { grants, person } = store();
    const dana = person("dana");
    expect(grants.can(OWNER_PRINCIPAL_ID, "host.admin")).toBe(true);
    expect(grants.can(dana, "board.read")).toBe(false);
    grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "instance" }, ["board.read"]);
    grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "workstream", id: "w1" }, ["card.merge"]);
    grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "project", id: "p9" }, ["project.settings"]);
    expect(grants.can(dana, "board.read")).toBe(true);
    expect(grants.can(dana, "card.merge", { workstreamId: "w1", projectId: "p1" })).toBe(true);
    expect(grants.can(dana, "card.merge", { workstreamId: "w2" })).toBe(false);
    expect(grants.can(dana, "card.merge")).toBe(false);
    expect(grants.can(dana, "project.settings", { projectId: "p9" })).toBe(true);
    expect(grants.can(dana, "project.settings", { projectId: "p1" })).toBe(false);
  });

  test("a workstream owner grants within their workstream, only what they hold, never at instance", () => {
    const { grants, person } = store();
    const lead = person("lead");
    const dev = person("dev");
    grants.grant(OWNER_PRINCIPAL_ID, lead, { kind: "workstream", id: "w1" }, ["member.manage", "card.run", "card.merge"]);
    expect(grants.grant(lead, dev, { kind: "workstream", id: "w1" }, ["card.run"])).toMatchObject({ ok: true });
    expect(grants.grant(lead, dev, { kind: "workstream", id: "w1" }, ["host.admin"])).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("host.admin") });
    expect(grants.grant(lead, dev, { kind: "workstream", id: "w2" }, ["card.run"])).toMatchObject({ ok: false, status: 403 });
    expect(grants.grant(lead, dev, { kind: "instance" }, ["card.run"])).toMatchObject({ ok: false, status: 403 });
    expect(grants.grant(dev, lead, { kind: "workstream", id: "w1" }, ["card.run"])).toMatchObject({ ok: false, status: 403 });
    // Revoking needs member.manage at the grant's scope too.
    const g = (grants.grant(lead, dev, { kind: "workstream", id: "w1" }, ["card.merge"]) as { grant: { id: string } }).grant;
    expect(grants.revoke(dev, g.id)).toMatchObject({ ok: false, status: 403 });
    expect(grants.revoke(lead, g.id)).toMatchObject({ ok: true });
    expect(grants.can(dev, "card.merge", { workstreamId: "w1" })).toBe(false);
  });

  test("host.admin and member.manage at instance scope come only from the owner", () => {
    const { grants, person } = store();
    const admin = person("admin");
    const other = person("other");
    grants.grant(OWNER_PRINCIPAL_ID, admin, { kind: "instance" }, ["member.manage", "host.admin", "board.read"]);
    expect(grants.grant(admin, other, { kind: "instance" }, ["board.read"])).toMatchObject({ ok: true });
    expect(grants.grant(admin, other, { kind: "instance" }, ["host.admin"])).toMatchObject({ ok: false, error: expect.stringContaining("only the owner") });
  });

  test("an agent principal never holds a grant, over random inputs", () => {
    const { grants, db } = store();
    db.run("INSERT INTO principals (id, kind, handle, display, createdAt) VALUES ('agent1', 'agent', 'card-1', 'card', '2026-11-28T00:00:00Z')");
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let i = 0; i < 500; i++) {
      const perms = Array.from({ length: 1 + rand(4) }, () => PERMISSIONS[rand(PERMISSIONS.length)]!);
      const scope = [{ kind: "instance" }, { kind: "workstream", id: `w${rand(3)}` }, { kind: "project", id: `p${rand(3)}` }][rand(3)];
      expect(grants.grant(OWNER_PRINCIPAL_ID, "agent1", scope, perms).ok).toBe(false);
    }
    expect(grants.grantsOf("agent1")).toEqual([]);
    expect(grants.can("agent1", "board.read")).toBe(false);
  });

  test("bad scopes, permissions and members are refused", () => {
    const { grants, person } = store();
    const dana = person("dana");
    expect(grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "galaxy" }, ["board.read"])).toMatchObject({ status: 400 });
    expect(grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "instance" }, ["root"])).toMatchObject({ status: 400 });
    expect(grants.grant(OWNER_PRINCIPAL_ID, "nobody", { kind: "instance" }, ["board.read"])).toMatchObject({ status: 404 });
  });
});

describe("the check in front of every route", () => {
  function app() {
    const s = store();
    const places: Record<string, Place> = { t1: { projectId: "p1", workstreamId: "w1" }, t2: { projectId: "p2", workstreamId: "w2" } };
    const inner = (req: Request) => new Response(JSON.stringify({ ok: true, permitted: wasPermitted(req), principal: principalOf(req) }), { headers: { "Content-Type": "application/json" } });
    const fetch = withSignIn(
      withAuthorizationRecords(withPermissions(withIdentityRoutes(inner, s.identity, s.grants), { grants: s.grants, placeOf: async (from, parts) => (from === "task" ? places[parts[1]!] : from === "workstream" ? { workstreamId: parts[1]! } : from === "project" ? { projectId: parts[1]! } : undefined) }), s.log, { principalFor: principalOf }),
      { mode: "tokens", identity: s.identity, secure: false },
    );
    const tokenFor = (id: string) => (s.identity.createToken(id, "t") as { secret: string }).secret;
    const call = (token: string, method: string, path: string, body?: unknown) => fetch(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    return { ...s, call, tokenFor };
  }

  test("a signed-in person with no grants sees nothing; each permission opens only its routes, in its scope", async () => {
    const { call, tokenFor, person, grants, log } = app();
    const dana = person("dana");
    const t = tokenFor(dana);
    expect((await call(t, "GET", "/tasks")).status).toBe(403);
    expect((await call(t, "GET", "/me")).status).toBe(200);
    grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "instance" }, ["board.read"]);
    grants.grant(OWNER_PRINCIPAL_ID, dana, { kind: "workstream", id: "w1" }, ["card.merge"]);
    expect((await call(t, "GET", "/tasks")).status).toBe(200);
    expect((await call(t, "POST", "/tasks/t1/merge")).status).toBe(200);
    const denied = await call(t, "POST", "/tasks/t2/merge");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "this needs card.merge here" });
    expect((await call(t, "POST", "/tasks/t1/discard")).status).toBe(403);
    expect((await call(t, "POST", "/brand-new-route")).status).toBe(403);
    expect((await call(t, "GET", "/audit")).status).toBe(403);
    // The refusal is recorded, as denied, with its reason.
    const recs = log.list({ principalId: dana });
    expect(recs.some((r) => r.action.kind === "POST /tasks/:id/merge" && r.outcome === "denied" && r.reason?.includes("card.merge"))).toBe(true);
  });

  test("the owner passes everything; the app sees the request as permitted", async () => {
    const { call, tokenFor } = app();
    const t = tokenFor(OWNER_PRINCIPAL_ID);
    const r = await call(t, "POST", "/brand-new-route");
    expect(await r.json()).toEqual({ ok: true, permitted: true, principal: OWNER_PRINCIPAL_ID });
  });

  test("grants over the API: member.manage at the scope; a workstream owner lists members", async () => {
    const { call, tokenFor, person, grants } = app();
    const lead = person("lead");
    const dev = person("dev");
    const owner = tokenFor(OWNER_PRINCIPAL_ID);
    const g = await call(owner, "POST", `/members/${lead}/grants`, { scope: { kind: "workstream", id: "w1" }, permissions: ["member.manage", "card.run"] });
    expect(g.status).toBe(201);
    const lt = tokenFor(lead);
    expect((await call(lt, "GET", "/members")).status).toBe(200);
    expect((await call(lt, "POST", `/members/${dev}/grants`, { scope: { kind: "workstream", id: "w1" }, permissions: ["card.run"] })).status).toBe(201);
    expect((await call(lt, "POST", `/members/${dev}/grants`, { scope: { kind: "instance" }, permissions: ["card.run"] })).status).toBe(403);
    expect((await call(lt, "POST", "/members", { handle: "eve" })).status).toBe(403);
    const devGrant = grants.grantsOf(dev)[0]!;
    expect((await call(lt, "DELETE", `/grants/${devGrant.id}`)).status).toBe(200);
    expect((await call(tokenFor(dev), "GET", "/members")).status).toBe(403);
  });
});
