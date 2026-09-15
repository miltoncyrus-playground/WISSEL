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
  recordDecision(decision: RoutingDecision): Promise<void>;
  recordResult(result: TaskResult): Promise<void>;
  /** Manual override. Every one of these is a labelled router eval case. */
  recordOverride(taskId: string, routerPick: string, humanPick: string): Promise<void>;
}

export type BoardEvent =
  | { type: "task.created"; task: TaskCard }
  | { type: "task.moved"; task: TaskCard }
  | { type: "task.decided"; decision: RoutingDecision }
  | { type: "task.result"; result: TaskResult }
  | { type: "task.override"; taskId: string; routerPick: string; humanPick: string };

interface TaskRow {
  id: string;
  title: string;
  body: string;
  labels: string;
  repo: string;
  status: TaskCard["status"];
  routedTo: string | null;
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
        routedTo TEXT
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        taskId TEXT NOT NULL,
        matchedTags TEXT NOT NULL,
        candidates TEXT NOT NULL,
        selected TEXT NOT NULL,
        reason TEXT NOT NULL,
        strategy TEXT NOT NULL,
        decidedAt TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS task_results (
        taskId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT NOT NULL,
        artifacts TEXT
      );
    `);
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
    const full: TaskCard = { ...card, id: randomUUID(), status: "inbox" };
    this.db.run(
      "INSERT INTO tasks (id, title, body, labels, repo, status, routedTo) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [full.id, full.title, full.body, JSON.stringify(full.labels), full.repo, full.status, full.routedTo ?? null],
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

  async recordDecision(decision: RoutingDecision): Promise<void> {
    this.db.run(
      "INSERT INTO routing_decisions (taskId, matchedTags, candidates, selected, reason, strategy, decidedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        decision.taskId,
        JSON.stringify(decision.matchedTags),
        JSON.stringify(decision.candidates),
        decision.selected,
        decision.reason,
        decision.strategy,
        decision.decidedAt,
      ],
    );
    this.db.run("UPDATE tasks SET routedTo = ? WHERE id = ?", [decision.selected, decision.taskId]);
    this.events.emit("event", { type: "task.decided", decision } satisfies BoardEvent);
  }

  async recordResult(result: TaskResult): Promise<void> {
    this.db.run(
      "INSERT INTO task_results (taskId, agentId, ok, summary, artifacts) VALUES (?, ?, ?, ?, ?)",
      [result.taskId, result.agentId, result.ok ? 1 : 0, result.summary, result.artifacts ? JSON.stringify(result.artifacts) : null],
    );
    this.events.emit("event", { type: "task.result", result } satisfies BoardEvent);
  }

  async recordOverride(taskId: string, routerPick: string, humanPick: string): Promise<void> {
    this.db.run(
      "INSERT INTO overrides (taskId, routerPick, humanPick, recordedAt) VALUES (?, ?, ?, ?)",
      [taskId, routerPick, humanPick, new Date().toISOString()],
    );
    this.events.emit("event", { type: "task.override", taskId, routerPick, humanPick } satisfies BoardEvent);
  }
}
