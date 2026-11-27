// Workstreams and roles (docs/SDD-coordinator.md §3.1, §4.13; phase 3
// card 12).
//
// A workstream is one piece of team work (a feature, an epic) across one
// or more projects. Each project in it has a role saying how far Wissel
// may act by itself:
// - shadow: runs everything record-only;
// - follow: works to someone else's decisions;
// - decide: decides what its lists allow;
// - decide-over: also answers other coordinators.
// It also has the decisions it may take alone (decideAlone), those it must
// always ask about (mustAsk), and actions it must never take (never).
//
// Roles are policy. Only the owner changes one, and only with a confirm
// step: the first call says what would change, the second (confirm: true)
// changes it. Channel entries, PR comments and other coordinators never
// can, because the gate (card 14) reads roles from here and nowhere else.
// Every write bumps the policy revision (policy-revision.ts).
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { validateCron } from "../core/schedule-time.ts";

export const PROJECT_ROLES = ["shadow", "follow", "decide", "decide-over"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/** Decision cards (§4.4). */
export const DECISION_KINDS = ["plan-batch", "decide-default", "triage-red", "resolve-conflict", "read-owner-comments"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];
/** What the executor can do (§4.3). */
export const ACTION_KINDS = [
  "card.start",
  "card.stop",
  "channel.post",
  "branch.push",
  "pr.open",
  "pr.arm",
  "pr.merge-forward",
  "ticket.transition",
  "ticket.comment",
  "chat.post",
  "owner.task",
  "host.pause",
  "host.resume",
  "host.restart-when-idle",
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface WorkstreamProject {
  projectId: string;
  role: ProjectRole;
  /** Display name of the person or agent who decides for a follow role. */
  decider?: string;
  decideAlone: DecisionKind[];
  mustAsk: (DecisionKind | ActionKind)[];
  never: ActionKind[];
}

export interface Workstream {
  id: string;
  name: string;
  ticket?: string;
  spec?: { repo: string; path: string };
  projects: WorkstreamProject[];
  channel?: { adapter: string; target: string };
  chat?: { adapter: string; channel: string };
  quietHours?: { start: string; end: string; timezone: string };
  digests?: { cron: string; timezone: string }[];
  createdAt: string;
}

export type WorkstreamInput = Omit<Workstream, "id" | "createdAt">;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ADAPTER = /^[a-z][a-z0-9-]{0,39}$/;

function timezoneError(tz: unknown): string | undefined {
  if (typeof tz !== "string" || !tz) return "a timezone such as Europe/Madrid";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return undefined;
  } catch {
    return `"${tz}" is not a timezone`;
  }
}

function listOf<T extends string>(v: unknown, allowed: readonly string[], name: string): { ok: true; list: T[] } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, list: [] };
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && allowed.includes(x))) return { ok: false, error: `${name} must list any of: ${allowed.join(", ")}` };
  return { ok: true, list: [...new Set(v as T[])] };
}

/** One project entry, or why it is refused. */
export function workstreamProjectCheck(v: unknown, projectExists: (id: string) => boolean): { ok: true; project: WorkstreamProject } | { ok: false; error: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "each project must be { projectId, role, decider?, decideAlone?, mustAsk?, never? }" };
  const p = v as Record<string, unknown>;
  const extra = Object.keys(p).find((k) => !["projectId", "role", "decider", "decideAlone", "mustAsk", "never"].includes(k));
  if (extra) return { ok: false, error: `unknown project field "${extra}"` };
  if (typeof p.projectId !== "string" || !projectExists(p.projectId)) return { ok: false, error: `no such project: ${JSON.stringify(p.projectId)}` };
  if (typeof p.role !== "string" || !(PROJECT_ROLES as readonly string[]).includes(p.role)) return { ok: false, error: `role must be one of: ${PROJECT_ROLES.join(", ")}` };
  if (p.decider !== undefined && (typeof p.decider !== "string" || !p.decider.trim() || p.decider.length > 100)) return { ok: false, error: "decider must be a name of at most 100 characters" };
  const alone = listOf<DecisionKind>(p.decideAlone, DECISION_KINDS, "decideAlone");
  if (!alone.ok) return alone;
  const ask = listOf<DecisionKind | ActionKind>(p.mustAsk, [...DECISION_KINDS, ...ACTION_KINDS], "mustAsk");
  if (!ask.ok) return ask;
  const never = listOf<ActionKind>(p.never, ACTION_KINDS, "never");
  if (!never.ok) return never;
  const clash = alone.list.find((k) => ask.list.includes(k));
  if (clash) return { ok: false, error: `${clash} can't be both decided alone and always asked` };
  return {
    ok: true,
    project: { projectId: p.projectId, role: p.role as ProjectRole, ...(p.decider ? { decider: (p.decider as string).trim() } : {}), decideAlone: alone.list, mustAsk: ask.list, never: never.list },
  };
}

/** A new workstream's body, or (with `partial`) a PATCH, checked. */
export function workstreamCheck(v: unknown, projectExists: (id: string) => boolean, partial = false): { ok: true; input: Partial<WorkstreamInput> } | { ok: false; error: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "body must be a workstream object" };
  const w = v as Record<string, unknown>;
  const fields = ["name", "ticket", "spec", "projects", "channel", "chat", "quietHours", "digests"];
  const extra = Object.keys(w).find((k) => !fields.includes(k));
  if (extra) return { ok: false, error: `unknown workstream field "${extra}"; expected ${fields.join(", ")}` };
  const out: Partial<WorkstreamInput> = {};
  if ("name" in w || !partial) {
    if (typeof w.name !== "string" || !w.name.trim() || w.name.length > 100) return { ok: false, error: "name must be 1 to 100 characters" };
    out.name = w.name.trim();
  }
  if (w.ticket !== undefined) {
    if (typeof w.ticket !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(w.ticket)) return { ok: false, error: "ticket must be a tracker key such as ABC-123" };
    out.ticket = w.ticket;
  }
  if (w.spec !== undefined) {
    const s = w.spec as Record<string, unknown> | null;
    if (!s || typeof s.repo !== "string" || !s.repo.startsWith("/") || typeof s.path !== "string" || !s.path || s.path.startsWith("/") || s.path.split("/").includes("..")) {
      return { ok: false, error: "spec must be { repo: a checkout path, path: a repo-relative file }" };
    }
    out.spec = { repo: s.repo, path: s.path };
  }
  if ("projects" in w || !partial) {
    if (!Array.isArray(w.projects) || w.projects.length > 20) return { ok: false, error: "projects must be a list of at most 20 projects" };
    const projects: WorkstreamProject[] = [];
    for (const p of w.projects) {
      const c = workstreamProjectCheck(p, projectExists);
      if (!c.ok) return c;
      if (projects.some((q) => q.projectId === c.project.projectId)) return { ok: false, error: `project ${c.project.projectId} is listed twice` };
      projects.push(c.project);
    }
    out.projects = projects;
  }
  for (const [key, inner] of [
    ["channel", "target"],
    ["chat", "channel"],
  ] as const) {
    if (w[key] === undefined) continue;
    const c = w[key] as Record<string, unknown> | null;
    if (!c || typeof c.adapter !== "string" || !ADAPTER.test(c.adapter) || typeof c[inner] !== "string" || !(c[inner] as string).trim() || (c[inner] as string).length > 500) {
      return { ok: false, error: `${key} must be { adapter: a lower-case name, ${inner}: text }` };
    }
    (out as Record<string, unknown>)[key] = { adapter: c.adapter, [inner]: (c[inner] as string).trim() };
  }
  if (w.quietHours !== undefined) {
    const q = w.quietHours as Record<string, unknown> | null;
    if (!q || typeof q.start !== "string" || !HHMM.test(q.start) || typeof q.end !== "string" || !HHMM.test(q.end)) return { ok: false, error: 'quietHours must be { start: "22:00", end: "07:00", timezone }' };
    const tz = timezoneError(q.timezone);
    if (tz) return { ok: false, error: `quietHours.timezone must be ${tz}` };
    out.quietHours = { start: q.start, end: q.end, timezone: q.timezone as string };
  }
  if (w.digests !== undefined) {
    if (!Array.isArray(w.digests) || w.digests.length > 5) return { ok: false, error: "digests must be a list of at most 5 { cron, timezone }" };
    const digests: { cron: string; timezone: string }[] = [];
    for (const d of w.digests as Array<Record<string, unknown>>) {
      const c = validateCron(d?.cron);
      if (!c.ok) return { ok: false, error: `digests: ${c.error}` };
      const tz = timezoneError(d.timezone);
      if (tz) return { ok: false, error: `digests.timezone must be ${tz}` };
      digests.push({ cron: (d.cron as string).trim(), timezone: d.timezone as string });
    }
    out.digests = digests;
  }
  return { ok: true, input: out };
}

interface Row {
  id: string;
  body: string;
  createdAt: string;
}

export class WorkstreamStore {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run("CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, body TEXT NOT NULL, createdAt TEXT NOT NULL);");
  }

  list(): Workstream[] {
    return (this.db.query("SELECT * FROM workstreams ORDER BY createdAt, rowid").all() as Row[]).map(toWorkstream);
  }

  get(id: string): Workstream | undefined {
    const r = this.db.query("SELECT * FROM workstreams WHERE id = ?").get(id) as Row | null;
    return r ? toWorkstream(r) : undefined;
  }

  /** The workstream a project belongs to (a project is in at most one). */
  forProject(projectId: string): Workstream | undefined {
    return this.list().find((w) => w.projects.some((p) => p.projectId === projectId));
  }

  /** A project already in another workstream, or undefined. */
  private conflict(projects: WorkstreamProject[], exceptId?: string): string | undefined {
    for (const p of projects) {
      const other = this.forProject(p.projectId);
      if (other && other.id !== exceptId) return `project ${p.projectId} is already in workstream "${other.name}"`;
    }
    return undefined;
  }

  create(input: WorkstreamInput): { ok: true; workstream: Workstream } | { ok: false; error: string } {
    const clash = this.conflict(input.projects);
    if (clash) return { ok: false, error: clash };
    const ws: Workstream = { ...input, id: randomUUID(), createdAt: this.clock().toISOString() };
    this.db.run("INSERT INTO workstreams (id, body, createdAt) VALUES (?, ?, ?)", [ws.id, JSON.stringify(bodyOf(ws)), ws.createdAt]);
    return { ok: true, workstream: ws };
  }

  /** Edits anything but an existing project's role: that goes through
   *  setRole. Projects may be added (with their role) or removed. */
  update(id: string, patch: Partial<WorkstreamInput>): { ok: true; workstream: Workstream } | { ok: false; status: 404 | 400 | 409; error: string } {
    const ws = this.get(id);
    if (!ws) return { ok: false, status: 404, error: "no such workstream" };
    if (patch.projects) {
      for (const p of patch.projects) {
        const before = ws.projects.find((q) => q.projectId === p.projectId);
        if (before && before.role !== p.role) return { ok: false, status: 409, error: `the role of project ${p.projectId} changes only through POST /workstreams/${id}/projects/${p.projectId}/role, with a confirm step` };
      }
      const clash = this.conflict(patch.projects, id);
      if (clash) return { ok: false, status: 409, error: clash };
    }
    const next: Workstream = { ...ws, ...patch };
    this.db.run("UPDATE workstreams SET body = ? WHERE id = ?", [JSON.stringify(bodyOf(next)), id]);
    return { ok: true, workstream: next };
  }

  delete(id: string): boolean {
    return this.db.run("DELETE FROM workstreams WHERE id = ?", [id]).changes > 0;
  }

  /** The owner changes a project's role. Without `confirm` nothing
   *  changes: the answer says what would. */
  setRole(id: string, projectId: string, role: unknown, confirm: unknown): { ok: true; changed: boolean; from: ProjectRole; to: ProjectRole; workstream: Workstream } | { ok: false; status: 400 | 404; error: string } {
    const ws = this.get(id);
    if (!ws) return { ok: false, status: 404, error: "no such workstream" };
    const entry = ws.projects.find((p) => p.projectId === projectId);
    if (!entry) return { ok: false, status: 404, error: `project ${projectId} is not in this workstream` };
    if (typeof role !== "string" || !(PROJECT_ROLES as readonly string[]).includes(role)) return { ok: false, status: 400, error: `role must be one of: ${PROJECT_ROLES.join(", ")}` };
    const to = role as ProjectRole;
    if (confirm !== true || entry.role === to) return { ok: true, changed: false, from: entry.role, to, workstream: ws };
    const next: Workstream = { ...ws, projects: ws.projects.map((p) => (p.projectId === projectId ? { ...p, role: to } : p)) };
    this.db.run("UPDATE workstreams SET body = ? WHERE id = ?", [JSON.stringify(bodyOf(next)), id]);
    return { ok: true, changed: true, from: entry.role, to, workstream: next };
  }
}

function bodyOf(ws: Workstream): WorkstreamInput {
  const { id: _id, createdAt: _c, ...rest } = ws;
  return rest;
}

function toWorkstream(r: Row): Workstream {
  return { id: r.id, createdAt: r.createdAt, ...(JSON.parse(r.body) as WorkstreamInput) };
}
