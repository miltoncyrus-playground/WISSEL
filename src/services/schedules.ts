import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { nextRunAfter, validateSchedule } from "../core/schedule-time.ts";
import type { ScheduleDef, ScheduleKind, ScheduleOutcome, ScheduleTaskTemplate } from "../core/types.ts";

/**
 * CRUD for stored schedules (docs/SDD-schedules.md §3.2) — same shape as
 * src/services/pipelines.ts's SqlitePipelineStore. No timer and no
 * execution logic here: the ticker (src/core/schedule-runner.ts) reads
 * `nextRunAt`, starts the run, and writes back through `recordRun`.
 */
export interface ScheduleStore {
  list(): Promise<ScheduleDef[]>;
  get(id: string): Promise<ScheduleDef | undefined>;
  getByName(name: string): Promise<ScheduleDef | undefined>;
  create(input: ScheduleInput): Promise<ScheduleDef>;
  update(id: string, patch: SchedulePatch): Promise<ScheduleDef>;
  delete(id: string): Promise<void>;
  /** The ticker's one write per fire or skip: advance `nextRunAt` and
   *  record what happened, together. `lastError` unset clears it;
   *  `lastRunId` unset keeps the previous one (an overlap skip still
   *  points at the run it waited on). */
  recordRun(id: string, run: ScheduleRunRecord): Promise<ScheduleDef>;
  /** A deleted pipeline's schedules: disabled, `lastError` set, so
   *  nothing fires a pipeline that's gone. Returns the ones it touched. */
  disableForPipeline(pipelineId: string, error: string): Promise<ScheduleDef[]>;
  /** Subscribes to every change; returns the unsubscribe. */
  onChange(listener: (event: ScheduleEvent) => void): () => void;
}

/** What `create` takes. `timezone` defaults to DEFAULT_SCHEDULE_TIMEZONE
 *  only at the API layer; the store requires it, so a default never
 *  hides here. */
export interface ScheduleInput {
  name: string;
  kind: ScheduleKind;
  pipelineId?: string;
  input?: string;
  repo?: string;
  taskTemplate?: ScheduleTaskTemplate;
  cron: string;
  timezone: string;
  /** Default true. */
  enabled?: boolean;
  /** Default DEFAULT_CATCH_UP_HOURS. */
  catchUpHours?: number;
}

/** What `update` takes (docs/SDD-schedules.md §3.5's PATCH fields).
 *  `null` clears an optional field. `kind` and `pipelineId` are fixed
 *  once created: a different target is a different schedule. */
export interface SchedulePatch {
  name?: string;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  input?: string | null;
  repo?: string | null;
  taskTemplate?: ScheduleTaskTemplate;
  catchUpHours?: number;
}

export interface ScheduleRunRecord {
  nextRunAt: string | null;
  lastRunAt: string;
  lastOutcome: ScheduleOutcome;
  lastError?: string;
  lastRunId?: string;
}

/** `ran` is the ticker's own write (recordRun): a listener that ticks
 *  on change (the runner) skips it, a UI refresh doesn't. */
export type ScheduleEvent =
  | { type: "schedule.created"; schedule: ScheduleDef }
  | { type: "schedule.updated"; schedule: ScheduleDef }
  | { type: "schedule.ran"; schedule: ScheduleDef }
  | { type: "schedule.deleted"; id: string };

export const DEFAULT_CATCH_UP_HOURS = 12;

const OUTCOMES: readonly ScheduleOutcome[] = ["started", "skipped-overlap", "skipped-stale", "error"];
const TEMPLATE_KEYS = new Set(["title", "body", "labels", "repo", "harnessOverride", "model"]);

/** Any refusal from the store: the message is plain enough to show a
 *  person as is (the API answers it as a 400). */
export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export interface ScheduleStoreOptions {
  /** Read once per call; tests pass a fixed clock. */
  now?: () => Date;
  /** The deep `POST /tasks` checks on a task template (harness, model,
   *  repo-required: validateNewTask, src/services/task-input.ts), which
   *  need the registry and harness pool the store doesn't own. The shape
   *  checks always run; this runs after them when given. Gets the
   *  template with the schedule's `repo` filled in when the template has
   *  none, since that is the card that will be created. */
  validateTaskTemplate?: (template: ScheduleTaskTemplate) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Refuses a pipeline schedule naming a pipeline that doesn't exist. */
  pipelineExists?: (pipelineId: string) => Promise<boolean>;
}

interface ScheduleRow {
  id: string;
  name: string;
  kind: ScheduleKind;
  pipelineId: string | null;
  input: string | null;
  repo: string | null;
  taskTemplate: string | null;
  cron: string;
  timezone: string;
  enabled: number;
  catchUpHours: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: ScheduleOutcome | null;
  lastError: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToDef(row: ScheduleRow): ScheduleDef {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    pipelineId: row.pipelineId ?? undefined,
    input: row.input ?? undefined,
    repo: row.repo ?? undefined,
    taskTemplate: row.taskTemplate ? (JSON.parse(row.taskTemplate) as ScheduleTaskTemplate) : undefined,
    cron: row.cron,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    catchUpHours: row.catchUpHours,
    nextRunAt: row.nextRunAt ?? undefined,
    lastRunAt: row.lastRunAt ?? undefined,
    lastOutcome: row.lastOutcome ?? undefined,
    lastError: row.lastError ?? undefined,
    lastRunId: row.lastRunId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const optionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

/** The template's own shape: what `POST /tasks` needs, nothing else (a
 *  `notBefore` or tool grant on a recurring card would be a mistake
 *  copied forever). Returns it normalized: empty optional strings dropped. */
function checkTemplateShape(t: unknown): ScheduleTaskTemplate {
  if (typeof t !== "object" || t === null || Array.isArray(t)) throw new ScheduleValidationError("taskTemplate must be an object with title, body and labels");
  const o = t as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!TEMPLATE_KEYS.has(key)) throw new ScheduleValidationError(`taskTemplate has an unknown field "${key}"`);
  }
  if (typeof o.title !== "string" || o.title.trim() === "") throw new ScheduleValidationError("taskTemplate.title is required");
  if (typeof o.body !== "string") throw new ScheduleValidationError("taskTemplate.body must be a string");
  if (!Array.isArray(o.labels) || !o.labels.every((l) => typeof l === "string")) throw new ScheduleValidationError("taskTemplate.labels must be a list of strings");
  for (const key of ["repo", "harnessOverride", "model"] as const) {
    if (!optionalString(o[key])) throw new ScheduleValidationError(`taskTemplate.${key} must be a string`);
  }
  return {
    title: o.title,
    body: o.body,
    labels: o.labels as string[],
    ...(o.repo ? { repo: o.repo as string } : {}),
    ...(o.harnessOverride ? { harnessOverride: o.harnessOverride as string } : {}),
    ...(o.model ? { model: o.model as string } : {}),
  };
}

/**
 * SQLite-backed schedule store. Takes the already-open `Database` the
 * board owns (`new SqliteScheduleStore(board.db)`), for the same reason
 * SqlitePipelineStore does (see its constructor doc comment). Owns its
 * table: brand new, so CREATE TABLE IF NOT EXISTS alone is correct; a
 * column added later needs the `ALTER TABLE ... ADD COLUMN` heal the
 * `tasks` table uses (src/services/board.ts).
 */
export class SqliteScheduleStore implements ScheduleStore {
  private readonly events = new EventEmitter();
  private readonly now: () => Date;

  constructor(
    private db: Database,
    private opts: ScheduleStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.db.run(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        pipelineId TEXT,
        input TEXT,
        repo TEXT,
        taskTemplate TEXT,
        cron TEXT NOT NULL,
        timezone TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        catchUpHours REAL NOT NULL DEFAULT ${DEFAULT_CATCH_UP_HOURS},
        nextRunAt TEXT,
        lastRunAt TEXT,
        lastOutcome TEXT,
        lastError TEXT,
        lastRunId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  async list(): Promise<ScheduleDef[]> {
    const rows = this.db.query("SELECT * FROM schedules ORDER BY rowid").all() as ScheduleRow[];
    return rows.map(rowToDef);
  }

  async get(id: string): Promise<ScheduleDef | undefined> {
    const row = this.db.query("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | null;
    return row ? rowToDef(row) : undefined;
  }

  async getByName(name: string): Promise<ScheduleDef | undefined> {
    const row = this.db.query("SELECT * FROM schedules WHERE name = ?").get(name) as ScheduleRow | null;
    return row ? rowToDef(row) : undefined;
  }

  async create(input: ScheduleInput): Promise<ScheduleDef> {
    const now = this.now();
    const at = now.toISOString();
    if (input.kind !== "pipeline" && input.kind !== "task") throw new ScheduleValidationError('kind must be "pipeline" or "task"');
    const draft: ScheduleDef = {
      id: randomUUID(),
      name: input.name,
      kind: input.kind,
      pipelineId: input.pipelineId || undefined,
      input: input.input || undefined,
      repo: input.repo || undefined,
      taskTemplate: input.taskTemplate,
      cron: input.cron,
      timezone: input.timezone,
      enabled: input.enabled ?? true,
      catchUpHours: input.catchUpHours ?? DEFAULT_CATCH_UP_HOURS,
      createdAt: at,
      updatedAt: at,
    };
    const full = await this.checked(draft, now);
    full.nextRunAt = full.enabled ? nextRunAfter(full.cron, full.timezone, now).toISOString() : undefined;
    this.db.run(
      "INSERT INTO schedules (id, name, kind, pipelineId, input, repo, taskTemplate, cron, timezone, enabled, catchUpHours, nextRunAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        full.id,
        full.name,
        full.kind,
        full.pipelineId ?? null,
        full.input ?? null,
        full.repo ?? null,
        full.taskTemplate ? JSON.stringify(full.taskTemplate) : null,
        full.cron,
        full.timezone,
        full.enabled ? 1 : 0,
        full.catchUpHours,
        full.nextRunAt ?? null,
        full.createdAt,
        full.updatedAt,
      ],
    );
    this.emit({ type: "schedule.created", schedule: full });
    return full;
  }

  async update(id: string, patch: SchedulePatch): Promise<ScheduleDef> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`schedule not found: ${id}`);
    const now = this.now();
    const draft: ScheduleDef = { ...existing, updatedAt: now.toISOString() };
    if (patch.name !== undefined) draft.name = patch.name;
    if (patch.cron !== undefined) draft.cron = patch.cron;
    if (patch.timezone !== undefined) draft.timezone = patch.timezone;
    if (patch.enabled !== undefined) draft.enabled = patch.enabled;
    if (patch.input !== undefined) draft.input = patch.input || undefined;
    if (patch.repo !== undefined) draft.repo = patch.repo || undefined;
    if (patch.taskTemplate !== undefined) draft.taskTemplate = patch.taskTemplate;
    if (patch.catchUpHours !== undefined) draft.catchUpHours = patch.catchUpHours;
    const full = await this.checked(draft, now);
    // A new cadence (or switching on) counts from now; an untouched one
    // keeps its pending run, even an overdue one the ticker hasn't
    // reached yet.
    if (full.cron !== existing.cron || full.timezone !== existing.timezone || full.enabled !== existing.enabled) {
      full.nextRunAt = full.enabled ? nextRunAfter(full.cron, full.timezone, now).toISOString() : undefined;
    }
    this.db.run(
      "UPDATE schedules SET name = ?, input = ?, repo = ?, taskTemplate = ?, cron = ?, timezone = ?, enabled = ?, catchUpHours = ?, nextRunAt = ?, updatedAt = ? WHERE id = ?",
      [
        full.name,
        full.input ?? null,
        full.repo ?? null,
        full.taskTemplate ? JSON.stringify(full.taskTemplate) : null,
        full.cron,
        full.timezone,
        full.enabled ? 1 : 0,
        full.catchUpHours,
        full.nextRunAt ?? null,
        full.updatedAt,
        id,
      ],
    );
    this.emit({ type: "schedule.updated", schedule: full });
    return full;
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`schedule not found: ${id}`);
    this.db.run("DELETE FROM schedules WHERE id = ?", [id]);
    this.emit({ type: "schedule.deleted", id });
  }

  async recordRun(id: string, run: ScheduleRunRecord): Promise<ScheduleDef> {
    if (!OUTCOMES.includes(run.lastOutcome)) throw new ScheduleValidationError(`unknown lastOutcome "${run.lastOutcome}"`);
    const result = this.db.run(
      "UPDATE schedules SET nextRunAt = ?, lastRunAt = ?, lastOutcome = ?, lastError = ?, lastRunId = COALESCE(?, lastRunId) WHERE id = ?",
      [run.nextRunAt, run.lastRunAt, run.lastOutcome, run.lastError ?? null, run.lastRunId ?? null, id],
    );
    if (result.changes === 0) throw new Error(`schedule not found: ${id}`);
    const updated = (await this.get(id))!;
    this.emit({ type: "schedule.ran", schedule: updated });
    return updated;
  }

  async disableForPipeline(pipelineId: string, error: string): Promise<ScheduleDef[]> {
    const ids = (this.db.query("SELECT id FROM schedules WHERE kind = 'pipeline' AND pipelineId = ?").all(pipelineId) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return [];
    this.db.run("UPDATE schedules SET enabled = 0, nextRunAt = NULL, lastError = ?, updatedAt = ? WHERE kind = 'pipeline' AND pipelineId = ?", [
      error,
      this.now().toISOString(),
      pipelineId,
    ]);
    const touched: ScheduleDef[] = [];
    for (const id of ids) {
      const s = (await this.get(id))!;
      touched.push(s);
      this.emit({ type: "schedule.updated", schedule: s });
    }
    return touched;
  }

  onChange(listener: (event: ScheduleEvent) => void): () => void {
    this.events.on("change", listener);
    return () => this.events.off("change", listener);
  }

  private emit(event: ScheduleEvent): void {
    this.events.emit("change", event);
  }

  /** Every rule a stored schedule obeys, whether it was just created or
   *  just patched. Returns the schedule with its template normalized. */
  private async checked(s: ScheduleDef, now: Date): Promise<ScheduleDef> {
    if (typeof s.name !== "string" || s.name.trim() === "") throw new ScheduleValidationError("name is required");
    const sameName = await this.getByName(s.name);
    if (sameName && sameName.id !== s.id) throw new ScheduleValidationError(`a schedule named "${s.name}" already exists`);
    if (typeof s.enabled !== "boolean") throw new ScheduleValidationError("enabled must be true or false");
    if (typeof s.catchUpHours !== "number" || !Number.isFinite(s.catchUpHours) || s.catchUpHours < 0) {
      throw new ScheduleValidationError("catchUpHours must be a number of hours, 0 or more (0 = never catch up)");
    }
    if (!optionalString(s.input)) throw new ScheduleValidationError("input must be a string");
    if (!optionalString(s.repo)) throw new ScheduleValidationError("repo must be a string");
    const time = validateSchedule({ cron: s.cron, timezone: s.timezone }, now);
    if (!time.ok) throw new ScheduleValidationError(time.error);

    if (s.kind === "pipeline") {
      if (typeof s.pipelineId !== "string" || s.pipelineId === "") throw new ScheduleValidationError("a pipeline schedule needs a pipelineId");
      if (s.taskTemplate !== undefined) throw new ScheduleValidationError("a pipeline schedule has no taskTemplate");
      if (this.opts.pipelineExists && !(await this.opts.pipelineExists(s.pipelineId))) {
        throw new ScheduleValidationError(`pipeline not found: ${s.pipelineId}`);
      }
      return s;
    }

    if (s.pipelineId !== undefined) throw new ScheduleValidationError("a task schedule has no pipelineId");
    if (s.input !== undefined) throw new ScheduleValidationError("a task schedule has no input; put it in taskTemplate.body");
    if (s.taskTemplate === undefined) throw new ScheduleValidationError("a task schedule needs a taskTemplate");
    const template = checkTemplateShape(s.taskTemplate);
    if (this.opts.validateTaskTemplate) {
      const deep = await this.opts.validateTaskTemplate({ ...template, ...(template.repo || !s.repo ? {} : { repo: s.repo }) });
      if (!deep.ok) throw new ScheduleValidationError(`taskTemplate: ${deep.error}`);
    }
    return { ...s, taskTemplate: template };
  }
}
