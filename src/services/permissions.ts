// Permissions and grants (docs/SDD-identity-and-permissions.md §3.3, §4.3,
// §4.8, §6; build plan card 6).
//
// One check, denied by default: `can(principal, permission, scope)`. The
// owner holds everything, implicitly (single-owner history stays theirs,
// §4.10). Everyone else holds what their grants say: a grant at instance
// scope applies everywhere; at workstream scope, in that workstream and
// its projects; at project scope, in that project. There is no deny
// grant. An agent principal can never hold one (§4.8).
//
// Who may grant (the owner's choice, 2026-11-28): the owner anywhere, and
// a workstream owner (member.manage at that workstream) within it. A
// granter can only hand out permissions they hold at that scope, and
// host.admin and member.manage at instance scope come only from the owner.
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { OWNER_PRINCIPAL_ID } from "./authorization.ts";

export const PERMISSIONS = [
  "board.read",
  "audit.read",
  "card.create",
  "card.run",
  "card.stop",
  "card.merge",
  "card.discard",
  "card.grant-tools",
  "project.settings",
  "project.register",
  "harness.manage",
  "mcp.register",
  "mcp.approve",
  "policy.edit",
  "role.change",
  "duty.switch",
  "branch.push",
  "pr.open",
  "pr.arm",
  "ticket.write",
  "channel.post",
  "host.admin",
  "member.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const isPermission = (p: unknown): p is Permission => typeof p === "string" && (PERMISSIONS as readonly string[]).includes(p);

export type Scope = { kind: "instance" } | { kind: "workstream"; id: string } | { kind: "project"; id: string };
export const INSTANCE: Scope = { kind: "instance" };

/** Where an action lands: its project and workstream when it has them. A
 *  grant at any of these (or at instance scope) covers it. */
export interface Place {
  projectId?: string;
  workstreamId?: string;
}

export interface Grant {
  id: string;
  principalId: string;
  scope: Scope;
  permissions: Permission[];
  grantedBy: string;
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export class GrantStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY, principalId TEXT NOT NULL, scopeKind TEXT NOT NULL, scopeId TEXT,
      permissions TEXT NOT NULL, grantedBy TEXT NOT NULL, grantedAt TEXT NOT NULL, expiresAt TEXT, revokedAt TEXT)`);
    db.run("CREATE INDEX IF NOT EXISTS grants_principal ON grants (principalId)");
  }

  /** The live grants of a principal. */
  grantsOf(principalId: string): Grant[] {
    const at = this.clock().toISOString();
    return (this.db.query("SELECT * FROM grants WHERE principalId = ? AND revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY grantedAt").all(principalId, at) as Row[]).map(toGrant);
  }

  get(id: string): Grant | undefined {
    const r = this.db.query("SELECT * FROM grants WHERE id = ?").get(id) as Row | null;
    return r ? toGrant(r) : undefined;
  }

  /** The one check. `place` is where the action lands; undefined means
   *  only an instance-scope grant covers it. */
  can(principalId: string, permission: Permission, place?: Place): boolean {
    if (principalId === OWNER_PRINCIPAL_ID) return true;
    if (this.kindOf(principalId) === "agent") return false;
    return this.grantsOf(principalId).some((g) => g.permissions.includes(permission) && covers(g.scope, place));
  }

  /** The grant that allowed it, for the authorization record. */
  grantFor(principalId: string, permission: Permission, place?: Place): Grant | undefined {
    if (principalId === OWNER_PRINCIPAL_ID) return undefined;
    return this.grantsOf(principalId).find((g) => g.permissions.includes(permission) && covers(g.scope, place));
  }

  /** Writes a grant, or says why not. Every refusal is about who asks,
   *  never about what a board entry, card or model output says. */
  grant(by: string, principalId: string, scope: unknown, permissions: unknown, expiresAt?: unknown): { ok: true; grant: Grant } | { ok: false; status: 400 | 403 | 404; error: string } {
    const s = scopeOf(scope);
    if (!s) return { ok: false, status: 400, error: 'scope must be { "kind": "instance" }, { "kind": "workstream", "id": "…" } or { "kind": "project", "id": "…" }' };
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every(isPermission)) return { ok: false, status: 400, error: `permissions must list any of: ${PERMISSIONS.join(", ")}` };
    if (expiresAt !== undefined && (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.clock().getTime())) return { ok: false, status: 400, error: "expiresAt must be a future date and time" };
    const kind = this.kindOf(principalId);
    if (!kind) return { ok: false, status: 404, error: "no such member" };
    if (kind === "agent") return { ok: false, status: 403, error: "an agent principal can never hold a grant" };
    if (this.disabled(principalId)) return { ok: false, status: 403, error: "this member is disabled" };
    const place = placeOfScope(s);
    if (!this.can(by, "member.manage", place)) return { ok: false, status: 403, error: s.kind === "instance" ? "granting at instance scope needs member.manage there" : `granting in this ${s.kind} needs member.manage there` };
    const perms = [...new Set(permissions as Permission[])];
    const beyond = perms.filter((p) => !this.can(by, p, place));
    if (beyond.length) return { ok: false, status: 403, error: `you can only grant what you hold here; not: ${beyond.join(", ")}` };
    if (s.kind === "instance" && by !== OWNER_PRINCIPAL_ID && perms.some((p) => p === "host.admin" || p === "member.manage")) return { ok: false, status: 403, error: "only the owner grants host.admin or member.manage at instance scope" };
    const g: Grant = { id: randomUUID(), principalId, scope: s, permissions: perms, grantedBy: by, grantedAt: this.clock().toISOString(), ...(typeof expiresAt === "string" ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
    this.db.run("INSERT INTO grants (id, principalId, scopeKind, scopeId, permissions, grantedBy, grantedAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
      g.id,
      g.principalId,
      g.scope.kind,
      g.scope.kind === "instance" ? null : g.scope.id,
      JSON.stringify(g.permissions),
      g.grantedBy,
      g.grantedAt,
      g.expiresAt ?? null,
    ]);
    return { ok: true, grant: g };
  }

  /** Revokes a grant: by someone with member.manage at its scope. */
  revoke(by: string, id: string): { ok: true; grant: Grant } | { ok: false; status: 403 | 404; error: string } {
    const g = this.get(id);
    if (!g) return { ok: false, status: 404, error: "no such grant" };
    if (!this.can(by, "member.manage", placeOfScope(g.scope))) return { ok: false, status: 403, error: "revoking this grant needs member.manage at its scope" };
    if (!g.revokedAt) this.db.run("UPDATE grants SET revokedAt = ? WHERE id = ?", [this.clock().toISOString(), id]);
    return { ok: true, grant: this.get(id)! };
  }

  private kindOf(principalId: string): string | undefined {
    return (this.db.query("SELECT kind FROM principals WHERE id = ?").get(principalId) as { kind: string } | null)?.kind;
  }

  private disabled(principalId: string): boolean {
    return !!(this.db.query("SELECT disabledAt FROM principals WHERE id = ?").get(principalId) as { disabledAt: string | null } | null)?.disabledAt;
  }
}

/** Whether a grant's scope covers an action at `place`. */
export function covers(scope: Scope, place: Place | undefined): boolean {
  if (scope.kind === "instance") return true;
  if (!place) return false;
  return scope.kind === "workstream" ? place.workstreamId === scope.id : place.projectId === scope.id;
}

export function placeOfScope(s: Scope): Place | undefined {
  return s.kind === "instance" ? undefined : s.kind === "workstream" ? { workstreamId: s.id } : { projectId: s.id };
}

function scopeOf(v: unknown): Scope | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (o.kind === "instance") return INSTANCE;
  if ((o.kind === "workstream" || o.kind === "project") && typeof o.id === "string" && o.id.trim()) return { kind: o.kind, id: o.id };
  return undefined;
}

interface Row {
  id: string;
  principalId: string;
  scopeKind: string;
  scopeId: string | null;
  permissions: string;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

function toGrant(r: Row): Grant {
  return {
    id: r.id,
    principalId: r.principalId,
    scope: r.scopeKind === "instance" ? INSTANCE : { kind: r.scopeKind as "workstream" | "project", id: r.scopeId! },
    permissions: JSON.parse(r.permissions) as Permission[],
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt,
    ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
    ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}),
  };
}

// ---- The route table (§4.3) -------------------------------------------

/** Where a route's action lands, from its path: a card's project and
 *  workstream, a project, a workstream, or the whole instance. */
export type PlaceFrom = "instance" | "task" | "project" | "workstream";

export interface RouteRule {
  method: string;
  /** Path segments; `*` matches any one segment. */
  path: string;
  /** Every one of these is needed. `self` routes need only a signed-in
   *  principal: they act on the caller's own things. */
  needs: Permission[] | "self";
  place: PlaceFrom;
}

const r = (method: string, path: string, needs: Permission[] | "self", place: PlaceFrom = "instance"): RouteRule => ({ method, path, needs, place });

/** Every write route, with what it needs. A write that matches none is
 *  refused to everyone but the owner: a route nobody declared isn't
 *  reachable (§4.3). Reads need board.read at instance scope, except
 *  the caller's own /me and /tokens. */
export const WRITE_ROUTES: RouteRule[] = [
  // Cards.
  r("POST", "/tasks", ["card.create"]),
  r("PATCH", "/tasks/*", ["card.create"], "task"),
  r("DELETE", "/tasks/*", ["card.discard"], "task"),
  r("POST", "/tasks/*/move", ["card.run"], "task"),
  r("POST", "/tasks/*/depends-on", ["card.create"], "task"),
  r("POST", "/tasks/*/decision", ["card.run"], "task"),
  r("POST", "/tasks/*/result", ["card.run"], "task"),
  r("POST", "/tasks/*/run", ["card.run"], "task"),
  r("POST", "/tasks/*/harness", ["card.run"], "task"),
  r("POST", "/tasks/*/not-before", ["card.run"], "task"),
  r("POST", "/tasks/*/hold", ["card.run"], "task"),
  r("POST", "/tasks/*/release", ["card.run"], "task"),
  r("POST", "/tasks/*/allowed-tools", ["card.grant-tools"], "task"),
  r("POST", "/tasks/*/pr", ["pr.open"], "task"),
  r("POST", "/tasks/*/re-review", ["card.run"], "task"),
  r("POST", "/tasks/*/merge", ["card.merge"], "task"),
  r("POST", "/tasks/*/close", ["card.discard"], "task"),
  r("POST", "/tasks/*/discard", ["card.discard"], "task"),
  r("POST", "/tasks/*/override", ["card.merge"], "task"),
  r("POST", "/tasks/*/archive", ["card.discard"], "task"),
  r("POST", "/tasks/*/unarchive", ["card.discard"], "task"),
  r("POST", "/tasks/*/escalation/approve", ["card.merge"], "task"),
  r("POST", "/tasks/*/escalation/abandon", ["card.discard"], "task"),
  r("POST", "/tasks/*/escalation/retry", ["card.run"], "task"),
  r("POST", "/tasks/*/escalation/grant-and-retry", ["card.grant-tools", "card.run"], "task"),
  r("POST", "/tasks/*/mcp-approval/approve", ["mcp.approve"], "task"),
  r("POST", "/tasks/*/mcp-approval/deny", ["mcp.approve"], "task"),
  r("POST", "/owner-tasks", ["card.create"]),
  r("POST", "/owner-tasks/*/done", ["card.run"]),
  r("POST", "/owner-tasks/*/dismiss", ["card.run"]),
  // Pipelines and schedules.
  r("POST", "/pipelines", ["project.settings"]),
  r("PUT", "/pipelines/*", ["project.settings"]),
  r("DELETE", "/pipelines/*", ["project.settings"]),
  r("POST", "/pipelines/*/run", ["card.create", "card.run"]),
  r("POST", "/schedules", ["card.create"]),
  r("PATCH", "/schedules/*", ["card.create"]),
  r("DELETE", "/schedules/*", ["card.create"]),
  r("POST", "/schedules/*/run-now", ["card.run"]),
  // Projects.
  r("POST", "/projects/local", ["project.register"]),
  r("POST", "/projects/clone", ["project.register"]),
  r("DELETE", "/projects/*", ["project.register"], "project"),
  r("POST", "/projects/*/merge-gate", ["project.settings"], "project"),
  r("POST", "/projects/*/settings", ["project.settings"], "project"),
  // Harnesses and MCP servers.
  r("POST", "/harnesses/*/enable", ["harness.manage"]),
  r("POST", "/harnesses/*/disable", ["harness.manage"]),
  r("POST", "/harnesses/*/model", ["harness.manage"]),
  r("POST", "/mcp-servers", ["mcp.register"]),
  r("POST", "/mcp-servers/*/enable", ["mcp.register"]),
  r("POST", "/mcp-servers/*/disable", ["mcp.register"]),
  r("POST", "/mcp-servers/*/tools/*/trust", ["mcp.approve"]),
  // Tickets.
  r("POST", "/tickets/*/comment", ["ticket.write"]),
  r("POST", "/tickets/*/transition", ["ticket.write"]),
  // Ask: a request reads; confirming one does what it proposed, so it
  // needs everything Ask's board controls can do.
  r("POST", "/ask", ["board.read", "card.create"]),
  r("POST", "/ask/actions/*/confirm", ["card.create", "card.run", "card.merge", "card.discard", "card.grant-tools", "harness.manage", "mcp.register", "mcp.approve"]),
  r("POST", "/ask/actions/*/cancel", ["board.read"]),
  r("POST", "/ask/*/audio", ["board.read"]),
  r("POST", "/voice", ["board.read"]),
  r("POST", "/route/preview", ["board.read"]),
  // Workstreams and the coordinator.
  r("POST", "/workstreams", ["policy.edit"]),
  r("PATCH", "/workstreams/*", ["policy.edit"], "workstream"),
  r("DELETE", "/workstreams/*", ["policy.edit"], "workstream"),
  r("POST", "/workstreams/*/projects/*/role", ["role.change"], "workstream"),
  r("POST", "/workstreams/*/duties/*", ["duty.switch"], "workstream"),
  r("POST", "/workstreams/*/import", ["policy.edit"], "workstream"),
  r("POST", "/workstreams/*/digest", ["channel.post"], "workstream"),
  r("POST", "/workstreams/*/owner-comments/read", ["channel.post"], "workstream"),
  r("POST", "/workstreams/*/channel/flush", ["channel.post"], "workstream"),
  r("POST", "/workstreams/*/decisions/start", ["policy.edit"], "workstream"),
  r("POST", "/workstreams/*/actions", ["policy.edit", "host.admin"], "workstream"),
  r("POST", "/decisions/*/flip", ["policy.edit"]),
  r("POST", "/inbox", ["card.create"]),
  r("POST", "/lessons/*/approve", ["policy.edit"]),
  r("POST", "/lessons/*/reject", ["policy.edit"]),
  // The host.
  r("POST", "/admin/shadow", ["duty.switch", "host.admin"]),
  r("POST", "/admin/restart-when-idle", ["host.admin"]),
  r("DELETE", "/admin/restart-when-idle", ["host.admin"]),
  r("POST", "/admin/pr-watch", ["host.admin"]),
  // Members, grants and tokens.
  r("POST", "/members", ["member.manage"]),
  r("POST", "/members/*/disable", ["member.manage"]),
  r("POST", "/members/*/tokens", ["member.manage"]),
  r("POST", "/members/*/grants", "self"), // GrantStore.grant checks member.manage at the grant's scope
  r("DELETE", "/grants/*", "self"), // GrantStore.revoke checks member.manage at the grant's scope
  r("POST", "/tokens", "self"),
  r("DELETE", "/tokens/*", "self"),
  r("POST", "/auth/logout", "self"),
];

/** Reads anyone signed in may make about themselves; /members checks
 *  member.manage itself (at any scope, for a workstream owner). */
const SELF_READS = new Set(["/me", "/tokens", "/members"]);

export function matchRoute(method: string, pathname: string, table: RouteRule[] = WRITE_ROUTES): RouteRule | undefined {
  const parts = pathname.split("/").filter(Boolean);
  return table.find((rule) => {
    if (rule.method !== method) return false;
    const p = rule.path.split("/").filter(Boolean);
    return p.length === parts.length && p.every((seg, i) => seg === "*" || seg === parts[i]);
  });
}

export type Requirement = { needs: Permission[] | "self" | "owner"; place: PlaceFrom; rule?: RouteRule };

/** What a request needs. An undeclared write needs the owner. */
export function requirementFor(method: string, pathname: string): Requirement {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    if (SELF_READS.has(pathname)) return { needs: "self", place: "instance" };
    if (pathname === "/audit" || pathname.startsWith("/audit/")) return { needs: ["audit.read"], place: "instance" };
    return { needs: ["board.read"], place: "instance" };
  }
  const rule = matchRoute(method, pathname);
  return rule ? { needs: rule.needs, place: rule.place, rule } : { needs: "owner", place: "instance" };
}
