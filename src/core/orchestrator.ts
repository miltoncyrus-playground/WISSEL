import type { EventEmitter } from "node:events";
import type { Board } from "../services/board.ts";
import type { TelemetryLog } from "../services/telemetry.ts";
import type { HarnessPool } from "./harness-pool.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { runViaBun } from "../executors/claude-cli.ts";
import { mergeTaskWorktree } from "../services/worktree.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "./types.ts";

/**
 * Records a result wherever it came from — an executor wissel ran itself,
 * or an external report for a write-tier task wissel only decided and
 * handed off — and applies the one piece of policy that decides where a
 * finished task lands: a write-tier success needs a human look at the
 * diff before it's "done", read-only work doesn't. The one narrow,
 * explicit exception is an agent that declares both `autoMerge: true`
 * and `trustLevel: "high"` (see AgentDef.autoMerge) — its successful
 * write-tier runs skip the review stop and land on `done` directly, with
 * a worktree result actually merged first (never just a status flip
 * pretending the merge happened).
 *
 * `runner` is only used for that auto-merge path — injectable so tests
 * never spawn a real git process; defaults to the real one.
 */
export async function finishResult(
  board: Board,
  registry: Registry,
  result: TaskResult,
  telemetry?: TelemetryLog,
  runner: CommandRunner = runViaBun,
): Promise<void> {
  await board.recordResult(result);
  await telemetry?.record({ type: "result", taskId: result.taskId, agentId: result.agentId, actualCost: result.actualCost, harnessId: result.harnessId });

  const agent = registry.get(result.agentId);

  if (!result.ok) {
    await board.move(result.taskId, "failed");
    return;
  }

  if (agent?.tier !== "write") {
    await board.move(result.taskId, "done");
    return;
  }

  if (agent.autoMerge && agent.trustLevel === "high" && (await tryAutoMerge(board, result, runner))) {
    await board.move(result.taskId, "done");
    return;
  }

  // Either no auto-merge exception applies, or it does but couldn't
  // complete cleanly (a real merge conflict, or the task itself is
  // gone) — falls back to the same human gate every other write-tier
  // success gets. Never silently drops a failed auto-merge attempt.
  await board.move(result.taskId, "review");
}

/** True only when the write-tier success is actually safe to land on
 *  `done` unattended: no worktree to merge (nothing to reconcile — e.g.
 *  an external report with no local execution behind it), or a worktree
 *  whose merge genuinely succeeded (git merge --no-ff, same as a human
 *  clicking Merge — never a bare status change masquerading as one). */
async function tryAutoMerge(board: Board, result: TaskResult, runner: CommandRunner): Promise<boolean> {
  if (!result.worktree) return true;
  const task = await board.get(result.taskId);
  if (!task) return false;
  const merge = await mergeTaskWorktree(task.repo, result.worktree, task, runner);
  return merge.ok;
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

export interface OrchestratorOptions {
  /** Off by default — the documented design is "wissel decides, agetor
   *  executes," and every existing deployment keeps that unless it
   *  opts in. When true, a registered write-tier Executor (see
   *  WriteExecutor) runs write-tier work here instead of always handing
   *  it off as `dispatched`. Doesn't change the review gate: a
   *  write-tier success still lands in `review`, never `done` — see
   *  finishResult — regardless of who ran it. */
  executeWriteTier?: boolean;
  /** When set, every task wissel runs locally (readonly, or write-tier
   *  with executeWriteTier on) is run under a Harness picked from this
   *  pool instead of the ambient environment. Undefined means "no
   *  harness concept" — identical to wissel's behavior before harnesses
   *  existed. A `dispatched` (handed-off) task never gets a harness:
   *  wissel doesn't execute it, so there's nothing to pick one for. */
  harnesses?: HarnessPool;
}

/**
 * The loop that makes the rest of the fleet mean anything: watches the
 * board for tasks that are unrouted, unblocked, and sitting in `inbox` or
 * `ready`, and routes each one.
 *
 * wissel decides and dispatches; by default it does not spawn or
 * supervise execution itself. Read-only agents are cheap enough that
 * wissel runs them in-process via an `Executor`. Write-tier agents are
 * handed off — the task moves to `dispatched` and wissel's job for it is
 * done until whatever actually runs the work (agetor) reports back
 * through `POST /tasks/:id/result` — unless `executeWriteTier` is on and
 * a write-tier Executor is registered, in which case wissel runs it the
 * same way it runs read-only work. Either path ends in `finishResult`
 * applying the same review-vs-done policy.
 */
export class Orchestrator {
  private inFlight = new Set<string>();

  constructor(
    private board: Board & { events: EventEmitter },
    private registry: Registry,
    private router: Router,
    private executors: Executor[],
    private telemetry?: TelemetryLog,
    private opts: OrchestratorOptions = {},
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

  /**
   * A human clicking "Run" on a specific card in the board UI — bypasses
   * every gate `sweep()` applies (routedTo already set, status, blocked
   * dependencies) and the `executeWriteTier` flag: an explicit per-task
   * click is a different, narrower trust decision than "auto-execute
   * every write-tier task that shows up," so it's always allowed to
   * force through with whatever executor pool the caller hands in (see
   * server.ts's manual executor pool, which includes a WriteExecutor
   * even when the automatic loop's doesn't).
   *
   * Returns once the task is confirmed eligible and marked in-flight —
   * NOT once it's finished. The routing/run itself continues in the
   * background and surfaces through the normal task.moved/task.decided/
   * task.result board events, same as the automatic loop; a caller that
   * needs the outcome watches those (or polls the task), it doesn't await
   * this call. Throws synchronously, before anything starts, if the task
   * doesn't exist or a run is already in flight for it — an immediate,
   * honest error instead of a silently dropped click or a double-run.
   */
  async runNow(taskId: string, executors: Executor[]): Promise<void> {
    if (this.inFlight.has(taskId)) throw new Error(`task ${taskId} is already running`);
    const task = await this.board.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    this.inFlight.add(taskId);
    void this.process(task, { executors, forceExecute: true }).finally(() => this.inFlight.delete(taskId));
  }

  private async process(task: TaskCard, override?: { executors: Executor[]; forceExecute: boolean }): Promise<void> {
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

      // Write-tier normally has no executor lookup to fail — it's always
      // handed off. `executeWriteTier` (or an explicit runNow override)
      // flips that: a write-tier task then needs a real Executor exactly
      // like read-only does, so a missing one is an error here too rather
      // than silently falling back to handoff (that would be a
      // confusing, decision-dependent surprise).
      const runsHere = agent.tier !== "write" || this.opts.executeWriteTier === true || override?.forceExecute === true;
      const executorPool = override?.executors ?? this.executors;
      // Resolved but not yet recorded: recordDecision() sets routedTo, and
      // the sweep skips anything already routed — recording before we know
      // an executor can actually run this would strand the task forever on
      // an unrecoverable dead end the moment the executor lookup below
      // fails.
      const executor = runsHere ? executorPool.find((e) => e.canHandle(agent)) : undefined;
      if (runsHere && !executor) {
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

      if (!runsHere) {
        await this.board.move(task.id, "dispatched");
        return;
      }

      // Picked before the move to "running" (not inside the executor)
      // so the board already reflects which harness owns this task the
      // moment a poller/SSE listener sees it running — the same
      // liveness guarantee `routedTo` already gets from recordDecision
      // happening before dispatch. Acquires from whichever tool the
      // executor that's about to run actually needs, not a fixed
      // "claude-cli" — an executor with no declared harnessTool (or no
      // pool configured) simply runs without one, unchanged from
      // wissel's behavior before harnesses existed.
      const harness = executor!.harnessTool ? this.opts.harnesses?.acquire(executor!.harnessTool) : undefined;
      if (harness) await this.board.setHarness(task.id, harness.id);

      await this.board.move(task.id, "running");

      let result: TaskResult;
      try {
        result = await executor!.run(task, agent, harness);
      } catch (e) {
        result = { taskId: task.id, agentId: agent.id, ok: false, summary: `executor threw: ${(e as Error).message}` };
      } finally {
        if (harness) this.opts.harnesses!.release(harness.id);
      }
      await finishResult(this.board, this.registry, result, this.telemetry);
    } catch (e) {
      console.error(`orchestrator: unexpected error processing task ${task.id}: ${(e as Error).message}`);
    }
  }
}
