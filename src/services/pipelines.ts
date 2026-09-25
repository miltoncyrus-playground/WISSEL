import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { PipelineDef, PipelineGraph } from "../core/types.ts";

/**
 * CRUD for stored pipeline definitions — mirrors src/services/board.ts's
 * own shape (create/get/list/update/delete, real rows, no execution
 * logic here at all — see src/core/pipeline-runner.ts for that).
 */
export interface PipelineStore {
  create(def: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef>;
  get(id: string): Promise<PipelineDef | undefined>;
  list(): Promise<PipelineDef[]>;
  update(id: string, def: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef>;
  delete(id: string): Promise<void>;
}

interface PipelineRow {
  id: string;
  name: string;
  description: string;
  graph: string;
  createdAt: string;
  updatedAt: string;
}

function rowToDef(row: PipelineRow): PipelineDef {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    graph: JSON.parse(row.graph) as PipelineGraph,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * SQLite-backed pipeline store. Takes an already-open `Database`
 * instance — deliberately not a `dbPath` the way SqliteBoard's
 * constructor does, because a second `new Database(dbPath)` call
 * against the same path opens a second, independent connection (fine
 * for a real on-disk file under WAL, but two separate, unrelated
 * databases for ":memory:" — see SqliteBoard.db's own doc comment).
 * Callers share the exact connection SqliteBoard already owns: `new
 * SqlitePipelineStore(board.db)`. Table creation lives here (this
 * class's own concern, same as every other table in this codebase
 * being owned by whichever class actually reads/writes it) — the
 * `tasks` table's own pipeline* columns are the one exception, owned by
 * board.ts since they live on TaskCard, not PipelineDef (see
 * docs/SDD-pipelines.md §4).
 */
export class SqlitePipelineStore implements PipelineStore {
  constructor(private db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS pipelines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        graph TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  async create(def: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef> {
    const now = new Date().toISOString();
    const full: PipelineDef = { id: randomUUID(), name: def.name, description: def.description, graph: def.graph, createdAt: now, updatedAt: now };
    this.db.run("INSERT INTO pipelines (id, name, description, graph, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)", [
      full.id,
      full.name,
      full.description,
      JSON.stringify(full.graph),
      full.createdAt,
      full.updatedAt,
    ]);
    return full;
  }

  async get(id: string): Promise<PipelineDef | undefined> {
    const row = this.db.query("SELECT * FROM pipelines WHERE id = ?").get(id) as PipelineRow | null;
    return row ? rowToDef(row) : undefined;
  }

  async list(): Promise<PipelineDef[]> {
    const rows = this.db.query("SELECT * FROM pipelines ORDER BY rowid").all() as PipelineRow[];
    return rows.map(rowToDef);
  }

  async update(id: string, def: { name: string; description: string; graph: PipelineGraph }): Promise<PipelineDef> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`pipeline not found: ${id}`);
    const updatedAt = new Date().toISOString();
    this.db.run("UPDATE pipelines SET name = ?, description = ?, graph = ?, updatedAt = ? WHERE id = ?", [
      def.name,
      def.description,
      JSON.stringify(def.graph),
      updatedAt,
      id,
    ]);
    return { ...existing, name: def.name, description: def.description, graph: def.graph, updatedAt };
  }

  async delete(id: string): Promise<void> {
    const existing = await this.get(id);
    if (!existing) throw new Error(`pipeline not found: ${id}`);
    this.db.run("DELETE FROM pipelines WHERE id = ?", [id]);
  }
}
