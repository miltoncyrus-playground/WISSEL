// Policy is versioned (docs/SDD-identity-and-permissions.md §4.4; build
// plan card 3). Every change to the rules a run is held to bumps a
// revision and records who made it; every run and every authorization
// record carries the revision in force, so "which rules was that run
// under?" has an answer.
//
// Workstreams, roles, lists, duty switches and card rules
// (docs/SDD-coordinator.md) do not exist yet. Until they do, the policy
// writes that exist today bump it: a project's execution settings and
// its merge gate. A new policy write joins by adding its action kind to
// POLICY_ACTION_KINDS.
import type { Database } from "bun:sqlite";

/** Route-level action kinds (authorization.ts describeAction) that
 *  change policy when they succeed. */
export const POLICY_ACTION_KINDS: ReadonlySet<string> = new Set([
  "POST /projects/:id/settings",
  "POST /projects/:id/merge-gate",
  // Workstreams and roles (docs/SDD-coordinator.md §3.1, §4.13).
  "POST /workstreams",
  "PATCH /workstreams/:id",
  "DELETE /workstreams/:id",
  "POST /workstreams/:id/projects/:id/role",
]);

export interface PolicyRevision {
  /** "r0" before any change; "r<N>" after the Nth. */
  revision: string;
  ts: string;
  principalId: string;
  /** The action kind that changed it, and its target. */
  what: string;
  target: string;
}

export class PolicyRevisions {
  constructor(
    private readonly db: Database,
    private readonly clock: () => Date = () => new Date(),
  ) {
    db.run(`
      CREATE TABLE IF NOT EXISTS policy_revisions (
        rev INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        principalId TEXT NOT NULL,
        what TEXT NOT NULL,
        target TEXT NOT NULL
      );
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS policy_revisions_append_only_d
      BEFORE DELETE ON policy_revisions
      BEGIN SELECT RAISE(ABORT, 'policy_revisions is append-only'); END;
    `);
    db.run(`
      CREATE TRIGGER IF NOT EXISTS policy_revisions_append_only_u
      BEFORE UPDATE ON policy_revisions
      BEGIN SELECT RAISE(ABORT, 'policy_revisions is append-only'); END;
    `);
  }

  /** The revision in force now. */
  current(): string {
    const r = this.db.query("SELECT MAX(rev) AS rev FROM policy_revisions").get() as { rev: number | null } | null;
    return `r${r?.rev ?? 0}`;
  }

  /** Records a policy change and returns the new revision. */
  bump(what: string, target: string, principalId: string): string {
    this.db.run("INSERT INTO policy_revisions (ts, principalId, what, target) VALUES (?, ?, ?, ?)", [this.clock().toISOString(), principalId, what, target]);
    return this.current();
  }

  /** Newest first. */
  history(limit = 100): PolicyRevision[] {
    const rows = this.db.query(`SELECT * FROM policy_revisions ORDER BY rev DESC LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))}`).all() as Array<{
      rev: number;
      ts: string;
      principalId: string;
      what: string;
      target: string;
    }>;
    return rows.map((r) => ({ revision: `r${r.rev}`, ts: r.ts, principalId: r.principalId, what: r.what, target: r.target }));
  }
}
