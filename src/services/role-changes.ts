import type { Database } from "bun:sqlite";
import type { AskService } from "./asks.ts";
import type { CoordinatorExecutor } from "./coordinator-executor.ts";
import type { RoleChange, Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * Role-change timing (docs/SDD-coordinator.md §4.13): a role change takes
 * effect at the next idle tick, never during an arm. The owner's confirmed
 * change (POST /workstreams/:id/projects/:projectId/role) comes through
 * `request`: with no pr.arm in flight for the workstream it is applied at
 * once; otherwise it is held, shown in the window as the project's
 * pending role, and applied once the executor says the arms settled. A
 * second request for the same project while one waits replaces it: the
 * owner's last word wins. A held change is also a row in
 * pending_role_changes on the board's connection, reloaded on startup: a
 * restart has no arm in flight, so the change lands then. Once a change
 * is applied the project's open asks are gated again under the new role
 * (asks.ts onRoleChange): kept, handed over or withdrawn, with a handover
 * note on the channel.
 */
export interface PendingRoleChange {
  workstreamId: string;
  projectId: string;
  change: RoleChange;
  requestedAt: string;
  waitingOn: "arm";
}

export type RoleChangeOutcome = { applied: true; workstream: Workstream } | { applied: false; pending: PendingRoleChange };

export interface RoleChangeDeps {
  workstreams: Pick<WorkstreamStore, "get" | "setRole">;
  executor: Pick<CoordinatorExecutor, "armsInFlight" | "whenArmsSettle">;
  /** Where the held changes persist; without it they live in memory only. */
  db?: Database;
  /** The asks to re-evaluate after a change lands; absent, open asks stay as they were asked. */
  asks?: Pick<AskService, "onRoleChange">;
  /** The owner's console; defaults to console.log. */
  log?: (line: string) => void;
  now?: () => Date;
}

type PendingRow = { workstreamId: string; projectId: string; change: string; requestedAt: string };

export function createRoleChanges(deps: RoleChangeDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const pending = new Map<string, PendingRoleChange>();
  const keyOf = (workstreamId: string, projectId: string): string => `${workstreamId}\0${projectId}`;
  deps.db?.run(`CREATE TABLE IF NOT EXISTS pending_role_changes (workstreamId TEXT NOT NULL, projectId TEXT NOT NULL, change TEXT NOT NULL, requestedAt TEXT NOT NULL, PRIMARY KEY (workstreamId, projectId))`);
  const persist = (p: PendingRoleChange): void => void deps.db?.query(`INSERT OR REPLACE INTO pending_role_changes (workstreamId, projectId, change, requestedAt) VALUES (?, ?, ?, ?)`).run(p.workstreamId, p.projectId, JSON.stringify(p.change), p.requestedAt);
  const forget = (workstreamId: string, projectId: string): void => {
    pending.delete(keyOf(workstreamId, projectId));
    deps.db?.query(`DELETE FROM pending_role_changes WHERE workstreamId = ? AND projectId = ?`).run(workstreamId, projectId);
  };

  /** Sets the role, then re-routes the project's open asks under it. */
  async function apply(workstreamId: string, projectId: string, change: RoleChange): Promise<Workstream> {
    const from = (await deps.workstreams.get(workstreamId))?.projects.find((p) => p.projectId === projectId)?.role ?? "?";
    forget(workstreamId, projectId);
    const ws = await deps.workstreams.setRole(workstreamId, projectId, change);
    await deps.asks?.onRoleChange(workstreamId, projectId, from, change.role);
    return ws;
  }

  /** Holds a change until the workstream's arms settle; the last one held for the project is the one applied. */
  function hold(held: PendingRoleChange): void {
    const key = keyOf(held.workstreamId, held.projectId);
    pending.set(key, held);
    persist(held);
    void deps.executor.whenArmsSettle(held.workstreamId).then(async () => {
      if (pending.get(key) !== held) return; // replaced or applied meanwhile
      await apply(held.workstreamId, held.projectId, held.change);
      log(`coordinator> ${held.workstreamId}: role of ${held.projectId} is now ${held.change.role}`);
    }).catch((e: unknown) => log(`coordinator> ${held.workstreamId}: role change for ${held.projectId} failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // Startup: the changes a previous run held land now (no arm is in flight), through the same path.
  for (const r of deps.db?.query<PendingRow, []>(`SELECT * FROM pending_role_changes ORDER BY requestedAt ASC`).all() ?? []) {
    hold({ workstreamId: r.workstreamId, projectId: r.projectId, change: JSON.parse(r.change) as RoleChange, requestedAt: r.requestedAt, waitingOn: "arm" });
  }

  return {
    async request(workstreamId: string, projectId: string, change: RoleChange): Promise<RoleChangeOutcome> {
      if (deps.executor.armsInFlight(workstreamId) === 0) return { applied: true, workstream: await apply(workstreamId, projectId, change) };
      const held: PendingRoleChange = { workstreamId, projectId, change, requestedAt: now().toISOString(), waitingOn: "arm" };
      hold(held);
      log(`coordinator> ${workstreamId}: role of ${projectId} becomes ${change.role} once the arm in flight settles`);
      return { applied: false, pending: held };
    },

    /** The changes still waiting for the workstream's arms (the window's pending roles). */
    pending(workstreamId: string): PendingRoleChange[] {
      return [...pending.values()].filter((p) => p.workstreamId === workstreamId);
    },
  };
}

export type RoleChanges = ReturnType<typeof createRoleChanges>;
