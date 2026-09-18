import type { EventEmitter } from "node:events";
import type { Board } from "../services/board.ts";
import type { TelemetryLog } from "../services/telemetry.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "./types.ts";

/**
 * Records a result wherever it came from — an executor wissel ran itself,
 * or an external report for a write-tier task wissel only decided and
 * handed off — and applies the one piece of policy that decides where a
 * finished task lands: a write-tier success needs a human look at the
 * diff before it's "done", read-only work doesn't.
 */
export async function finishResult(
  board: Board,
  registry: Registry,
  result: TaskResult,
  telemetry?: TelemetryLog,
): Promise<void> {
  await board.recordResult(result);
  await telemetry?.record({ type: "result", taskId: result.taskId, agentId: result.agentId, actualCost: result.actualCost });

  const agent = registry.get(result.agentId);
  const finalStatus = result.ok ? (agent?.tier === "write" ? "review" : "done") : "failed";
  await board.move(result.taskId, finalStatus);
}

/**
 * Resolves the candidate allowlist a follow-up task is restricted to:
 * its parent's routed agent's declared `handoffs`, if the parent exists
 * and is itself routed. Undefined means unrestricted — no parent, an
 * unrouted parent, or a parent whose agent never declared a handoff
 * graph at all all mean "the whole registry is eligible." A parent
 * agent that declared `handoffs: []` returns that empty array as-is —
 * a deliberate "hands off to no one," not the same as no restriction.
 */
export async function resolveHandoffAllowlist(
  board: Board,
  registry: Registry,
  parentTaskId: string | undefined,
): Promise<string[] | undefined> {
  if (!parentTaskId) return undefined;
  const parent = await board.get(parentTaskId);
  if (!parent?.routedTo) return undefined;
  const parentAgent = registry.get(parent.routedTo);
  if (!parentAgent || parentAgent.handoffs === undefined) return undefined;
  return parentAgent.handoffs;
}

/**
 * The loop that makes the rest of the fleet mean anything: watches the
 * board for tasks that are unrouted, unblocked, and sitting in `inbox` or
 * `ready`, and routes each one.
 *
 * wissel decides and dispatches; it does not spawn or supervise execution
 * itself. Read-only agents are cheap enough that wissel runs them
 * in-process via an `Executor`. Write-tier agents are handed off — the
 * task moves to `dispatched` and wissel's job for it is done until
 * whatever actually runs the work (agetor) reports back through
 * `POST /tasks/:id/result`, at which point `finishResult` applies the
 * same review-vs-done policy either way.
 */
export class Orchestrator {
  private inFlight = new Set<string>();

  constructor(
    private board: Board & { events: EventEmitter },
    private registry: Registry,
    private router: Router,
    private executors: Executor[],
    private telemetry?: TelemetryLog,
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
        const allowIds = await resolveHandoffAllowlist(this.board, this.registry, task.parentTaskId);
        decision = await this.router.route(task, allowIds);
      } catch (e) {
        console.error(`orchestrator: could not route task ${task.id}: ${(e as Error).message}`);
        return;
      }

      // Never auto-dispatch a low-confidence match: record the decision
      // (candidates and all, so it's debuggable) and stop before spend
      // rather than guess.
      if (!decision.confident || !decision.selected) {
        await this.board.recordDecision(decision);
        await this.board.move(task.id, "no-match");
        return;
      }

      const agent = this.registry.get(decision.selected);
      if (!agent) {
        console.error(`orchestrator: routed task ${task.id} to unknown agent "${decision.selected}"`);
        return;
      }

      // Resolved but not yet recorded: recordDecision() sets routedTo, and
      // the sweep skips anything already routed — recording before we know
      // an executor can actually run this would strand a readonly task
      // forever on an unrecoverable dead end the moment the executor
      // lookup below fails. Write-tier has no such lookup to fail.
      const executor = agent.tier === "write" ? undefined : this.executors.find((e) => e.canHandle(agent));
      if (agent.tier !== "write" && !executor) {
        console.error(`orchestrator: no executor handles agent "${agent.id}" (tier ${agent.tier})`);
        return;
      }

      await this.board.recordDecision(decision);
      await this.telemetry?.record({
        type: "dispatch",
        taskId: task.id,
        agentId: agent.id,
        model: agent.costProfile.model,
        estimatedCost: agent.costProfile.estUsdPerTask,
      });

      if (agent.tier === "write") {
        await this.board.move(task.id, "dispatched");
        return;
      }

      await this.board.move(task.id, "running");

      let result: TaskResult;
      try {
        result = await executor!.run(task, agent);
      } catch (e) {
        result = { taskId: task.id, agentId: agent.id, ok: false, summary: `executor threw: ${(e as Error).message}` };
      }
      await finishResult(this.board, this.registry, result, this.telemetry);
    } catch (e) {
      console.error(`orchestrator: unexpected error processing task ${task.id}: ${(e as Error).message}`);
    }
  }
}
