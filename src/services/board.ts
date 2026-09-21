import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

/**
 * The board is the single source of truth. Everything else is a client
 * of this, including the frontend. Nothing talks to tmux directly.
 */
export interface Board {
  list(filter?: Partial<Pick<TaskCard, "status" | "repo">>): Promise<TaskCard[]>;
  get(id: string): Promise<TaskCard | undefined>;
  create(card: Omit<TaskCard, "id" | "status">): Promise<TaskCard>;
  move(id: string, status: TaskCard["status"]): Promise<TaskCard>;
  setDependencies(id: string, dependsOn: string[]): Promise<TaskCard>;
  /** Records which Harness actually ran a task — called once wissel
   *  starts executing it locally, before the run finishes, so the board
   *  can show a harness as active live. See TaskCard.harness. */
  setHarness(id: string, harnessId: string): Promise<TaskCard>;
  recordDecision(decision: RoutingDecision): Promise<void>;
  /** Most recent routing decision for a task, if any — what `wissel why`
   *  reads. */
  getDecision(taskId: string): Promise<RoutingDecision | undefined>;
  recordResult(result: TaskResult): Promise<void>;
  /** Most recent execution result for a task, if any — what the board
   *  UI's task detail panel shows once a run has finished. */
  getResult(taskId: string): Promise<TaskResult | undefined>;
  /** Manual override. Every one of these is a labelled router eval case. */
  recordOverride(taskId: string, routerPick: string, humanPick: string): Promise<void>;
  /** Removes a task and its recorded decisions/results/overrides. */
  delete(id: string): Promise<void>;
}

export type BoardEvent =
  | { type: "task.created"; task: TaskCard }
  | { type: "task.moved"; task: TaskCard }
  | { type: "task.dependencies"; task: TaskCard }
  | { type: "task.harness"; task: TaskCard }
  | { type: "task.decided"; decision: RoutingDecision }
  | { type: "task.result"; result: TaskResult }
  | { type: "task.override"; taskId: string; routerPick: string; humanPick: string }
  | { type: "task.deleted"; taskId: string };

interface TaskRow {
  id: string;
  title: string;
  body: string;
  labels: string;
  repo: string;
  status: TaskCard["status"];
  routedTo: string | null;
  dependsOn: string;
  parentTaskId: string | null;
  harness: string | null;
  pushbackCount: number | null;
  reviewLineageId: string | null;
  supersededBy: string | null;
  escalationContext: string | null;
}

function rowToCard(row: TaskRow): TaskCard {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    labels: JSON.parse(row.labels) as string[],
    repo: row.repo,
    status: row.status,
    routedTo: row.routedTo ?? undefined,
    dependsOn: JSON.parse(row.dependsOn) as string[],
    parentTaskId: row.parentTaskId ?? undefined,
    harness: row.harness ?? undefined,
    pushbackCount: row.pushbackCount ?? undefined,
    reviewLineageId: row.reviewLineageId ?? undefined,
    supersededBy: row.supersededBy ?? undefined,
    escalationContext: row.escalationContext ?? undefined,
  };
}

/**
 * SQLite-backed board. One file (or `:memory:` for tests), matching the
 * pattern agetor already uses for its own task store — no new dependency,
 * `bun:sqlite` ships with the runtime.
 */
export class SqliteBoard implements Board {
  private db: Database;
  readonly events = new EventEmitter();

  constructor(dbPath = ":memory:") {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        labels TEXT NOT NULL,
        repo TEXT NOT NULL,
        status TEXT NOT NULL,
        routedTo TEXT,
        dependsOn TEXT NOT NULL DEFAULT '[]',
        parentTaskId TEXT,
        harness TEXT,
        pushbackCount INTEGER,
        reviewLineageId TEXT,
        supersededBy TEXT,
        escalationContext TEXT
      );
    `);
    // Heals a pre-existing on-disk DB from before these columns existed —
    // CREATE TABLE IF NOT EXISTS above only covers a fresh DB. Ignoring
    // the error is the SQLite-idiomatic "add column if missing," since
    // there's no ADD COLUMN IF NOT EXISTS guard old enough SQLite builds
    // can rely on. Every column added to `tasks` after the original
    // schema needs one of these, or an existing on-disk DB breaks the
    // moment that column is written to (parentTaskId shipped without
    // one — found live, against a real pre-existing DB, when this task
    // couldn't create a task at all).
    for (const ddl of [
      "ALTER TABLE tasks ADD COLUMN harness TEXT;",
      "ALTER TABLE tasks ADD COLUMN parentTaskId TEXT;",
      "ALTER TABLE tasks ADD COLUMN pushbackCount INTEGER;",
      "ALTER TABLE tasks ADD COLUMN reviewLineageId TEXT;",
      "ALTER TABLE tasks ADD COLUMN supersededBy TEXT;",
      "ALTER TABLE tasks ADD COLUMN escalationContext TEXT;",
    ]) {
      try {
        this.db.run(ddl);
      } catch {
        // already has the column
      }
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        taskId TEXT NOT NULL,
        matchedTags TEXT NOT NULL,
        candidates TEXT NOT NULL,
        selected TEXT,
        confident INTEGER NOT NULL DEFAULT 1,
        reason TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decidedAt TEXT NOT NULL
      );
    `);
    try {
      this.db.run("ALTER TABLE routing_decisions ADD COLUMN confident INTEGER NOT NULL DEFAULT 1;");
    } catch {
      // already has the column
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_results (
        taskId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT NOT NULL,
        artifacts TEXT,
        worktree TEXT,
        actualCost REAL,
        harnessId TEXT,
        subagents TEXT,
        verdict TEXT,
        reviewFeedback TEXT
      );
    `);
    // actualCost/harnessId shipped on TaskResult well before this table
    // learned to store them — found while adding the worktree column:
    // GET /tasks/:id/result had been silently dropping both ever since,
    // even though telemetry's own log captured them correctly the whole
    // time (finishResult records them into both places). Healed the same
    // way every other column added after the original schema is healed.
    for (const ddl of [
      "ALTER TABLE task_results ADD COLUMN worktree TEXT;",
      "ALTER TABLE task_results ADD COLUMN actualCost REAL;",
      "ALTER TABLE task_results ADD COLUMN harnessId TEXT;",
      "ALTER TABLE task_results ADD COLUMN subagents TEXT;",
      "ALTER TABLE task_results ADD COLUMN verdict TEXT;",
      "ALTER TABLE task_results ADD COLUMN reviewFeedback TEXT;",
    ]) {
      try {
        this.db.run(ddl);
      } catch {
        // already has the column
      }
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS overrides (
        taskId TEXT NOT NULL,
        routerPick TEXT NOT NULL,
        humanPick TEXT NOT NULL,
        recordedAt TEXT NOT NULL
      );
    `);
  }

  async list(filter?: Partial<Pick<TaskCard, "status" | "repo">>): Promise<TaskCard[]> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter?.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.repo) {
      clauses.push("repo = ?");
      params.push(filter.repo);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM tasks ${where} ORDER BY rowid`).all(...params) as TaskRow[];
    return rows.map(rowToCard);
  }

  async get(id: string): Promise<TaskCard | undefined> {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null;
    return row ? rowToCard(row) : undefined;
  }

  async create(card: Omit<TaskCard, "id" | "status">): Promise<TaskCard> {
    const full: TaskCard = { ...card, id: randomUUID(), status: "inbox", dependsOn: card.dependsOn ?? [] };
    this.db.run(
      "INSERT INTO tasks (id, title, body, labels, repo, status, routedTo, dependsOn, parentTaskId, harness, pushbackCount, reviewLineageId, supersededBy, escalationContext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        full.id,
        full.title,
        full.body,
        JSON.stringify(full.labels),
        full.repo,
        full.status,
        full.routedTo ?? null,
        JSON.stringify(full.dependsOn),
        full.parentTaskId ?? null,
        full.harness ?? null,
        full.pushbackCount ?? null,
        full.reviewLineageId ?? null,
        full.supersededBy ?? null,
        full.escalationContext ?? null,
      ],
    );
    this.events.emit("event", { type: "task.created", task: full } satisfies BoardEvent);
    return full;
  }

  async move(id: string, status: TaskCard["status"]): Promise<TaskCard> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    this.db.run("UPDATE tasks SET status = ? WHERE id = ?", [status, id]);
    const updated: TaskCard = { ...existing, status };
    this.events.emit("event", { type: "task.moved", task: updated } satisfies BoardEvent);
    return updated;
  }

  async setDependencies(id: string, dependsOn: string[]): Promise<TaskCard> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    this.db.run("UPDATE tasks SET dependsOn = ? WHERE id = ?", [JSON.stringify(dependsOn), id]);
    const updated: TaskCard = { ...existing, dependsOn };
    this.events.emit("event", { type: "task.dependencies", task: updated } satisfies BoardEvent);
    return updated;
  }

  async setHarness(id: string, harnessId: string): Promise<TaskCard> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    this.db.run("UPDATE tasks SET harness = ? WHERE id = ?", [harnessId, id]);
    const updated: TaskCard = { ...existing, harness: harnessId };
    this.events.emit("event", { type: "task.harness", task: updated } satisfies BoardEvent);
    return updated;
  }

  async recordDecision(decision: RoutingDecision): Promise<void> {
    this.db.run(
      "INSERT INTO routing_decisions (taskId, matchedTags, candidates, selected, confident, reason, strategy, decidedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        decision.taskId,
        JSON.stringify(decision.matchedTags),
        JSON.stringify(decision.candidates),
        decision.selected,
        decision.confident ? 1 : 0,
        decision.reason,
        decision.strategy,
        decision.decidedAt,
      ],
    );
    this.db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", [decision.selected, decision.taskId]);
    this.events.emit("event", { type: "task.decided", decision } satisfies BoardEvent);
  }

  async getDecision(taskId: string): Promise<RoutingDecision | undefined> {
    const row = this.db
      .query("SELECT * FROM routing_decisions WHERE taskId = ? ORDER BY rowid DESC LIMIT 1")
      .get(taskId) as
      | { taskId: string; matchedTags: string; candidates: string; selected: string | null; confident: number; reason: string; strategy: RoutingDecision["strategy"]; decidedAt: string }
      | null;
    if (!row) return undefined;
    return {
      taskId: row.taskId,
      matchedTags: JSON.parse(row.matchedTags) as string[],
      candidates: JSON.parse(row.candidates) as RoutingDecision["candidates"],
      selected: row.selected,
      confident: row.confident === 1,
      reason: row.reason,
      strategy: row.strategy,
      decidedAt: row.decidedAt,
    };
  }

  async recordResult(result: TaskResult): Promise<void> {
    this.db.run(
      "INSERT INTO task_results (taskId, agentId, ok, summary, artifacts, worktree, actualCost, harnessId, subagents, verdict, reviewFeedback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        result.taskId,
        result.agentId,
        result.ok ? 1 : 0,
        result.summary,
        result.artifacts ? JSON.stringify(result.artifacts) : null,
        result.worktree ? JSON.stringify(result.worktree) : null,
        result.actualCost ?? null,
        result.harnessId ?? null,
        result.subagents ? JSON.stringify(result.subagents) : null,
        result.verdict ?? null,
        result.reviewFeedback ?? null,
      ],
    );
    this.events.emit("event", { type: "task.result", result } satisfies BoardEvent);
  }

  async getResult(taskId: string): Promise<TaskResult | undefined> {
    const row = this.db.query("SELECT * FROM task_results WHERE taskId = ? ORDER BY rowid DESC LIMIT 1").get(taskId) as {
      taskId: string;
      agentId: string;
      ok: number;
      summary: string;
      artifacts: string | null;
      worktree: string | null;
      actualCost: number | null;
      harnessId: string | null;
      subagents: string | null;
      verdict: TaskResult["verdict"] | null;
      reviewFeedback: string | null;
    } | null;
    if (!row) return undefined;
    return {
      taskId: row.taskId,
      agentId: row.agentId,
      ok: row.ok === 1,
      summary: row.summary,
      artifacts: row.artifacts ? (JSON.parse(row.artifacts) as string[]) : undefined,
      worktree: row.worktree ? (JSON.parse(row.worktree) as TaskResult["worktree"]) : undefined,
      actualCost: row.actualCost ?? undefined,
      harnessId: row.harnessId ?? undefined,
      subagents: row.subagents ? (JSON.parse(row.subagents) as TaskResult["subagents"]) : undefined,
      verdict: row.verdict ?? undefined,
      reviewFeedback: row.reviewFeedback ?? undefined,
    };
  }

  async recordOverride(taskId: string, routerPick: string, humanPick: string): Promise<void> {
    this.db.run(
      "INSERT INTO overrides (taskId, routerPick, humanPick, recordedAt) VALUES (?, ?, ?, ?)",
      [taskId, routerPick, humanPick, new Date().toISOString()],
    );
    this.events.emit("event", { type: "task.override", taskId, routerPick, humanPick } satisfies BoardEvent);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`task not found: ${id}`);
    this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
    this.db.run("DELETE FROM routing_decisions WHERE taskId = ?", [id]);
    this.db.run("DELETE FROM task_results WHERE taskId = ?", [id]);
    this.db.run("DELETE FROM overrides WHERE taskId = ?", [id]);
    this.events.emit("event", { type: "task.deleted", taskId: id } satisfies BoardEvent);
  }
}
