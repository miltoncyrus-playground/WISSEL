import type { Database } from "bun:sqlite";
import type { Duty, GateContext } from "./policy-gate.ts";

/**
 * Duty switches (docs/SDD-coordinator.md §3.4, §4.13, §7): per workstream,
 * each of the eight duties is owned by Wissel or by an external
 * coordinator. A duty nobody has switched belongs to Wissel. Only the
 * owner flips one, through the confirm step of
 * `POST /workstreams/:id/duties/:duty` (validateDutyChange), like a role
 * change; the gate reads `map()` as rule 3 (deny while external). A flip
 * back is the §7 rollback.
 */
export type { Duty };
export const DUTIES: readonly Duty[] = ["status", "host", "landing", "review", "channel-read", "claims", "ready-to-merge", "arming"];
export type DutyOwner = "external" | "wissel";

export interface DutySwitch {
  workstreamId: string;
  duty: Duty;
  owner: DutyOwner;
  /** When the owner last switched it; absent for a duty still at its default (Wissel). */
  changedAt?: string;
}

export const isDuty = (s: string): s is Duty => (DUTIES as readonly string[]).includes(s);

type Row = { duty: Duty; owner: DutyOwner; changedAt: string };

/** Shares the board's connection, like SqliteWorkstreamStore. One row per switched duty. */
export class SqliteDutyStore {
  constructor(private db: Database, private now: () => string = () => new Date().toISOString()) {
    this.db.run(`CREATE TABLE IF NOT EXISTS duty_switches (workstreamId TEXT NOT NULL, duty TEXT NOT NULL, owner TEXT NOT NULL, changedAt TEXT NOT NULL, PRIMARY KEY (workstreamId, duty))`);
  }

  private rows(workstreamId: string): Row[] {
    return this.db.query<Row, [string]>(`SELECT duty, owner, changedAt FROM duty_switches WHERE workstreamId = ?`).all(workstreamId);
  }

  /** All eight duties in the §4.13 order (GET /workstreams/:id/duties). */
  list(workstreamId: string): DutySwitch[] {
    const stored = new Map(this.rows(workstreamId).map((r) => [r.duty, r]));
    return DUTIES.map((duty) => {
      const r = stored.get(duty);
      return r ? { workstreamId, duty, owner: r.owner, changedAt: r.changedAt } : { workstreamId, duty, owner: "wissel" };
    });
  }

  /** What GateContext.duties takes: the switched duties only (missing means Wissel). */
  map(workstreamId: string): GateContext["duties"] {
    return Object.fromEntries(this.rows(workstreamId).map((r) => [r.duty, r.owner]));
  }

  set(workstreamId: string, duty: Duty, owner: DutyOwner): DutySwitch {
    const changedAt = this.now();
    this.db.query(`INSERT INTO duty_switches (workstreamId, duty, owner, changedAt) VALUES (?, ?, ?, ?) ON CONFLICT(workstreamId, duty) DO UPDATE SET owner = excluded.owner, changedAt = excluded.changedAt`).run(workstreamId, duty, owner, changedAt);
    return { workstreamId, duty, owner, changedAt };
  }
}

/** The body of POST /workstreams/:id/duties/:duty: `confirm: true` and an
 *  owner, nothing else (§4.13: only the owner, with a confirm step). */
export function validateDutyChange(body: unknown): { ok: true; owner: DutyOwner } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  if (b.confirm !== true) return { ok: false, error: "a duty change needs confirm: true" };
  if (b.owner !== "external" && b.owner !== "wissel") return { ok: false, error: "owner must be external or wissel" };
  const extra = Object.keys(b).find((k) => k !== "confirm" && k !== "owner");
  if (extra) return { ok: false, error: `unknown field ${extra}` };
  return { ok: true, owner: b.owner };
}
