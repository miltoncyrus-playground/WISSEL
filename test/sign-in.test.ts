import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolveBind } from "../src/core/bind.ts";
import { AuthorizationLog, OWNER_PRINCIPAL_ID, withAuthorizationRecords } from "../src/services/authorization.ts";
import { authMode, BOOTSTRAP_TTL_MS, hashSecret, IdentityStore, isOpenPath, SESSION_COOKIE } from "../src/services/identity.ts";
import { principalOf, withIdentityRoutes, withSignIn } from "../src/api/sign-in.ts";

// docs/SDD-identity-and-permissions.md §3.1, §3.2, §4.2, §5, §6; build
// plan card 5: sign-in with tokens only.

function setup(clock = { t: Date.parse("2026-11-28T10:00:00Z") }) {
  const db = new Database(":memory:");
  const log = new AuthorizationLog(db, () => new Date(clock.t));
  log.ensureOwner("milton");
  const identity = new IdentityStore(db, () => new Date(clock.t));
  const seen: string[] = [];
  const app = (req: Request) => {
    seen.push(principalOf(req));
    return new Response(JSON.stringify({ path: new URL(req.url).pathname, principal: principalOf(req) }), { headers: { "Content-Type": "application/json" } });
  };
  const fetch = withSignIn(withAuthorizationRecords(withIdentityRoutes(app, identity), log, { principalFor: principalOf }), { mode: "tokens", identity, secure: false });
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) =>
    fetch(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json", ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}) }));
  return { db, log, identity, fetch, call, clock, seen };
}

const cookieOf = (res: Response) => /wissel_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

describe("the mode and the bind", () => {
  test("sign-in is on only with WISSEL_AUTH=tokens; then a wide bind is no open door", () => {
    expect(authMode({})).toBe("owner");
    expect(authMode({ WISSEL_AUTH: "oidc" })).toBe("owner");
    expect(authMode({ WISSEL_AUTH: "tokens" })).toBe("tokens");
    expect(resolveBind({ WISSEL_BIND: "0.0.0.0" }).ok).toBe(false);
    expect(resolveBind({ WISSEL_BIND: "0.0.0.0", WISSEL_AUTH: "tokens" })).toEqual({ ok: true, hostname: "0.0.0.0", open: false });
  });

  test("single-owner mode passes everything through as the owner", async () => {
    const db = new Database(":memory:");
    const identity = new IdentityStore(db);
    const f = withSignIn((req) => new Response(principalOf(req)), { mode: "owner", identity, secure: false });
    expect(await (await f(new Request("http://x/tasks"))).text()).toBe(OWNER_PRINCIPAL_ID);
  });
});

describe("signed out", () => {
  test("only health, version, the sign-in page and bootstrap links are open", async () => {
    const { call } = setup();
    expect(isOpenPath("GET", "/health")).toBe(true);
    expect(isOpenPath("POST", "/health")).toBe(false);
    expect(isOpenPath("GET", "/auth/bootstrap/short")).toBe(false);
    expect((await call("GET", "/health")).status).toBe(200);
    expect((await call("GET", "/tasks")).status).toBe(401);
    expect((await call("POST", "/tasks", { body: {} })).status).toBe(401);
    const page = await call("GET", "/board", { headers: { accept: "text/html" } });
    expect([page.status, page.headers.get("location")]).toEqual([303, "/auth/login"]);
    expect(await (await call("GET", "/auth/login")).text()).toContain("Sign in to Wissel");
  });

  test("a header can't name a principal, and a forged cookie or token is refused", async () => {
    const { call } = setup();
    expect((await call("GET", "/tasks", { headers: { "x-wissel-principal": "owner" } })).status).toBe(401);
    expect((await call("GET", "/tasks", { headers: { cookie: `${SESSION_COOKIE}=forged` } })).status).toBe(401);
    expect((await call("GET", "/tasks", { headers: { authorization: "Bearer wsl_forged" } })).status).toBe(401);
  });
});

describe("the bootstrap link", () => {
  test("signs in as the owner once, within 15 minutes", async () => {
    const { identity, call, clock } = setup();
    expect(identity.ownerHasAccess()).toBe(false);
    const s = identity.issueBootstrap();
    const res = await call("GET", `/auth/bootstrap/${s}`);
    expect([res.status, res.headers.get("location")]).toEqual([303, "/board"]);
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax");
    const cookie = cookieOf(res);
    expect(await (await call("GET", "/me", { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } })).json()).toEqual({ path: "/me", principal: OWNER_PRINCIPAL_ID });
    expect(identity.ownerHasAccess()).toBe(true);
    expect((await call("GET", `/auth/bootstrap/${s}`)).status).toBe(401);
    const late = identity.issueBootstrap();
    clock.t += BOOTSTRAP_TTL_MS + 1;
    expect(await (await call("GET", `/auth/bootstrap/${late}`)).text()).toContain("expired");
  });

  test("only hashes are stored", () => {
    const { identity, db } = setup();
    const s = identity.issueBootstrap();
    const rows = db.query("SELECT hash FROM bootstrap_links").all() as { hash: string }[];
    expect(rows.map((r) => r.hash)).toEqual([hashSecret(s)]);
    const t = identity.createToken(OWNER_PRINCIPAL_ID, "cli");
    expect(t.ok).toBe(true);
    const stored = JSON.stringify(db.query("SELECT * FROM api_tokens").all());
    expect(stored).not.toContain((t as { secret: string }).secret);
  });
});

describe("members and tokens", () => {
  async function asOwner() {
    const ctx = setup();
    const owner = ctx.identity.createToken(OWNER_PRINCIPAL_ID, "owner cli");
    const auth = { authorization: `Bearer ${(owner as { secret: string }).secret}` };
    return { ...ctx, auth };
  }

  test("the owner adds a person with a first token; the person signs in with it and acts as themselves", async () => {
    const { call, auth, log } = await asOwner();
    const added = await call("POST", "/members", { body: { handle: "dana", display: "Dana" }, headers: auth });
    expect(added.status).toBe(201);
    const { principal, token } = (await added.json()) as { principal: { id: string; handle: string }; token: { secret: string } };
    expect(principal.handle).toBe("dana");
    expect(token.secret).toStartWith("wsl_");

    // The sign-in page turns the token into a browser session.
    const login = await call("POST", "/auth/login", { body: `token=${encodeURIComponent(token.secret)}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect([login.status, login.headers.get("location")]).toEqual([303, "/board"]);
    const asDana = { cookie: `${SESSION_COOKIE}=${cookieOf(login)}` };
    expect(((await (await call("GET", "/me", { headers: asDana })).json()) as { principal: string }).principal).toBe(principal.id);

    // Their writes are recorded as theirs.
    await call("POST", "/tasks", { body: {}, headers: asDana });
    expect(log.list({ principalId: principal.id }).map((r) => r.action.kind)).toContain("card.start");

    // Not the owner: can't manage members, can mint their own tokens.
    expect((await call("GET", "/members", { headers: asDana })).status).toBe(403);
    expect((await call("POST", "/tokens", { body: { name: "laptop" }, headers: asDana })).status).toBe(201);
    expect(((await (await call("GET", "/tokens", { headers: asDana })).json()) as unknown[]).length).toBe(2);
  });

  test("a bad login, a bad handle, a duplicate handle are refused", async () => {
    const { call, auth } = await asOwner();
    expect((await call("POST", "/auth/login", { body: { token: "nope" } })).status).toBe(401);
    expect((await call("POST", "/members", { body: { handle: "Dana!" }, headers: auth })).status).toBe(400);
    await call("POST", "/members", { body: { handle: "dana" }, headers: auth });
    expect((await call("POST", "/members", { body: { handle: "dana" }, headers: auth })).status).toBe(400);
  });

  test("disabling revokes every session and token at once; the owner can't be disabled", async () => {
    const { call, auth, identity } = await asOwner();
    const { principal, token } = (await (await call("POST", "/members", { body: { handle: "dana" }, headers: auth })).json()) as { principal: { id: string }; token: { secret: string } };
    const login = await call("POST", "/auth/login", { body: { token: token.secret } });
    const asDana = { cookie: `${SESSION_COOKIE}=${cookieOf(login)}` };
    expect((await call("GET", "/tasks", { headers: asDana })).status).toBe(200);
    expect((await call("POST", `/members/${principal.id}/disable`, { headers: auth })).status).toBe(200);
    expect((await call("GET", "/tasks", { headers: asDana })).status).toBe(401);
    expect((await call("GET", "/tasks", { headers: { authorization: `Bearer ${token.secret}` } })).status).toBe(401);
    expect(identity.tokens(principal.id).every((t) => t.revokedAt)).toBe(true);
    expect((await call("POST", `/members/${OWNER_PRINCIPAL_ID}/disable`, { headers: auth })).status).toBe(409);
  });

  test("a revoked or expired token stops working; logout ends the session", async () => {
    const { call, auth, identity, clock } = await asOwner();
    const t = (await (await call("POST", "/tokens", { body: { name: "short", expiresAt: new Date(clock.t + 60_000).toISOString() }, headers: auth })).json()) as { id: string; secret: string };
    const bearer = { authorization: `Bearer ${t.secret}` };
    expect((await call("GET", "/tasks", { headers: bearer })).status).toBe(200);
    clock.t += 61_000;
    expect((await call("GET", "/tasks", { headers: bearer })).status).toBe(401);

    const u = identity.createToken(OWNER_PRINCIPAL_ID, "other");
    const ub = { authorization: `Bearer ${(u as { secret: string }).secret}` };
    expect((await call("DELETE", `/tokens/${(u as { token: { id: string } }).token.id}`, { headers: auth })).status).toBe(200);
    expect((await call("GET", "/tasks", { headers: ub })).status).toBe(401);

    const login = await call("POST", "/auth/login", { body: { token: (identity.createToken(OWNER_PRINCIPAL_ID, "x") as { secret: string }).secret } });
    const session = { cookie: `${SESSION_COOKIE}=${cookieOf(login)}` };
    expect((await call("POST", "/auth/logout", { headers: session })).status).toBe(200);
    expect((await call("GET", "/tasks", { headers: session })).status).toBe(401);
  });

  test("an agent principal can't hold a token", () => {
    const { identity, db } = setup();
    db.run("INSERT INTO principals (id, kind, handle, display, createdAt) VALUES ('a1', 'agent', 'card-a1', 'card', '2026-11-28T10:00:00Z')");
    expect(identity.createToken("a1", "x")).toEqual({ ok: false, error: "an agent principal holds no tokens of its own" });
  });
});
