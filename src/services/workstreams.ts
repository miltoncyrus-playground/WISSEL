import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Workstreams and roles (docs/SDD-coordinator.md §3.1, §4.13, §5): a
 * workstream groups existing projects under one name, ticket and spec,
 * and gives each project a role, kept in the board database. Only the
 * owner changes a role, through the confirm step of
 * `POST /workstreams/:id/projects/:projectId/role` (validateRoleChange);
 * the change is stamped on the entry as `roleChangedAt`. `chat` (§4.10)
 * is left out for now; `channel` is an opaque adapter/target pair.
 */
export type ProjectRole = "shadow" | "follow" | "decide" | "decide-over";
export const PROJECT_ROLES: readonly ProjectRole[] = ["shadow", "follow", "decide", "decide-over"];
/** A decision kind ("naming", "schema", ...) or a §4.3 action kind ("pr.arm", ...). */
export type DecisionKind = string;
export type ActionKind = string;

export interface WorkstreamProject {
  projectId: string;
  role: ProjectRole;
  decider?: string;
  decideAlone: DecisionKind[];
  mustAsk: DecisionKind[];
  never: ActionKind[];
  /** When the owner last changed the role; absent until the first change. */
  roleChangedAt?: string;
}

export interface Workstream {
  id: string;
  name: string;
  ticket?: string;
  spec?: { repo: string; path: string };
  projects: WorkstreamProject[];
  channel?: { adapter: string; target: string };
  quietHours?: { start: string; end: string; timezone: string };
  digests?: { cron: string; timezone: string }[];
  /** Where the old coordinator's channel reading stopped (§7 step 1,
   *  src/services/workstream-import.ts): set by import only, not PATCH. */
  channelCursor?: string;
  createdAt: string;
}

export type NewWorkstream = Omit<Workstream, "id" | "createdAt">;
/** PATCH body: absent keeps, null clears. Roles change only through setRole. */
export type WorkstreamPatch = { [K in Exclude<keyof NewWorkstream, "projects">]?: NewWorkstream[K] | null };
/** The role change body minus `confirm`; a list or decider left out is kept. */
export type RoleChange = { role: ProjectRole } & Partial<Pick<WorkstreamProject, "decider" | "decideAlone" | "mustAsk" | "never">>;

export interface WorkstreamStore {
  create(ws: NewWorkstream): Promise<Workstream>;
  get(id: string): Promise<Workstream | undefined>;
  /** In creation order. */
  list(): Promise<Workstream[]>;
  /** These three throw when the workstream (or, for setRole, its project entry) is missing. */
  update(id: string, patch: WorkstreamPatch): Promise<Workstream>;
  delete(id: string): Promise<void>;
  setRole(id: string, projectId: string, change: RoleChange): Promise<Workstream>;
}

type Row = { id: string; name: string; data: string; createdAt: string };
const rowToWorkstream = (row: Row): Workstream => ({ id: row.id, name: row.name, ...(JSON.parse(row.data) as Omit<NewWorkstream, "name">), createdAt: row.createdAt });

/** Shares the board's connection, like SqliteOwnerTaskStore. The
 *  optional fields and the project roles live in one JSON column: they
 *  are read whole and never queried. */
export class SqliteWorkstreamStore implements WorkstreamStore {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS workstreams (id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL)`);
  }

  private save(ws: Workstream): void {
    const { id, name, createdAt: _at, ...data } = ws;
    this.db.query(`UPDATE workstreams SET name = ?, data = ? WHERE id = ?`).run(name, JSON.stringify(data), id);
  }

  private async must(id: string): Promise<Workstream> {
    const ws = await this.get(id);
    if (!ws) throw new Error(`workstream not found: ${id}`);
    return ws;
  }

  async create(ws: NewWorkstream): Promise<Workstream> {
    const id = randomUUID();
    const { name, ...data } = ws;
    this.db.query(`INSERT INTO workstreams (id, name, data, createdAt) VALUES (?, ?, ?, ?)`).run(id, name, JSON.stringify(data), new Date().toISOString());
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Workstream | undefined> {
    const row = this.db.query<Row, [string]>(`SELECT * FROM workstreams WHERE id = ?`).get(id);
    return row ? rowToWorkstream(row) : undefined;
  }

  async list(): Promise<Workstream[]> {
    return this.db.query<Row, []>(`SELECT * FROM workstreams ORDER BY createdAt ASC, rowid ASC`).all().map(rowToWorkstream);
  }

  async update(id: string, patch: WorkstreamPatch): Promise<Workstream> {
    const ws: Record<string, unknown> = { ...(await this.must(id)) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete ws[key];
      else if (value !== undefined) ws[key] = value;
    }
    this.save(ws as unknown as Workstream);
    return (await this.get(id))!;
  }

  async delete(id: string): Promise<void> {
    if (this.db.query(`DELETE FROM workstreams WHERE id = ?`).run(id).changes === 0) throw new Error(`workstream not found: ${id}`);
  }

  async setRole(id: string, projectId: string, change: RoleChange): Promise<Workstream> {
    const ws = await this.must(id);
    const entry = ws.projects.find((p) => p.projectId === projectId);
    if (!entry) throw new Error(`project ${projectId} not in workstream ${id}`);
    Object.assign(entry, change, { roleChangedAt: new Date().toISOString() });
    this.save(ws);
    return (await this.get(id))!;
  }
}

type Check<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function nonEmptyString(v: unknown, name: string): Check<string> {
  return typeof v === "string" && v.trim() !== "" ? { ok: true, value: v.trim() } : fail(`${name} must be a non-empty string`);
}

function stringList(v: unknown, name: string): Check<string[]> {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim().length > 0)) return fail(`${name} must be a list of non-empty strings`);
  return { ok: true, value: v };
}

/** An object whose named keys are all non-empty strings, e.g. spec or channel. */
function stringFields(v: unknown, name: string, keys: readonly string[]): Check<Record<string, string>> {
  if (!isRecord(v)) return fail(`${name} must be an object with ${keys.join(", ")}`);
  const out: Record<string, string> = {};
  for (const key of keys) {
    const s = nonEmptyString(v[key], `${name}.${key}`);
    if (!s.ok) return s;
    out[key] = s.value;
  }
  return { ok: true, value: out };
}

/** The role, decider and the three lists shared by a project entry and a
 *  role change: written onto `out` when present (lists left out become
 *  [] with `defaults`, else stay as they were). */
function roleDetails(v: Record<string, unknown>, out: Partial<WorkstreamProject>, defaults: boolean): Check<void> {
  if (typeof v.role !== "string" || !(PROJECT_ROLES as readonly string[]).includes(v.role)) return fail(`role must be one of ${PROJECT_ROLES.join(", ")}`);
  out.role = v.role as ProjectRole;
  if (v.decider !== undefined) {
    const d = nonEmptyString(v.decider, "decider");
    if (!d.ok) return d;
    out.decider = d.value;
  }
  for (const key of ["decideAlone", "mustAsk", "never"] as const) {
    if (v[key] === undefined) {
      if (defaults) out[key] = [];
      continue;
    }
    const l = stringList(v[key], key);
    if (!l.ok) return l;
    out[key] = l.value;
  }
  return { ok: true, value: undefined };
}

function workstreamProject(v: unknown): Check<WorkstreamProject> {
  if (!isRecord(v)) return fail("projects entries must be objects");
  const projectId = nonEmptyString(v.projectId, "projectId");
  if (!projectId.ok) return projectId;
  const entry: Partial<WorkstreamProject> = { projectId: projectId.value };
  const details = roleDetails(v, entry, true);
  return details.ok ? { ok: true, value: entry as WorkstreamProject } : details;
}

/** The optional §3.1 fields and the keys each must carry; `chat` is
 *  deliberately absent, `ticket` is a plain string, `digests` a list. */
const OBJECT_FIELDS: Record<string, readonly string[]> = { spec: ["repo", "path"], channel: ["adapter", "target"], quietHours: ["start", "end", "timezone"] };
const OPTIONAL_FIELDS = ["ticket", "digests", ...Object.keys(OBJECT_FIELDS)];

function optionalField(key: string, v: unknown): Check<unknown> {
  if (key === "ticket") return nonEmptyString(v, "ticket");
  if (key in OBJECT_FIELDS) return stringFields(v, key, OBJECT_FIELDS[key]!);
  if (!Array.isArray(v)) return fail("digests must be a list");
  const out: unknown[] = [];
  for (const d of v) {
    const c = stringFields(d, "digests[]", ["cron", "timezone"]);
    if (!c.ok) return c;
    out.push(c.value);
  }
  return { ok: true, value: out };
}

/** The body of POST /workstreams: name required, projects optional
 *  (each with a projectId and a role; the route checks the project
 *  exists), the §3.1 optional fields, no `chat`. */
export function validateNewWorkstream(body: unknown): { ok: true; workstream: NewWorkstream } | { ok: false; error: string } {
  if (!isRecord(body)) return fail("body must be an object");
  const name = nonEmptyString(body.name, "name");
  if (!name.ok) return name;
  const ws: NewWorkstream = { name: name.value, projects: [] };
  if (body.projects !== undefined) {
    if (!Array.isArray(body.projects)) return fail("projects must be a list");
    for (const p of body.projects) {
      const entry = workstreamProject(p);
      if (!entry.ok) return entry;
      if (ws.projects.some((e) => e.projectId === entry.value.projectId)) return fail(`project ${entry.value.projectId} is listed twice`);
      ws.projects.push(entry.value);
    }
  }
  for (const key of Object.keys(body)) {
    if (key === "name" || key === "projects") continue;
    if (!OPTIONAL_FIELDS.includes(key)) return fail(`unknown field ${key}`);
    const f = optionalField(key, body[key]);
    if (!f.ok) return f;
    (ws as Record<string, unknown>)[key] = f.value;
  }
  return { ok: true, workstream: ws };
}

/** The body of PATCH /workstreams/:id: name and the optional fields;
 *  null clears an optional field. `projects` is refused: roles change
 *  only through the confirm step. */
export function validateWorkstreamPatch(body: unknown): { ok: true; patch: WorkstreamPatch } | { ok: false; error: string } {
  if (!isRecord(body) || Object.keys(body).length === 0) return fail("body must be an object with at least one field");
  const patch: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(body)) {
    if (key === "projects") return fail("roles change through POST /workstreams/:id/projects/:projectId/role");
    if (key !== "name" && !OPTIONAL_FIELDS.includes(key)) return fail(`unknown field ${key}`);
    if (v === null && key !== "name") {
      patch[key] = null;
      continue;
    }
    const f = key === "name" ? nonEmptyString(v, "name") : optionalField(key, v);
    if (!f.ok) return f;
    patch[key] = f.value;
  }
  return { ok: true, patch: patch as WorkstreamPatch };
}

/** The body of POST /workstreams/:id/projects/:projectId/role. The
 *  confirm step: `confirm: true` must be present, or the change is
 *  refused (§4.13: only the owner, with a confirm step). */
export function validateRoleChange(body: unknown): { ok: true; change: RoleChange } | { ok: false; error: string } {
  if (!isRecord(body)) return fail("body must be an object");
  if (body.confirm !== true) return fail("a role change needs confirm: true");
  const change: Partial<WorkstreamProject> = {};
  const details = roleDetails(body, change, false);
  return details.ok ? { ok: true, change: change as RoleChange } : details;
}
