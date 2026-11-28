// The sign-in front door (docs/SDD-identity-and-permissions.md §4.2, §5;
// card 5). Wraps the app's fetch, outside the authorization records:
//
//   withSignIn( withAuthorizationRecords( withIdentityRoutes( app ) ) )
//
// In single-owner mode (WISSEL_AUTH unset) it passes everything through
// and the owner stands behind every request, exactly as before. With
// WISSEL_AUTH=tokens it answers the open paths itself (the sign-in page,
// the bootstrap link, health and version), and refuses anything else
// without a live session or token: a browser page is sent to the sign-in
// page, an API call gets 401. The caller is passed inward through a
// WeakMap keyed on the request object, never a header, so nothing a
// client sends can name a principal.
import { OWNER_PRINCIPAL_ID } from "../services/authorization.ts";
import { cookieValue, isOpenPath, loginPage, SESSION_COOKIE, sessionCookie, type Caller, type IdentityStore } from "../services/identity.ts";

type Fetch = (req: Request) => Response | Promise<Response>;

const callers = new WeakMap<Request, Caller>();

/** The principal behind a request: the signed-in caller, else the owner
 *  (single-owner mode, where nothing signs in). */
export function principalOf(req: Request): string {
  return callers.get(req)?.principal.id ?? OWNER_PRINCIPAL_ID;
}

export function callerOf(req: Request): Caller | undefined {
  return callers.get(req);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...headers } });

export interface SignInOptions {
  mode: "owner" | "tokens";
  identity: IdentityStore;
  /** Cookies get Secure when the board's public URL is https. */
  secure: boolean;
}

export function withSignIn(inner: Fetch, opts: SignInOptions): Fetch {
  if (opts.mode === "owner") return inner;
  const { identity } = opts;
  return async (req) => {
    const url = new URL(req.url);
    if (isOpenPath(req.method, url.pathname)) {
      if (url.pathname === "/auth/login") {
        if (req.method === "GET") return html(loginPage());
        const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
        const token = isForm ? new URLSearchParams(await req.text()).get("token") : ((await req.json().catch(() => ({}))) as { token?: unknown }).token;
        const r = identity.loginWithToken(token);
        if (!r.ok) return isForm ? html(loginPage(r.error), 401) : json({ error: r.error }, 401);
        const cookie = sessionCookie(r.cookie, opts.secure);
        return isForm ? new Response(null, { status: 303, headers: { Location: "/board", "Set-Cookie": cookie } }) : json({ ok: true }, 200, { "Set-Cookie": cookie });
      }
      if (url.pathname.startsWith("/auth/bootstrap/")) {
        const r = identity.redeemBootstrap(url.pathname.slice("/auth/bootstrap/".length));
        if (!r.ok) return html(loginPage(r.error), 401);
        return new Response(null, { status: 303, headers: { Location: "/board", "Set-Cookie": sessionCookie(r.cookie, opts.secure) } });
      }
      return inner(req);
    }
    const caller = identity.authenticate(req);
    if (!caller) {
      const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
      return wantsPage ? new Response(null, { status: 303, headers: { Location: "/auth/login" } }) : json({ error: "sign in first: a session, or Authorization: Bearer <token>" }, 401);
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      const c = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
      if (c) identity.endSession(c);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", opts.secure, 0) });
    }
    callers.set(req, caller);
    return inner(req);
  };
}

/** Members and tokens (§5). Inside the authorization records, so each
 *  write is recorded like any other. Until card 6's permissions, only the
 *  owner manages members; anyone signed in manages their own tokens. */
export function withIdentityRoutes(inner: Fetch, identity: IdentityStore): Fetch {
  return async (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "members" && parts[0] !== "tokens") return inner(req);
    const me = principalOf(req);
    const ownerOnly = () => (me === OWNER_PRINCIPAL_ID ? undefined : json({ error: "only the owner manages members" }, 403));
    const body = async () => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

    if (parts[0] === "members") {
      if (parts.length === 1 && req.method === "GET") {
        const refused = ownerOnly();
        if (refused) return refused;
        return json(identity.principals().map((p) => ({ ...p, tokens: identity.tokens(p.id) })));
      }
      if (parts.length === 1 && req.method === "POST") {
        const refused = ownerOnly();
        if (refused) return refused;
        const b = await body();
        const added = identity.addPerson(b.handle, b.display);
        if (!added.ok) return json({ error: added.error }, 400);
        // Their first token, shown once, to paste into /auth/login.
        const t = identity.createToken(added.principal.id, "first sign-in");
        return json({ principal: added.principal, token: t.ok ? { ...t.token, secret: t.secret } : undefined }, 201);
      }
      if (parts.length === 3 && parts[2] === "disable" && req.method === "POST") {
        const refused = ownerOnly();
        if (refused) return refused;
        const r = identity.disable(decodeURIComponent(parts[1]!));
        return r.ok ? json(r.principal) : json({ error: r.error }, r.status);
      }
      if (parts.length === 3 && parts[2] === "tokens" && req.method === "POST") {
        const refused = ownerOnly();
        if (refused) return refused;
        const b = await body();
        const t = identity.createToken(decodeURIComponent(parts[1]!), b.name, b.expiresAt);
        return t.ok ? json({ ...t.token, secret: t.secret }, 201) : json({ error: t.error }, 400);
      }
      return json({ error: "no such members route" }, 404);
    }

    // /tokens: the caller's own.
    if (parts.length === 1 && req.method === "GET") return json(identity.tokens(me));
    if (parts.length === 1 && req.method === "POST") {
      const b = await body();
      const t = identity.createToken(me, b.name, b.expiresAt);
      return t.ok ? json({ ...t.token, secret: t.secret }, 201) : json({ error: t.error }, 400);
    }
    if (parts.length === 2 && req.method === "DELETE") {
      const t = identity.token(decodeURIComponent(parts[1]!));
      if (!t || (t.principalId !== me && me !== OWNER_PRINCIPAL_ID)) return json({ error: "no such token" }, 404);
      identity.revokeToken(t.id);
      return json({ ...identity.token(t.id)! });
    }
    return json({ error: "no such tokens route" }, 404);
  };
}
