// Sign-in (docs/SDD-identity-and-permissions.md §3.1, §3.2, §4.2, §5;
// build plan card 5). Tokens only: there is no identity provider and no
// trusted proxy (the owner's choice, 2026-11-28).
//
// Off unless WISSEL_AUTH=tokens. Then every request but a few open ones
// must carry a session cookie or an API token:
// - The first sign-in is a one-time bootstrap URL printed to the console
//   on start while the owner has no live session or token. It expires in
//   15 minutes, works once, and signs in as the existing owner principal,
//   so the history from single-owner mode stays theirs (§4.10).
// - A signed-in person mints API tokens (`POST /tokens`, the secret shown
//   once) for themselves; the owner adds people (`POST /members`) and
//   mints their first token, which they paste into /auth/login.
// - Sessions are an opaque id in an HttpOnly, SameSite=Lax cookie (Secure
//   when WISSEL_PUBLIC_URL is https). Tokens arrive as `Authorization:
//   Bearer`. Only hashes are stored, never a secret.
// - Disabling a principal revokes every session and token in the same
//   transaction.
//
// Card 5 authenticates; it doesn't narrow anything yet. Everyone signed in
// can do everything, as §7 phase 3 says, until card 6's permissions.
import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { OWNER_PRINCIPAL_ID, type Principal } from "./authorization.ts";

export const SESSION_COOKIE = "wissel_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BOOTSTRAP_TTL_MS = 15 * 60 * 1000;
const TOKEN_PREFIX = "wsl_";
const HANDLE = /^[a-z][a-z0-9-]{1,31}$/;

export function authMode(env: Record<string, string | undefined>): "owner" | "tokens" {
  return env.WISSEL_AUTH?.trim() === "tokens" ? "tokens" : "owner";
}

export const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix = "") => `${prefix}${randomBytes(32).toString("base64url")}`;

export interface Session {
  id: string;
  principalId: string;
  source: "token" | "owner-bootstrap";
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface ApiToken {
  id: string;
  principalId: string;
  name: string;
  /** Card 6 narrows them; until then `["*"]`, never more than the principal's own. */
  permissions: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}

/** Who a request is from, once authenticated. */
export interface Caller {
  principal: Principal;
  via: "session" | "token";
  /** The token's name, when it came from one. */
  tokenName?: string;
}

export class IdentityStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, principalId TEXT NOT NULL, source TEXT NOT NULL,
      issuedAt TEXT NOT NULL, expiresAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, revokedAt TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, principalId TEXT NOT NULL, name TEXT NOT NULL,
      permissions TEXT NOT NULL, createdAt TEXT NOT NULL, lastUsedAt TEXT, expiresAt TEXT, revokedAt TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS bootstrap_links (
      hash TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, usedAt TEXT)`);
  }

  private now() {
    return this.clock();
  }

  // ---- principals ----

  principal(id: string): Principal | undefined {
    const r = this.db.query("SELECT * FROM principals WHERE id = ?").get(id) as Record<string, string | null> | null;
    return r ? toPrincipal(r) : undefined;
  }

  principals(): Principal[] {
    return (this.db.query("SELECT * FROM principals ORDER BY createdAt, rowid").all() as Record<string, string | null>[]).map(toPrincipal);
  }

  /** A new person, with no sessions and no tokens. */
  addPerson(handle: unknown, display: unknown): { ok: true; principal: Principal } | { ok: false; error: string } {
    if (typeof handle !== "string" || !HANDLE.test(handle)) return { ok: false, error: "handle must be 2 to 32 lower-case letters, digits or hyphens, starting with a letter" };
    if (display !== undefined && (typeof display !== "string" || !display.trim() || display.length > 100)) return { ok: false, error: "display must be 1 to 100 characters" };
    if (this.db.query("SELECT 1 FROM principals WHERE handle = ?").get(handle)) return { ok: false, error: `handle "${handle}" is taken` };
    const p: Principal = { id: randomUUID(), kind: "person", handle, display: typeof display === "string" ? display.trim() : handle, createdAt: this.now().toISOString() };
    this.db.run("INSERT INTO principals (id, kind, handle, display, createdAt) VALUES (?, ?, ?, ?, ?)", [p.id, p.kind, p.handle, p.display, p.createdAt]);
    return { ok: true, principal: p };
  }

  /** Disables a principal and revokes its sessions and tokens, in one
   *  transaction. The owner can't be disabled: nobody could sign in. */
  disable(id: string): { ok: true; principal: Principal } | { ok: false; status: 404 | 409; error: string } {
    if (id === OWNER_PRINCIPAL_ID) return { ok: false, status: 409, error: "the owner can't be disabled" };
    const p = this.principal(id);
    if (!p) return { ok: false, status: 404, error: "no such member" };
    if (p.disabledAt) return { ok: true, principal: p };
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db.run("UPDATE principals SET disabledAt = ? WHERE id = ?", [at, id]);
      this.db.run("UPDATE sessions SET revokedAt = ? WHERE principalId = ? AND revokedAt IS NULL", [at, id]);
      this.db.run("UPDATE api_tokens SET revokedAt = ? WHERE principalId = ? AND revokedAt IS NULL", [at, id]);
    })();
    return { ok: true, principal: this.principal(id)! };
  }

  // ---- bootstrap ----

  /** Whether the owner can sign in already: a live session or token. */
  ownerHasAccess(): boolean {
    const at = this.now().toISOString();
    return (
      !!this.db.query("SELECT 1 FROM sessions WHERE principalId = ? AND revokedAt IS NULL AND expiresAt > ?").get(OWNER_PRINCIPAL_ID, at) ||
      !!this.db.query("SELECT 1 FROM api_tokens WHERE principalId = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?)").get(OWNER_PRINCIPAL_ID, at)
    );
  }

  /** A one-time bootstrap secret: single use, 15 minutes. */
  issueBootstrap(): string {
    const s = secret();
    this.db.run("INSERT INTO bootstrap_links (hash, expiresAt) VALUES (?, ?)", [hashSecret(s), new Date(this.now().getTime() + BOOTSTRAP_TTL_MS).toISOString()]);
    return s;
  }

  /** Redeems a bootstrap secret for an owner session, once. */
  redeemBootstrap(s: string): { ok: true; cookie: string; session: Session } | { ok: false; error: string } {
    const row = this.db.query("SELECT * FROM bootstrap_links WHERE hash = ?").get(hashSecret(s)) as { hash: string; expiresAt: string; usedAt: string | null } | null;
    if (!row) return { ok: false, error: "this sign-in link is not valid" };
    if (row.usedAt) return { ok: false, error: "this sign-in link was already used" };
    if (row.expiresAt <= this.now().toISOString()) return { ok: false, error: "this sign-in link has expired; restart Wissel for a new one" };
    this.db.run("UPDATE bootstrap_links SET usedAt = ? WHERE hash = ?", [this.now().toISOString(), row.hash]);
    return { ok: true, ...this.startSession(OWNER_PRINCIPAL_ID, "owner-bootstrap") };
  }

  // ---- sessions ----

  startSession(principalId: string, source: Session["source"]): { cookie: string; session: Session } {
    const cookie = secret();
    const at = this.now();
    const s: Session = { id: randomUUID(), principalId, source, issuedAt: at.toISOString(), expiresAt: new Date(at.getTime() + SESSION_TTL_MS).toISOString(), lastSeenAt: at.toISOString() };
    this.db.run("INSERT INTO sessions (id, hash, principalId, source, issuedAt, expiresAt, lastSeenAt) VALUES (?, ?, ?, ?, ?, ?, ?)", [s.id, hashSecret(cookie), s.principalId, s.source, s.issuedAt, s.expiresAt, s.lastSeenAt]);
    return { cookie, session: s };
  }

  endSession(cookie: string): void {
    this.db.run("UPDATE sessions SET revokedAt = ? WHERE hash = ? AND revokedAt IS NULL", [this.now().toISOString(), hashSecret(cookie)]);
  }

  // ---- tokens ----

  createToken(principalId: string, name: unknown, expiresAt?: unknown): { ok: true; token: ApiToken; secret: string } | { ok: false; error: string } {
    const p = this.principal(principalId);
    if (!p || p.disabledAt) return { ok: false, error: "no such member, or disabled" };
    if (p.kind === "agent") return { ok: false, error: "an agent principal holds no tokens of its own" };
    if (typeof name !== "string" || !name.trim() || name.length > 60) return { ok: false, error: "name must be 1 to 60 characters, e.g. \"mac-mini cli\"" };
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now().getTime())) return { ok: false, error: "expiresAt must be a future date and time" };
    const s = secret(TOKEN_PREFIX);
    const t: ApiToken = { id: randomUUID(), principalId, name: name.trim(), permissions: ["*"], createdAt: this.now().toISOString(), ...(typeof expiresAt === "string" ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
    this.db.run("INSERT INTO api_tokens (id, hash, principalId, name, permissions, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?)", [t.id, hashSecret(s), t.principalId, t.name, JSON.stringify(t.permissions), t.createdAt, t.expiresAt ?? null]);
    return { ok: true, token: t, secret: s };
  }

  tokens(principalId?: string): ApiToken[] {
    const rows = (principalId ? this.db.query("SELECT * FROM api_tokens WHERE principalId = ? ORDER BY createdAt").all(principalId) : this.db.query("SELECT * FROM api_tokens ORDER BY createdAt").all()) as Record<string, string | null>[];
    return rows.map(toToken);
  }

  token(id: string): ApiToken | undefined {
    const r = this.db.query("SELECT * FROM api_tokens WHERE id = ?").get(id) as Record<string, string | null> | null;
    return r ? toToken(r) : undefined;
  }

  revokeToken(id: string): void {
    this.db.run("UPDATE api_tokens SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL", [this.now().toISOString(), id]);
  }

  // ---- the check ----

  /** Who a request is from, or undefined: a live session cookie, else a
   *  live Bearer token, of a principal that isn't disabled. */
  authenticate(req: Request): Caller | undefined {
    const at = this.now().toISOString();
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (bearer) {
      const t = this.db.query("SELECT * FROM api_tokens WHERE hash = ?").get(hashSecret(bearer)) as Record<string, string | null> | null;
      if (!t || t.revokedAt || (t.expiresAt && t.expiresAt <= at)) return undefined;
      const p = this.principal(t.principalId!);
      if (!p || p.disabledAt) return undefined;
      this.db.run("UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?", [at, t.id!]);
      return { principal: p, via: "token", tokenName: t.name! };
    }
    const cookie = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
    if (!cookie) return undefined;
    const s = this.db.query("SELECT * FROM sessions WHERE hash = ?").get(hashSecret(cookie)) as Record<string, string | null> | null;
    if (!s || s.revokedAt || s.expiresAt! <= at) return undefined;
    const p = this.principal(s.principalId!);
    if (!p || p.disabledAt) return undefined;
    this.db.run("UPDATE sessions SET lastSeenAt = ? WHERE id = ?", [at, s.id!]);
    return { principal: p, via: "session" };
  }

  /** Redeems an API token for a browser session (the login page). */
  loginWithToken(tokenSecret: unknown): { ok: true; cookie: string } | { ok: false; error: string } {
    if (typeof tokenSecret !== "string" || !tokenSecret.startsWith(TOKEN_PREFIX)) return { ok: false, error: "that isn't a Wissel token" };
    const caller = this.authenticate(new Request("http://x", { headers: { authorization: `Bearer ${tokenSecret}` } }));
    if (!caller) return { ok: false, error: "that token isn't valid, or was revoked" };
    return { ok: true, cookie: this.startSession(caller.principal.id, "token").cookie };
  }
}

export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

export function sessionCookie(value: string, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

function toPrincipal(r: Record<string, string | null>): Principal {
  return {
    id: r.id!,
    kind: r.kind as Principal["kind"],
    handle: r.handle!,
    display: r.display!,
    ...(r.subject ? { subject: r.subject } : {}),
    ...(r.codeHostLogin ? { codeHostLogin: r.codeHostLogin } : {}),
    createdAt: r.createdAt!,
    ...(r.disabledAt ? { disabledAt: r.disabledAt } : {}),
  };
}

function toToken(r: Record<string, string | null>): ApiToken {
  return {
    id: r.id!,
    principalId: r.principalId!,
    name: r.name!,
    permissions: JSON.parse(r.permissions!) as string[],
    createdAt: r.createdAt!,
    ...(r.lastUsedAt ? { lastUsedAt: r.lastUsedAt } : {}),
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
    ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
  };
}

/** Requests that need no sign-in: a supervisor's health and version
 *  checks, the sign-in page and the bootstrap link. */
export function isOpenPath(method: string, pathname: string): boolean {
  if (pathname === "/health" || pathname === "/version") return method === "GET" || method === "HEAD";
  if (pathname === "/auth/login") return method === "GET" || method === "POST";
  return method === "GET" && /^\/auth\/bootstrap\/[A-Za-z0-9_-]{20,}$/.test(pathname);
}

/** The sign-in page: paste a token. Inline, no scripts from elsewhere. */
export function loginPage(error?: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Wissel</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:Canvas;color:CanvasText}main{width:min(420px,100% - 32px)}input{width:100%;box-sizing:border-box;padding:8px;font:inherit}button{margin-top:12px;padding:8px 16px;font:inherit}.err{color:#c0302f}</style></head>
<body><main><h1>Sign in to Wissel</h1>${error ? `<p class="err" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/auth/login"><label for="token">Your Wissel token</label><input id="token" name="token" type="password" autocomplete="off" required><button type="submit">Sign in</button></form>
<p>The owner gives you a token from the members page. The owner's first sign-in is the one-time link Wissel prints when it starts.</p></main></body></html>`;
}
