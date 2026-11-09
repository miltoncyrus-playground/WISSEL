import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { type GateCommandRunner, runGateCommand, shellWords, tailLines } from "./merge-gate.ts";

/**
 * Owner tasks (docs/SDD-coordinator.md §3.4, §4.14): work only the owner
 * can do (log in to gh, approve a token, buy a domain), with the cards
 * that wait on it. Kept in the board database; shown in Needs a human
 * (src/services/needs-you.ts); the orchestrator holds a card an open
 * task blocks (Orchestrator.sweep). Done runs `check` (an argv, never a
 * shell) under the merge gate's runner with a timeout, and only an exit
 * code of 0 marks the task done.
 */
export interface OwnerTask {
  id: string;
  title: string;
  why: string;
  /** Shown as tick-boxes. */
  steps: string[];
  /** argv run after Done, with a timeout. */
  check?: string[];
  /** Card ids waiting on it. */
  blocks: string[];
  status: "open" | "done" | "dismissed";
}

export type NewOwnerTask = Omit<OwnerTask, "id" | "status">;

export interface OwnerTaskStore {
  create(task: NewOwnerTask): Promise<OwnerTask>;
  get(id: string): Promise<OwnerTask | undefined>;
  /** Open tasks first, then by creation order. */
  list(): Promise<OwnerTask[]>;
  setStatus(id: string, status: OwnerTask["status"]): Promise<OwnerTask>;
  /** Every card id an open task blocks. */
  heldCardIds(): Promise<Set<string>>;
}

/** How long a check may run before Done is refused as timed out. */
export const OWNER_TASK_CHECK_TIMEOUT_MS = 60_000;

interface Row {
  id: string;
  title: string;
  why: string;
  steps: string;
  check: string | null;
  blocks: string;
  status: OwnerTask["status"];
}

function rowToTask(row: Row): OwnerTask {
  return {
    id: row.id,
    title: row.title,
    why: row.why,
    steps: JSON.parse(row.steps) as string[],
    ...(row.check ? { check: JSON.parse(row.check) as string[] } : {}),
    blocks: JSON.parse(row.blocks) as string[],
    status: row.status,
  };
}

/** Shares the board's connection, like SqlitePipelineStore (see
 *  SqliteBoard.db for why it must be the same one). */
export class SqliteOwnerTaskStore implements OwnerTaskStore {
  constructor(private db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS owner_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        why TEXT NOT NULL,
        steps TEXT NOT NULL,
        "check" TEXT,
        blocks TEXT NOT NULL,
        status TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);
  }

  async create(task: NewOwnerTask): Promise<OwnerTask> {
    const id = randomUUID();
    this.db
      .query(`INSERT INTO owner_tasks (id, title, why, steps, "check", blocks, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(id, task.title, task.why, JSON.stringify(task.steps), task.check ? JSON.stringify(task.check) : null, JSON.stringify(task.blocks), new Date().toISOString());
    return (await this.get(id))!;
  }

  async get(id: string): Promise<OwnerTask | undefined> {
    const row = this.db.query<Row, [string]>(`SELECT * FROM owner_tasks WHERE id = ?`).get(id);
    return row ? rowToTask(row) : undefined;
  }

  async list(): Promise<OwnerTask[]> {
    return this.db
      .query<Row, []>(`SELECT * FROM owner_tasks ORDER BY status = 'open' DESC, createdAt ASC, rowid ASC`)
      .all()
      .map(rowToTask);
  }

  async setStatus(id: string, status: OwnerTask["status"]): Promise<OwnerTask> {
    const changes = this.db.query(`UPDATE owner_tasks SET status = ? WHERE id = ?`).run(status, id).changes;
    if (changes === 0) throw new Error(`owner task not found: ${id}`);
    return (await this.get(id))!;
  }

  async heldCardIds(): Promise<Set<string>> {
    const held = new Set<string>();
    for (const row of this.db.query<{ blocks: string }, []>(`SELECT blocks FROM owner_tasks WHERE status = 'open'`).all()) {
      for (const id of JSON.parse(row.blocks) as string[]) held.add(id);
    }
    return held;
  }
}

function stringList(v: unknown, name: string, allowEmpty = true): { ok: true; list: string[] } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, list: [] };
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.trim().length > 0)) return { ok: false, error: `${name} must be a list of non-empty strings` };
  if (!allowEmpty && v.length === 0) return { ok: false, error: `${name} must not be empty` };
  return { ok: true, list: v };
}

/** The body of POST /owner-tasks: title and why required, the lists optional. */
export function validateNewOwnerTask(body: unknown): { ok: true; task: NewOwnerTask } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (typeof b.title !== "string" || b.title.trim() === "") return { ok: false, error: "title is required" };
  if (typeof b.why !== "string" || b.why.trim() === "") return { ok: false, error: "why is required" };
  const steps = stringList(b.steps, "steps");
  if (!steps.ok) return steps;
  const blocks = stringList(b.blocks, "blocks");
  if (!blocks.ok) return blocks;
  const task: NewOwnerTask = { title: b.title.trim(), why: b.why.trim(), steps: steps.list, blocks: blocks.list };
  if (b.check !== undefined && b.check !== null) {
    const check = stringList(b.check, "check", false);
    if (!check.ok) return check;
    task.check = check.list;
  }
  return { ok: true, task };
}

export type DoneOutcome = { ok: true; value: OwnerTask } | { ok: false; status: 404 | 409; error: string; output?: string };

export interface DoneDeps {
  runner?: GateCommandRunner;
  /** Where the check runs; defaults to the server's cwd. */
  cwd?: string;
  timeoutMs?: number;
}

/** Done: runs the check (if any) and marks the task done only when it
 *  exits 0; otherwise the task stays open and the output comes back. */
export async function completeOwnerTask(store: OwnerTaskStore, id: string, deps: DoneDeps = {}): Promise<DoneOutcome> {
  const task = await store.get(id);
  if (!task) return { ok: false, status: 404, error: `owner task not found: ${id}` };
  if (task.check && task.check.length > 0) {
    const timeoutMs = deps.timeoutMs ?? OWNER_TASK_CHECK_TIMEOUT_MS;
    const res = await (deps.runner ?? runGateCommand)(task.check, { cwd: deps.cwd ?? process.cwd(), timeoutMs });
    if (res.timedOut || res.exitCode !== 0) {
      const why = res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited ${res.exitCode}`;
      return { ok: false, status: 409, error: `check "${shellWords(task.check)}" ${why}; the task stays open`, output: tailLines(res.output) };
    }
  }
  return { ok: true, value: await store.setStatus(id, "done") };
}
