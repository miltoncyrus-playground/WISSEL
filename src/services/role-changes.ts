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
 * owner's last word wins. Pending changes live in memory only: a restart
 * has no arm in flight, so a change lost with it is one the owner sees
 * missing in the window and repeats.
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
  workstreams: Pick<WorkstreamStore, "setRole">;
  executor: Pick<CoordinatorExecutor, "armsInFlight" | "whenArmsSettle">;
  /** The owner's console; defaults to console.log. */
  log?: (line: string) => void;
  now?: () => Date;
}

export function createRoleChanges(deps: RoleChangeDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());
  const pending = new Map<string, PendingRoleChange>();
  const keyOf = (workstreamId: string, projectId: string): string => `${workstreamId}\0${projectId}`;

  return {
    async request(workstreamId: string, projectId: string, change: RoleChange): Promise<RoleChangeOutcome> {
      const key = keyOf(workstreamId, projectId);
      if (deps.executor.armsInFlight(workstreamId) === 0) {
        pending.delete(key);
        return { applied: true, workstream: await deps.workstreams.setRole(workstreamId, projectId, change) };
      }
      const held: PendingRoleChange = { workstreamId, projectId, change, requestedAt: now().toISOString(), waitingOn: "arm" };
      pending.set(key, held);
      log(`coordinator> ${workstreamId}: role of ${projectId} becomes ${change.role} once the arm in flight settles`);
      void deps.executor.whenArmsSettle(workstreamId).then(async () => {
        if (pending.get(key) !== held) return; // replaced or applied meanwhile
        pending.delete(key);
        await deps.workstreams.setRole(workstreamId, projectId, change);
        log(`coordinator> ${workstreamId}: role of ${projectId} is now ${change.role}`);
      }).catch((e: unknown) => log(`coordinator> ${workstreamId}: role change for ${projectId} failed: ${e instanceof Error ? e.message : String(e)}`));
      return { applied: false, pending: held };
    },

    /** The changes still waiting for the workstream's arms (the window's pending roles). */
    pending(workstreamId: string): PendingRoleChange[] {
      return [...pending.values()].filter((p) => p.workstreamId === workstreamId);
    },
  };
}

export type RoleChanges = ReturnType<typeof createRoleChanges>;
