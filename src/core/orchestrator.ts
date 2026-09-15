import type { EventEmitter } from "node:events";
import type { Board } from "../services/board.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "./types.ts";

/**
 * The loop that makes the rest of the fleet mean anything: watches the
 * board for tasks that are unrouted, unblocked, and sitting in `inbox` or
 * `ready`, routes each one, runs it on whichever executor's `canHandle`
 * matches the winning agent, and writes the outcome back.
 *
 * Not named as its own step in the handover, but required for step 6
 * ("planner/triager generate card volume") to mean anything — without it,
 * agents in the manifest are entries nothing ever invokes.
 */
export class Orchestrator {
  private inFlight = new Set<string>();

  constructor(
    private board: Board & { events: EventEmitter },
    private registry: Registry,
    private router: Router,
    private executors: Executor[],
  ) {}

  /** Runs an initial sweep, then re-sweeps on every board event that could
   *  make a previously-blocked task eligible. */
  start(): void {
    this.board.events.on("event", () => void this.sweep());
    void this.sweep();
  }

  /** Processes every currently-eligible task once, and doesn't resolve
   *  until all of them have finished — callers (including tests) can rely
   *  on `await sweep()` meaning "this round is done," not just "started."
   *  Public so it can also be triggered manually (a future `wissel tick`). */
  async sweep(): Promise<void> {
    const tasks = await this.board.list();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pending: Promise<void>[] = [];

    for (const task of tasks) {
      if (this.inFlight.has(task.id)) continue;
      if (task.routedTo) continue; // already routed — a human or a prior run owns it now
      if (task.status !== "inbox" && task.status !== "ready") continue;

      const deps = task.dependsOn ?? [];
      // A dangling or not-yet-done dependency both read as "blocked" — never
      // guess a dependency is satisfied just because we can't find it.
      const blocked = deps.some((depId) => byId.get(depId)?.status !== "done");
      if (blocked) continue;

      this.inFlight.add(task.id);
      pending.push(this.process(task).finally(() => this.inFlight.delete(task.id)));
    }

    await Promise.all(pending);
  }

  private async process(task: TaskCard): Promise<void> {
    try {
      let decision: RoutingDecision;
      try {
        decision = await this.router.route(task);
      } catch (e) {
        console.error(`orchestrator: could not route task ${task.id}: ${(e as Error).message}`);
        return;
      }

      // Resolved but not yet recorded: recordDecision() sets routedTo, and
      // the sweep skips anything already routed — recording before we know
      // an executor can actually run this would strand the task forever on
      // an unrecoverable dead end the moment the agent or executor lookup
      // below fails.
      const agent = this.registry.get(decision.selected);
      if (!agent) {
        console.error(`orchestrator: routed task ${task.id} to unknown agent "${decision.selected}"`);
        return;
      }
      const executor = this.executors.find((e) => e.canHandle(agent));
      if (!executor) {
        console.error(`orchestrator: no executor handles agent "${agent.id}" (tier ${agent.tier})`);
        return;
      }

      await this.board.recordDecision(decision);
      await this.board.move(task.id, "running");

      let result: TaskResult;
      try {
        result = await executor.run(task, agent);
      } catch (e) {
        result = { taskId: task.id, agentId: agent.id, ok: false, summary: `executor threw: ${(e as Error).message}` };
      }
      await this.board.recordResult(result);

      // Write-tier work produced a diff a human should look at before it's
      // "done"; read-only work has nothing to review.
      const finalStatus = result.ok ? (agent.tier === "write" ? "review" : "done") : "failed";
      await this.board.move(task.id, finalStatus);
    } catch (e) {
      console.error(`orchestrator: unexpected error processing task ${task.id}: ${(e as Error).message}`);
    }
  }
}
