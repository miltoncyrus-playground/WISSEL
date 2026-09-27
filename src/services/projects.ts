import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Project } from "../core/types.ts";

/**
 * Registers a project/repo two ways: an existing local folder, or a
 * fresh GitHub clone. This is the durable backing for what
 * `TaskCard.repo` today is just a free-typed string for.
 */
export interface ProjectStore {
  addLocalProject(path: string, opts: { initGit?: boolean }, runner: CommandRunner): Promise<{ project: Project } | { error: string }>;
  addGithubProject(
    url: string,
    opts: { name?: string },
    runner: CommandRunner,
    homeDir?: string,
  ): Promise<{ project: Project; alreadyExists?: boolean } | { error: string }>;
  list(): Promise<Project[]>;
  delete(id: string): Promise<void>;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  source: Project["source"];
  sourceUrl: string | null;
  createdAt: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    source: row.source,
    sourceUrl: row.sourceUrl ?? undefined,
    createdAt: row.createdAt,
  };
}

/** Sibling of worktreesRoot's own `~/.wissel/worktrees` convention (see
 *  src/services/worktree.ts) — same `~/.wissel/` root, same injectable
 *  `homeDir` for tests. */
function projectsRoot(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".wissel", "projects");
}

/** Matches bare `org/repo` shorthand only: no scheme, no `.git` suffix,
 *  exactly one `/`. A full HTTPS URL (`https://...`) or SSH remote
 *  (`git@host:org/repo.git`) never matches this — both contain
 *  characters (`:`, extra `/`) outside this charset — so they pass
 *  through normalizeGithubUrl unchanged. */
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function normalizeGithubUrl(url: string): string {
  const trimmed = url.trim();
  if (GITHUB_SHORTHAND.test(trimmed) && !trimmed.endsWith(".git")) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

/** Best-effort project name from a clone URL when the caller doesn't
 *  supply one: the last path segment, minus a trailing `.git`. Works for
 *  HTTPS (`.../org/repo.git`), SSH (`git@host:org/repo.git`), and
 *  `file://` URLs alike, since all three just need splitting on `/`
 *  and `:`. */
function deriveNameFromUrl(url: string): string {
  const withoutGit = url.endsWith(".git") ? url.slice(0, -4) : url;
  const segments = withoutGit.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] ?? withoutGit;
}

/**
 * SQLite-backed project store. Takes an already-open `Database`
 * instance, exactly mirroring SqlitePipelineStore in
 * src/services/pipelines.ts — deliberately not a `dbPath`, so callers
 * share the exact connection SqliteBoard already owns
 * (`new SqliteProjectStore(board.db)`) instead of opening a second,
 * independent one (which for `:memory:` would be a second, unrelated
 * database — see SqliteBoard.db's own doc comment).
 */
export class SqliteProjectStore implements ProjectStore {
  constructor(private db: Database) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        sourceUrl TEXT,
        createdAt TEXT NOT NULL
      );
    `);
  }

  async addLocalProject(path: string, opts: { initGit?: boolean }, runner: CommandRunner): Promise<{ project: Project } | { error: string }> {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return { error: `not a directory: ${path}` };
    }

    const check = await runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd: path });
    if (check.exitCode !== 0) {
      if (!opts.initGit) {
        return { error: `not a git repository: ${path}` };
      }
      const init = await runner(["git", "init"], { cwd: path });
      if (init.exitCode !== 0) {
        return { error: (init.stderr || init.stdout).trim() || `failed to init git repo: ${path}` };
      }
    }

    const project: Project = { id: randomUUID(), name: basename(path), path, source: "local", createdAt: new Date().toISOString() };
    this.db.run("INSERT INTO projects (id, name, path, source, sourceUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      project.id,
      project.name,
      project.path,
      project.source,
      null,
      project.createdAt,
    ]);
    return { project };
  }

  async addGithubProject(
    url: string,
    opts: { name?: string },
    runner: CommandRunner,
    homeDir?: string,
  ): Promise<{ project: Project; alreadyExists?: boolean } | { error: string }> {
    const normalized = normalizeGithubUrl(url);

    const existingRow = this.db.query("SELECT * FROM projects WHERE sourceUrl = ?").get(normalized) as ProjectRow | null;
    if (existingRow) {
      return { project: rowToProject(existingRow), alreadyExists: true };
    }

    const root = projectsRoot(homeDir);
    mkdirSync(root, { recursive: true });
    const id = randomUUID();
    const destPath = join(root, id);

    const clone = await runner(["git", "clone", normalized, destPath], { cwd: root });
    if (clone.exitCode !== 0) {
      return { error: (clone.stderr || clone.stdout).trim() || `failed to clone ${normalized}` };
    }

    const project: Project = {
      id,
      name: opts.name ?? deriveNameFromUrl(normalized),
      path: destPath,
      source: "github",
      sourceUrl: normalized,
      createdAt: new Date().toISOString(),
    };
    this.db.run("INSERT INTO projects (id, name, path, source, sourceUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?)", [
      project.id,
      project.name,
      project.path,
      project.source,
      project.sourceUrl ?? null,
      project.createdAt,
    ]);
    return { project };
  }

  async list(): Promise<Project[]> {
    const rows = this.db.query("SELECT * FROM projects ORDER BY rowid").all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  /**
   * Removes only the DB row — deliberately, permanently never deletes
   * the underlying directory. A local-folder project's path might point
   * at something else entirely on the server; a github-clone project's
   * directory might hold uncommitted work. Not a TODO — the directory
   * is never Wissel's to delete.
   */
  async delete(id: string): Promise<void> {
    this.db.run("DELETE FROM projects WHERE id = ?", [id]);
  }
}
