import type { EventEmitter } from "node:events";
import type { Board, BoardEvent } from "../services/board.ts";
import type { TelemetryLog } from "../services/telemetry.ts";
import type { HarnessPool } from "./harness-pool.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { runViaBun } from "../executors/claude-cli.ts";
import { mergeTaskWorktree } from "../services/worktree.ts";
import { DEFAULT_MEMORY_PATH, writeMemoryLessons } from "../services/memory.ts";
import type { Executor, RoutingDecision, TaskCard, TaskResult } from "./types.ts";

/**
 * Follows a chain of `TaskCard.supersededBy` pointers forward from `task`
 * until it reaches a card with none set — the "live tip" a `dependsOn` id
 * should actually be evaluated against. A superseded card's own `status`
 * is frozen forever the moment a pushback re-attempt exists for it (see
 * TaskCard.supersededBy) — checking that frozen status directly, as
 * `sweep()`'s blocked-check used to, means any dependent task blocks on
 * it forever even once the real re-attempt reaches `done`.
 *
 * `task` undefined (a dangling dependency id) reads the same as every
 * other unresolvable case here: returns `undefined`, which callers must
 * treat as "blocked," never as "satisfied."
 *
 * Guards against a cycle with a visited-set — shouldn't occur by
 * construction (spawnPushbackImplementer only ever points a superseded
 * card forward to a brand-new id it just created), but a broken chain is
 * treated as blocked rather than trusted silently. Returns `undefined` on
 * a detected cycle, same fail-closed contract as the dangling-id case.
 */
export function resolveLiveTip(task: TaskCard | undefined, byId: Map<string, TaskCard>): TaskCard | undefined {
  const seen = new Set<string>();
  let current = task;
  while (current?.supersededBy) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    current = byId.get(current.supersededBy);
  }
  return current;
}

/**
 * Records a result wherever it came from — an executor wissel ran itself,
 * or an external report for a write-tier task wissel only decided and
 * handed off — and applies the one piece of policy that decides where a
 * finished task lands: a write-tier success needs a look at the diff
 * before it's "done", read-only work doesn't. There are two narrow,
 * explicit exceptions to "review means a human":
 *
 * - An agent that declares both `autoMerge: true` and `trustLevel:
 *   "high"` (see AgentDef.autoMerge) skips the review stop and lands on
 *   `done` directly, with a worktree result actually merged first (never
 *   just a status flip pretending the merge happened).
 * - An agent that declares `reviewer` in its `handoffs` (see
 *   AgentDef.handoffs) doesn't stop for a human yet either — it queues
 *   an automated reviewer pass first (`pending-review`, see
 *   spawnReviewerTask). That reviewer's own verdict, once it comes back
 *   through this same function (see handleReviewVerdict), is what
 *   finally resumes this exact done-vs-review decision for the original
 *   task — approve behaves like a plain write-tier success arriving now,
 *   changes_requested spawns a pushback re-attempt or escalates.
 *
 * `runner` is used for the auto-merge path and passed through to
 * handleReviewVerdict for the same reason — injectable so tests never
 * spawn a real git process; defaults to the real one. `memoryPath` is
 * the same kind of injection point for the memory-persistence hook
 * below — defaults to the real repo-root memory/lessons.md.
 */
export async function finishResult(
  board: Board,
  registry: Registry,
  result: TaskResult,
  telemetry?: TelemetryLog,
  runner: CommandRunner = runViaBun,
  memoryPath: string = DEFAULT_MEMORY_PATH,
): Promise<void> {
  await board.recordResult(result);
  await telemetry?.record({ type: "result", taskId: result.taskId, agentId: result.agentId, actualCost: result.actualCost, harnessId: result.harnessId });

  const agent = registry.get(result.agentId);

  // A detected session-limit (429) hit isn't a real failure — it's a
  // clock. Checked before the plain `!result.ok` branch below (a 429
  // result also carries `ok: false`) so it reschedules instead of
  // stranding the task on `failed` for a human to notice and manually
  // re-run — see runClaude/parseSessionLimitReset and
  // docs/SDD-pipeline-automation.md §3.2.
  if (result.retryAfter) {
    await board.scheduleRetry(result.taskId, result.retryAfter);
    return;
  }

  if (!result.ok) {
    await board.move(result.taskId, "failed");
    return;
  }

  // A reviewer pass carries a verdict (see TaskResult.verdict) — that
  // entirely bypasses the tier-based done/review split below, since a
  // reviewer is readonly-tier and would otherwise land straight on
  // `done` the same as any other read-only success, silently dropping
  // the verdict on the floor.
  if (result.verdict !== undefined) {
    await handleReviewVerdict(board, registry, result, runner);
    return;
  }

  // The memory-curation hook: reads the agent's own declared `outputs`
  // contract (agents/manifest.yaml), never a hardcoded agent id — a
  // future second memory-writing agent gets this for free. Wholesale
  // replace, not append: memory-curator is handed the current file's own
  // contents as part of its input (see gatherSessionLessons,
  // src/core/memory-scheduler.ts) precisely so its own summary is
  // already deduped/consolidated against what's already there — see
  // docs/SDD-memory-curator.md §9.
  if (agent?.outputs.includes("memory-entries")) {
    await writeMemoryLessons(memoryPath, result.summary);
  }

  if (agent?.tier !== "write") {
    await board.move(result.taskId, "done");
    return;
  }

  if (agent.handoffs?.includes("reviewer")) {
    const task = await board.get(result.taskId);
    // A vanished task (deleted mid-run) has nothing left to queue a
    // review for — recordResult above already captured the result for
    // history; there's no card left to move or spawn a follow-up from.
    if (task) {
      await board.move(result.taskId, "pending-review");
      await spawnReviewerTask(board, task, result);
    }
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

/**
 * Queues an automated reviewer pass for a write-tier success instead of
 * stopping for a human yet — see finishResult's `handoffs.includes
 * ("reviewer")` branch, the only caller. `reviewLineageId` is set to the
 * implementer task's own id when this is the first pass in a new
 * lineage, deliberately (not a random id): WriteExecutor/
 * CodexWriteExecutor key a pushback re-attempt's worktree off
 * `task.reviewLineageId ?? task.id`, so reusing the original task's own
 * id as the lineage id is what makes worktree reuse fall out for free,
 * with no separate id to keep in sync.
 *
 * `labels: ["review"]` is deliberate, not decorative: resolveHandoffAllowlist
 * restricts this follow-up's routing candidates to exactly the
 * implementer's declared handoffs (here, `["reviewer"]`), but the router
 * still requires a positive tag-overlap score to route with confidence
 * (see RuleStrategy) — zero labels or a label reviewer's own tags don't
 * contain would land this on `no-match` even though `reviewer` is the
 * only eligible candidate. `"review"` is one of reviewer's declared tags
 * in agents/manifest.yaml, so it always scores a confident match.
 *
 * `repo` points at the implementer's worktree, when it ran in one — the
 * whole reason the reviewer's own read-only run (ReadOnlyExecutor spawns
 * `claude` with `cwd: task.repo`) actually sees the diff under review
 * instead of the original repo's unrelated working tree.
 */
async function spawnReviewerTask(board: Board, implementerTask: TaskCard, result: TaskResult): Promise<void> {
  const reviewLineageId = implementerTask.reviewLineageId ?? implementerTask.id;
  await board.create({
    title: `Review: ${implementerTask.title}`,
    body: implementerTask.body,
    labels: ["review"],
    repo: result.worktree?.path ?? implementerTask.repo,
    parentTaskId: implementerTask.id,
    reviewLineageId,
    pushbackCount: 0,
  });
}

/**
 * Everything that happens once an automated reviewer pass reports back
 * — the only place `TaskResult.verdict` is ever read. Always marks the
 * reviewer task itself `done` first (its job, unlike the implementer's,
 * ends the moment it reports a verdict either way), then either resumes
 * the implementer task's own done-vs-review decision (approve), spawns a
 * pushback re-attempt (changes_requested, under the limit), or escalates
 * to a human (changes_requested, at the limit) — see resumeAfterApproval,
 * spawnPushbackImplementer, and the escalation branch below respectively.
 */
async function handleReviewVerdict(board: Board, registry: Registry, result: TaskResult, runner: CommandRunner): Promise<void> {
  const reviewerTask = await board.get(result.taskId);
  if (!reviewerTask) return; // vanished mid-run — nothing left to resolve

  await board.move(reviewerTask.id, "done");

  if (!reviewerTask.parentTaskId) return;
  const implementerTask = await board.get(reviewerTask.parentTaskId);
  if (!implementerTask) return; // the implementer task it was reviewing is gone

  if (result.verdict === "approve") {
    await resumeAfterApproval(board, registry, implementerTask, runner);
    return;
  }

  const pushbackCount = implementerTask.pushbackCount ?? 0;
  if (pushbackCount >= 5) {
    const lineageId = implementerTask.reviewLineageId ?? implementerTask.id;
    const escalationContext = await buildEscalationContext(board, lineageId);
    await board.escalate(implementerTask.id, escalationContext);
    return;
  }

  await spawnPushbackImplementer(board, implementerTask, reviewerTask, result);
}

/**
 * An approved review resumes exactly the done-vs-review policy
 * finishResult would have applied to the implementer's own success, had
 * it not been deferred into `pending-review` to wait for this — same
 * autoMerge + trustLevel: "high" fast path, same worktree-merge
 * mechanics (tryAutoMerge), same fallback to `review` for a human. Reads
 * the implementer's own recorded result (for its `worktree`, if any) and
 * its routed agent (for `autoMerge`/`trustLevel`) rather than re-deriving
 * either from the reviewer's result, which carries neither.
 */
async function resumeAfterApproval(board: Board, registry: Registry, implementerTask: TaskCard, runner: CommandRunner): Promise<void> {
  const agent = implementerTask.routedTo ? registry.get(implementerTask.routedTo) : undefined;
  const originalResult = await board.getResult(implementerTask.id);

  if (agent?.autoMerge && agent.trustLevel === "high" && originalResult && (await tryAutoMerge(board, originalResult, runner))) {
    await board.move(implementerTask.id, "done");
    return;
  }

  await board.move(implementerTask.id, "review");
}

/**
 * A rejected review, under the pushback limit: creates the next
 * implementer attempt in the same lineage — same title/labels/repo,
 * `parentTaskId` pointing at the reviewer task (not the superseded
 * implementer task) so it inherits the reviewer's own declared handoffs
 * via resolveHandoffAllowlist, `pushbackCount` incremented, and the
 * reviewer's feedback appended to the body as a clearly delimited,
 * cumulative section (attempt N's body carries every prior round's
 * feedback too, not just the latest) — then marks the superseded card
 * with `supersededBy`, never touching its `status` or repurposing
 * `failed` (see TaskCard.supersededBy — this isn't a real failure, and
 * conflating the two would skew failure-rate metrics for something
 * that's actually the system working as designed).
 */
async function spawnPushbackImplementer(board: Board, implementerTask: TaskCard, reviewerTask: TaskCard, result: TaskResult): Promise<void> {
  const newPushbackCount = (implementerTask.pushbackCount ?? 0) + 1;
  const reviewLineageId = implementerTask.reviewLineageId ?? implementerTask.id;
  const feedback = result.reviewFeedback ?? "(reviewer requested changes but gave no feedback text)";
  const body = `${implementerTask.body}\n\n---\nReviewer feedback (attempt ${newPushbackCount}):\n${feedback}`;

  const nextAttempt = await board.create({
    title: implementerTask.title,
    body,
    labels: implementerTask.labels,
    repo: implementerTask.repo,
    parentTaskId: reviewerTask.id,
    reviewLineageId,
    pushbackCount: newPushbackCount,
  });

  await board.setSupersededBy(implementerTask.id, nextAttempt.id);
}

/**
 * The full, ordered history of reviewer feedback across a lineage,
 * each entry labeled with its attempt number — what a human reads
 * instead of replaying every TaskCard in the chain by hand once a task
 * escalates. Walks `getLineage` (every card sharing this lineage id, in
 * creation order) filtered to the reviewer cards specifically, and reads
 * each one's own recorded result for the feedback text it left behind.
 */
async function buildEscalationContext(board: Board, reviewLineageId: string): Promise<string> {
  const lineage = await board.getLineage(reviewLineageId);
  const entries: string[] = [];
  let attempt = 1;
  for (const card of lineage) {
    if (card.routedTo !== "reviewer") continue;
    const result = await board.getResult(card.id);
    if (result?.reviewFeedback === undefined) continue;
    entries.push(`Attempt ${attempt}: ${result.reviewFeedback}`);
    attempt++;
  }
  return entries.join("\n\n");
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

/** Label the auto-created integrator follow-up carries — must overlap
 *  the `integrator` agent's declared tags in agents/manifest.yaml for
 *  the router to dispatch it with confidence, and doubles as the marker
 *  `maybeSpawnIntegrator` checks for to stay idempotent (see below). */
const INTEGRATOR_LABEL = "integration";

/**
 * Watches for every sibling under one `parentTaskId` reaching `done`,
 * and auto-creates a single `integrator` follow-up scoped to the
 * *parent* once they all have — closes a real gap found live in this
 * project's own review-handoff feature (subtasks D/E: D's reviewer
 * never saw board.html, E's reviewer explicitly deferred integration
 * verification pending D, and nothing ever re-checked the pair once
 * both landed — a human had to manually diff both worktrees to find the
 * resulting request-body mismatch). A per-subtask reviewer only ever
 * sees one subtask's diff; this is the check that runs once the whole
 * *set* has landed.
 *
 * Always wired (not gated behind WISSEL_ORCHESTRATOR) — the same way
 * `spawnReviewerTask` always queues its follow-up regardless of whether
 * the automatic sweep loop dispatches it. The integrator card still
 * needs to actually run via `sweep()` or a manual `/run`, same as any
 * other auto-created follow-up; this only guarantees the card exists
 * the moment the set completes, not that it dispatches itself.
 *
 * Listens on every `task.moved` event rather than hooking into
 * `finishResult` specifically: a real completion just as often happens
 * through `POST /tasks/:id/merge` (a human's explicit click, which
 * calls `board.move(id, "done")` directly, never through
 * `finishResult`) as through an automated done-vs-review decision —
 * confirmed against server.ts's own merge handler. Board events are the
 * one place every path that can produce `status: "done"` converges.
 */
export function wireAutoIntegrator(board: Board & { events: EventEmitter }, registry: Registry): void {
  board.events.on("event", (evt: BoardEvent) => {
    if (evt.type !== "task.moved" || evt.task.status !== "done") return;
    void maybeSpawnIntegrator(board, registry, evt.task).catch((e) =>
      console.error(`orchestrator: failed to check/spawn integrator for ${evt.task.id}: ${(e as Error).message}`),
    );
  });
}

async function maybeSpawnIntegrator(board: Board, registry: Registry, task: TaskCard): Promise<void> {
  // `parentTaskId` means two structurally different things depending on
  // which task carries it, and this function must only ever react to
  // one of them. A genuine subtask card (e.g. one of a planner's
  // decomposed pieces) has its parentTaskId point at the planner task.
  // But a reviewer task's parentTaskId points at the implementer it
  // reviewed, and a pushback re-attempt's parentTaskId points at the
  // reviewer that rejected it (see spawnReviewerTask/
  // spawnPushbackImplementer) — review-lineage chaining, not subtask
  // decomposition. A reviewer task reaches `done` on *every* review
  // pass, approve or reject (handleReviewVerdict), which — confirmed
  // live, the first time the sweep loop actually ran this for real —
  // fired this function on every single review completion, spawning a
  // bogus "Integrate: ..." card whose parentTaskId pointed at an
  // implementer task, got its routing candidates wrongly restricted to
  // that implementer's own handoffs (e.g. just `[reviewer]`), and
  // crashed or landed on no-match. Reviewer tasks always carry `labels:
  // ["review"]`; every task in a pushback lineage (the reviewer's own
  // follow-up entry and every re-attempt) always carries a defined
  // `pushbackCount`, including 0 on the very first reviewer pass — a
  // genuine top-level subtask card never has either set at creation.
  if (task.labels.includes("review") || task.pushbackCount !== undefined) return;

  const parentId = task.parentTaskId;
  if (!parentId) return;
  const parent = await board.get(parentId);
  if (!parent) return;

  const siblings = (await board.list()).filter((t) => t.parentTaskId === parentId);
  // An integrator card is itself a sibling under the same parentTaskId
  // (see below) — excluded here so it's never counted as one of "the
  // subtasks" that must all be done, and its own presence is what makes
  // this idempotent: multiple siblings reaching `done` in quick
  // succession each fire this listener, but only the first one to
  // observe "no integrator card yet" creates one.
  const subtasks = siblings.filter((t) => !t.labels.includes(INTEGRATOR_LABEL));
  if (subtasks.length === 0) return;
  if (!subtasks.every((t) => t.status === "done")) return;
  if (siblings.some((t) => t.labels.includes(INTEGRATOR_LABEL))) return;

  const integratorAgent = registry.get("integrator");
  if (!integratorAgent) return; // no integrator agent registered — nothing to route this to

  await board.create({
    title: `Integrate: ${parent.title}`,
    body: buildIntegratorBody(parent, subtasks),
    labels: [INTEGRATOR_LABEL],
    repo: parent.repo,
    parentTaskId: parentId,
  });
}

function buildIntegratorBody(parent: TaskCard, subtasks: TaskCard[]): string {
  const list = subtasks.map((t) => `- ${t.title} (${t.id})`).join("\n");
  return [
    `Every subtask under "${parent.title}" has landed. Verify the set together, not just each piece individually:`,
    "",
    list,
    "",
    "Run the full test suite. Then specifically check for cross-subtask integration defects a per-subtask reviewer" +
      " structurally can't catch — e.g. a UI change calling an endpoint another subtask defined, with mismatched" +
      " request/response shapes (this exact bug shipped once in this project: one subtask's fetch() call sent no" +
      " request body at all for an endpoint another subtask required one for). Grep every fetch()/request call added" +
      " across these subtasks against the endpoint it targets and confirm the shapes actually match.",
    "",
    "Report any defect found, with the specific files/lines on both sides of the mismatch.",
  ].join("\n");
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
  /** Caps how many tasks `sweep()` will have in flight at once — see
   *  docs/SDD-pipeline-automation.md §3.6. Undefined means unlimited
   *  (today's behavior). Only meaningful once WISSEL_ORCHESTRATOR is on;
   *  a human's manual `/run` (runNow) always bypasses this, the same
   *  way it bypasses every other sweep() gate. Exists specifically so
   *  turning on autonomous dispatch doesn't also turn a credit-limited
   *  account's slow, supervised pipeline into a fast, unsupervised one —
   *  built after this project's own pipeline hit real 429s under
   *  entirely manual, one-at-a-time dispatch. */
  maxConcurrentTasks?: number;
  /** Caps total `actualCost` sweep() will let accumulate (from
   *  telemetry's own recorded spend, not estimates) within the current
   *  UTC day before it stops dispatching further work — undefined means
   *  unlimited. Checked once per sweep() call, not per task: a coarse,
   *  same-round guard against runaway multi-day spend, not a
   *  per-dispatch meter (dispatched-but-not-yet-finished tasks in the
   *  same round aren't counted against it, since their real cost isn't
   *  known until they finish). Requires `telemetry` to be set — a no-op
   *  otherwise. */
  spendCeilingUsd?: number;
  /** Passed straight through to every internal `finishResult` call's own
   *  `memoryPath` param — see its doc comment. Undefined defaults to the
   *  real repo-root memory/lessons.md, same as finishResult's own
   *  default; overridable so tests (and src/core/memory-scheduler.ts's
   *  own gather step, kept in sync via the same option at the
   *  createApp/server.ts level) never touch this repo's real file. */
  memoryPath?: string;
}

/** Midnight UTC on `now`'s calendar day — the window `spendCeilingUsd`
 *  is measured against. A plain top-of-UTC-day boundary, not
 *  timezone-aware to Milton's own clock — simple and unambiguous is
 *  worth more here than perfectly matching a human's sense of "today". */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

    // Computed once per sweep() call, not per task — see
    // OrchestratorOptions.spendCeilingUsd's own doc comment for why this
    // is a coarse per-round guard, not a precise per-dispatch meter.
    const spentToday =
      this.opts.spendCeilingUsd !== undefined && this.telemetry ? await this.telemetry.sumCostSince(startOfUtcDay(new Date())) : undefined;
    const overSpendCeiling = spentToday !== undefined && this.opts.spendCeilingUsd !== undefined && spentToday >= this.opts.spendCeilingUsd;

    for (const task of tasks) {
      if (this.inFlight.has(task.id)) continue;
      if (task.routedTo) continue; // already routed — a human or a prior run owns it now
      if (task.status !== "inbox" && task.status !== "ready") continue;

      // A task Board.scheduleRetry rescheduled after a 429 isn't
      // eligible again until its clock has passed — reads the same as
      // "blocked" below, just on a timer instead of a dependency.
      if (task.retryAfter && new Date(task.retryAfter).getTime() > Date.now()) continue;

      const deps = task.dependsOn ?? [];
      // A dangling dependency, a not-yet-done one, and one whose id was
      // superseded by a pushback re-attempt that isn't done yet all read
      // as "blocked" — resolveLiveTip follows a supersededBy chain to
      // whatever's actually alive, so a dep id frozen at pending-review
      // forever doesn't block its dependents forever too.
      const blocked = deps.some((depId) => resolveLiveTip(byId.get(depId), byId)?.status !== "done");
      if (blocked) continue;

      if (this.opts.maxConcurrentTasks !== undefined && this.inFlight.size >= this.opts.maxConcurrentTasks) continue;
      if (overSpendCeiling) continue;

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
   * doesn't exist, is already in flight, or has been superseded by a
   * pushback re-attempt (see TaskCard.supersededBy) — a click on an
   * abandoned card from a stale board view must never resurrect its
   * worktree/branch out from under whichever re-attempt is now the live
   * one in that lineage.
   */
  async runNow(taskId: string, executors: Executor[]): Promise<void> {
    if (this.inFlight.has(taskId)) throw new Error(`task ${taskId} is already running`);
    const task = await this.board.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.supersededBy) {
      throw new Error(`task ${taskId} was superseded by ${task.supersededBy} — run that task instead`);
    }

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
      await finishResult(this.board, this.registry, result, this.telemetry, undefined, this.opts.memoryPath);
    } catch (e) {
      console.error(`orchestrator: unexpected error processing task ${task.id}: ${(e as Error).message}`);
    }
  }
}
