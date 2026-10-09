import type { EventEmitter } from "node:events";
import type { Board, BoardEvent } from "../services/board.ts";
import type { PipelineStore } from "../services/pipelines.ts";
import type { TelemetryLog } from "../services/telemetry.ts";
import { HarnessOverrideError, type HarnessPool } from "./harness-pool.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { runViaBun } from "../executors/claude-cli.ts";
import { determineWorktreeMergeState, mergeTaskWorktree, removeTaskWorktree, type TaskWorktree } from "../services/worktree.ts";
import { DEFAULT_MEMORY_PATH, writeMemoryLessons } from "../services/memory.ts";
import { handlePipelineStepResult } from "./pipeline-runner.ts";
import { formatMcpTranscript } from "../services/mcp-transcript.ts";
import type { AgentDef, Executor, Harness, HarnessTool, RoutingDecision, SubtaskPlanItem, TaskCard, TaskResult } from "./types.ts";

/** What finishResult needs to drive a pipeline step's own follow-up work
 *  (see the `task.pipelineId !== undefined` branch below) — passed
 *  through as the last, optional argument by the only caller that ever
 *  produces a pipeline-step TaskResult (pipeline-runner.ts itself; see
 *  its own PipelineRunnerContext, which this is a subset of). Every
 *  other caller of finishResult (Orchestrator.process(), the
 *  POST /tasks/:id/result endpoint) never dispatches a pipeline step in
 *  this phase, so they never need to pass this — see
 *  docs/SDD-pipelines.md §3.3. `harnesses` is threaded through so the
 *  *next* step a pipeline run activates (via handlePipelineStepResult ->
 *  runStepAndSuccessors) still acquires/releases a real Harness, the
 *  same as the entry step(s) startPipelineRun kicked off directly. */
export interface PipelineFinishContext {
  executors: Executor[];
  pipelines: PipelineStore;
  harnesses?: HarnessPool;
}

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

/** A "Make audio" step's size and synthesis time (TtsExecutor's handoff
 *  `data.audio`, docs/SDD-ai-news-podcast.md §3.7), for the telemetry
 *  result event, so Kokoro's speed can be tracked across runs.
 *  Undefined for every other result. */
function audioTelemetry(result: TaskResult): { bytes: number; synthesisSeconds: number } | undefined {
  const audio = result.pipelineHandoff?.data?.audio as { bytes?: unknown; synthesisSeconds?: unknown } | undefined;
  if (!audio || typeof audio.bytes !== "number" || typeof audio.synthesisSeconds !== "number") return undefined;
  return { bytes: audio.bytes, synthesisSeconds: audio.synthesisSeconds };
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
 * Separately (not a write-tier review-gate exception — the planner is
 * readonly-tier and would otherwise land straight on the plain
 * `agent.tier !== "write"` done branch below), a result carrying
 * `TaskResult.subtaskPlan` is a planner's own decomposition: it's routed
 * to `spawnSubtasksFromPlan` instead, which is what turns the plan into
 * real child cards.
 *
 * `runner` is used for the auto-merge path and passed through to
 * handleReviewVerdict for the same reason — injectable so tests never
 * spawn a real git process; defaults to the real one. `memoryPath` is
 * the same kind of injection point for the memory-persistence hook
 * below — defaults to the real repo-root memory/lessons.md. `pipelineCtx`
 * is only ever passed by pipeline-runner.ts's own recursive calls (see
 * PipelineFinishContext above) — every other caller leaves it undefined,
 * which is correct as long as they never hand this a result for a task
 * with `pipelineId` set (see the branch below, which throws rather than
 * silently stranding such a task if that invariant is ever violated).
 */
export async function finishResult(
  board: Board,
  registry: Registry,
  result: TaskResult,
  telemetry?: TelemetryLog,
  runner: CommandRunner = runViaBun,
  memoryPath: string = DEFAULT_MEMORY_PATH,
  pipelineCtx?: PipelineFinishContext,
): Promise<void> {
  await board.recordResult(result);
  const audio = audioTelemetry(result);
  await telemetry?.record({
    type: "result",
    taskId: result.taskId,
    agentId: result.agentId,
    actualCost: result.actualCost,
    harnessId: result.harnessId,
    ...(audio ? { audio } : {}),
    // A session-limit (429) reschedule, so the retrospective digest can
    // count them (docs/SDD-wissel-retro-podcast.md §3.1).
    ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
  });

  const agent = registry.get(result.agentId);

  // A detected session-limit (429) hit isn't a real failure — it's a
  // clock. Checked before the plain `!result.ok` branch below (a 429
  // result also carries `ok: false`) so it reschedules instead of
  // stranding the task on `failed` for a human to notice and manually
  // re-run — see runClaude/parseSessionLimitReset and
  // docs/SDD-pipeline-automation.md §3.2. Known, named gap: a pipeline
  // step that hits this never gets picked up again automatically in
  // this phase (see docs/SDD-pipelines.md's own retry-scope note) —
  // sweep() never touches a pipeline step task (see
  // pipeline-runner.ts's own doc comments on why), so nothing revisits
  // it once rescheduled.
  if (result.retryAfter) {
    await board.scheduleRetry(result.taskId, result.retryAfter);
    return;
  }

  // A pipeline step's own done-vs-review decision — and, on failure,
  // whether the run it belongs to has now settled — is owned by the
  // pipeline definition, not this function's default tier-based policy
  // below. Detected off the *task*, not the result shape, so both a
  // clean pipeline-handoff success and a plain failure (no handoff
  // parsed at all) are caught here — see docs/SDD-pipelines.md §3.3/§4.
  const task = await board.get(result.taskId);
  if (task?.pipelineId !== undefined) {
    if (!pipelineCtx) {
      throw new Error(`finishResult: task ${task.id} is a pipeline step but no pipelineCtx was provided — only pipeline-runner.ts should ever produce a result for one`);
    }

    // Real finding from MCP orchestration subtask 7's integration proof:
    // a pipeline step's own result can carry `mcpApprovalRequest` (an
    // agent describing a blocked, approval-required MCP tool call — see
    // AgentDef.mcpAccess/the mcpApprovalRequest branch below, which this
    // mirrors) with `result.ok` still true. Before this fix, this
    // branch's own unconditional `board.move(task.id, result.ok ? "done"
    // : "failed")` ran first and landed such a step straight on "done" —
    // silently succeeding instead of surfacing the approval gate, the
    // exact failure mode docs/SDD-mcp-orchestration.md §6 Subtask 7 named
    // as a real composition question subtask 3 never had reason to test
    // against the pipeline engine. Checked first, same priority order as
    // the non-pipeline path's own mcpApprovalRequest branch a few lines
    // down: the step hasn't actually settled (done/failed) in this case,
    // it's parked on a human decision exactly like a non-pipeline task in
    // the same state (see TaskCard.pendingMcpApproval). No call to
    // handlePipelineStepResult — there's nothing to advance until a human
    // resolves it via `POST /tasks/:id/mcp-approval/{approve,deny}`, and
    // that endpoint spawns a standalone follow-up task, never a
    // resumption of this run (see its own doc comment) — the same v1
    // limitation named in §3.5, now also true for a pipeline step.
    if (result.mcpApprovalRequest !== undefined) {
      await board.requestMcpApproval(task.id, result.mcpApprovalRequest);
      return;
    }

    await board.move(task.id, result.ok ? "done" : "failed");
    await handlePipelineStepResult(board, registry, task, result, { ...pipelineCtx, telemetry, memoryPath });
    return;
  }

  if (!result.ok) {
    await board.move(result.taskId, "failed");
    return;
  }

  // An mcp-approval-request takes this result straight to the human
  // queue via Board.requestMcpApproval, regardless of agent.tier — a
  // readonly-tier agent with a pending-approval MCP grant and zero file
  // access still needs this stop (see AgentDef.mcpAccess's own doc
  // comment: tier stays "file/bash blast radius," MCP approval is a
  // completely orthogonal gate). Checked ahead of verdict/subtaskPlan:
  // a described-but-blocked call needs a human's decision before
  // anything else about this result matters. A vanished task (deleted
  // mid-run) has nothing left to move — recordResult above already
  // captured the request for history.
  if (result.mcpApprovalRequest !== undefined) {
    if (task) await board.requestMcpApproval(task.id, result.mcpApprovalRequest);
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

  // A planner pass carries a subtask plan (see TaskResult.subtaskPlan) —
  // same reasoning as the verdict branch above: the planner is
  // readonly-tier and would otherwise land straight on `done` the same
  // as any other read-only success, silently dropping the decomposition
  // on the floor instead of turning it into real cards.
  if (result.subtaskPlan !== undefined) {
    // A vanished task (deleted mid-run) has nothing left to spawn
    // subtasks under — recordResult above already captured the plan for
    // history; there's no card left to move or attach children to.
    if (task) await spawnSubtasksFromPlan(board, task, result.subtaskPlan);
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
    // A vanished task (deleted mid-run) has nothing left to queue a
    // review for — recordResult above already captured the result for
    // history; there's no card left to move or spawn a follow-up from.
    if (task) {
      await board.move(result.taskId, "pending-review");
      await spawnReviewerTask(board, task, result, agent);
    }
    return;
  }

  if (agent.autoMerge && agent.trustLevel === "high" && (await tryAutoMerge(board, registry, result, runner))) {
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
 *
 * `implementerAgent.reviewTarget === "tool-calls"` is the one branch off
 * today's behavior: a tool-calling run has no worktree/file-change state
 * for the reviewer to discover on its own (no `repo`, no diff), so the
 * transcript (`formatMcpTranscript`) is embedded directly into the
 * review task's body instead. Every other agent (`reviewTarget`
 * undefined, or `"diff"`) gets a byte-identical body to today — see
 * docs/SDD-mcp-orchestration.md §3.4.
 */
async function spawnReviewerTask(board: Board, implementerTask: TaskCard, result: TaskResult, implementerAgent: AgentDef): Promise<void> {
  const reviewLineageId = implementerTask.reviewLineageId ?? implementerTask.id;
  const body =
    implementerAgent.reviewTarget === "tool-calls" && result.mcpCalls
      ? `${implementerTask.body}\n\n---\nTool calls made:\n${formatMcpTranscript(result.mcpCalls)}`
      : implementerTask.body;
  await board.create({
    title: `Review: ${implementerTask.title}`,
    body,
    labels: ["review"],
    repo: result.worktree?.path ?? implementerTask.repo,
    parentTaskId: implementerTask.id,
    reviewLineageId,
    pushbackCount: 0,
  });
}

/**
 * Turns a planner's own decomposition (see TaskResult.subtaskPlan) into
 * real cards — the whole point of the structured-output contract: the
 * planner stays readonly/plan-mode with zero write access, and this
 * deterministic code (not the LLM) is what actually calls
 * `board.create()`, mirroring by hand what used to require a human
 * reading the planner's prose and creating each card themselves.
 *
 * Moves the planner task to `done` first — its job ends the moment it
 * reports a plan, same as a reviewer task's job ends the moment it
 * reports a verdict (see handleReviewVerdict). Then walks `plan` in
 * array order, creating each item via `board.create()` with
 * `parentTaskId` pointing at the planner task (so a later
 * `wireAutoIntegrator` pass, and any human browsing the board, can see
 * the whole decomposition as one group) and `dependsOn` resolved against
 * the ids actually generated for earlier items *in this same call* — the
 * `createdIds[item.dependsOnIndex]` lookup is safe unguarded because
 * parseSubtaskPlan already rejected any `dependsOnIndex` that isn't a
 * valid earlier index before this ever runs. No further event/log beyond
 * `board.create()`'s own `task.created` event is needed — the same as
 * spawnReviewerTask/spawnPushbackImplementer above, neither of which logs
 * separately either; the board event is what already surfaces every
 * creation to SSE listeners and the board UI.
 */
async function spawnSubtasksFromPlan(board: Board, plannerTask: TaskCard, plan: SubtaskPlanItem[]): Promise<void> {
  await board.move(plannerTask.id, "done");

  const createdIds: string[] = [];
  for (const item of plan) {
    const dependsOn = item.dependsOnIndex !== undefined ? [createdIds[item.dependsOnIndex]!] : undefined;
    const created = await board.create({
      title: item.title,
      body: item.body,
      labels: item.labels,
      repo: plannerTask.repo,
      parentTaskId: plannerTask.id,
      dependsOn,
    });
    createdIds.push(created.id);
  }
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
  await resumeAfterReviewVerdict(board, registry, reviewerTask, result, runner);
}

/** Every outcome `resumeAfterReviewVerdict`/`resumeAfterApproval` can
 *  leave a card in. `"unresolved"` is the one crash-recovery-only
 *  outcome (see resumeAfterApproval's own doc comment) — the live path
 *  (handleReviewVerdict, just above) can never actually produce it,
 *  since it always calls this with a worktree branch that was only ever
 *  just created, never already merged. `"no-op"` covers a reviewer or
 *  implementer task that vanished (deleted) mid-flight — nothing left to
 *  resolve either way. */
export type ReviewVerdictOutcome = "done" | "review" | "unresolved" | "pushback" | "escalated" | "no-op";

/**
 * Everything `handleReviewVerdict` does once its reviewer task is
 * already marked `done` — split out so `src/core/crash-recovery.ts`'s
 * startup reconciliation (see docs/SDD-crash-recovery.md's interrupted-
 * review-verdict section) can re-drive exactly this same
 * approve/pushback/escalate decision for a reviewer that reached `done`
 * with a recorded verdict just before a crash, instead of a parallel
 * copy of this logic. `reviewerTask` is assumed already `done` by the
 * time this runs — the live caller just moved it there; the recovery
 * caller finds it already there from before the crash.
 */
export async function resumeAfterReviewVerdict(
  board: Board,
  registry: Registry,
  reviewerTask: TaskCard,
  result: TaskResult,
  runner: CommandRunner,
): Promise<ReviewVerdictOutcome> {
  if (!reviewerTask.parentTaskId) return "no-op";
  const implementerTask = await board.get(reviewerTask.parentTaskId);
  if (!implementerTask) return "no-op"; // the implementer task it was reviewing is gone

  if (result.verdict === "approve") {
    return resumeAfterApproval(board, registry, implementerTask, runner);
  }

  const pushbackCount = implementerTask.pushbackCount ?? 0;
  if (pushbackCount >= 5) {
    const lineageId = implementerTask.reviewLineageId ?? implementerTask.id;
    const escalationContext = await buildEscalationContext(board, lineageId);
    await board.escalate(implementerTask.id, escalationContext);
    return "escalated";
  }

  await spawnPushbackImplementer(board, implementerTask, reviewerTask, result);
  return "pushback";
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
 *
 * Idempotent against a crash that already ran the real git merge to
 * completion before stopping (src/core/crash-recovery.ts's interrupted-
 * review-verdict reconciliation is the only caller that can ever
 * actually hit this): before calling `tryAutoMerge`, checks whether
 * `originalResult.worktree`'s own branch is already merged
 * (`determineWorktreeMergeState`). Already merged — crash landed between
 * `mergeTaskWorktree` finishing and this function's own `board.move` —
 * skips straight to `done` (running `removeTaskWorktree`'s own cleanup
 * first, in case the crash also landed before *that*), never re-running
 * `git merge`. Unprovable (worktree and branch both gone, no matching
 * merge commit in history either — a discarded worktree looks identical
 * to this from the outside) — returns `"unresolved"` rather than
 * guessing; the card stays exactly as found for a human. On the live
 * path this gate is always `"not-merged"`: a reviewer verdict only ever
 * reaches this function once, with a worktree branch that was only ever
 * just created, never already merged — so this costs two extra cheap
 * `git` calls there and changes nothing else.
 */
export async function resumeAfterApproval(board: Board, registry: Registry, implementerTask: TaskCard, runner: CommandRunner): Promise<ReviewVerdictOutcome> {
  const agent = implementerTask.routedTo ? registry.get(implementerTask.routedTo) : undefined;
  const originalResult = await board.getResult(implementerTask.id);

  if (agent?.autoMerge && agent.trustLevel === "high" && originalResult?.worktree) {
    const mergeState = await determineWorktreeMergeState(implementerTask.repo!, originalResult.worktree, implementerTask, runner);
    if (mergeState === "unknown") return "unresolved";
    if (mergeState === "merged") {
      await removeTaskWorktree(implementerTask.repo!, originalResult.worktree, runner);
      await board.move(implementerTask.id, "done");
      return "done";
    }
  }

  if (agent?.autoMerge && agent.trustLevel === "high" && originalResult && (await tryAutoMerge(board, registry, originalResult, runner))) {
    await board.move(implementerTask.id, "done");
    return "done";
  }

  await board.move(implementerTask.id, "review");
  return "review";
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
 *  clicking Merge — never a bare status change masquerading as one).
 *
 *  A fresh conflict (merge.ok === false) is the one moment
 *  docs/SDD-crash-recovery.md §3.3 identifies as safe to attempt
 *  automatic resolution in — see maybeSpawnConflictIntegrator below —
 *  so it's fired here, right where the conflict is first discovered,
 *  not deferred to some later check. Either way this still returns
 *  `false`: the caller's own existing fallback (land on `review` for a
 *  human) is unchanged, now just running alongside whatever the spawned
 *  integrator task produces instead of a bare conflict. */
async function tryAutoMerge(board: Board, registry: Registry, result: TaskResult, runner: CommandRunner): Promise<boolean> {
  if (!result.worktree) return true;
  const task = await board.get(result.taskId);
  if (!task) return false;
  // A worktree only ever exists for a write-tier run, which requires
  // `repo` at creation time (see POST /tasks' validation) — never
  // reachable for a repo-less readonly task.
  const merge = await mergeTaskWorktree(task.repo!, result.worktree, task, runner);
  if (!merge.ok) {
    try {
      await maybeSpawnConflictIntegrator(board, registry, task, result.worktree, merge.message);
    } catch (e) {
      console.error(`orchestrator: failed to check/spawn conflict integrator for ${task.id}: ${(e as Error).message}`);
    }
  }
  return merge.ok;
}

/** Tag the auto-spawned conflict follow-up carries — the exact string
 *  "conflict" is also one of `integrator`'s own declared tags in
 *  agents/manifest.yaml (`tags: [merge, rebase, conflict, integration]`),
 *  and no other agent's tags include it, so a task labeled with only
 *  this one tag routes to `integrator` with full confidence (1/1 tag
 *  overlap, no tie). Reused below as the idempotency marker too. */
const CONFLICT_LABEL = "conflict";

/** Deterministic title for the conflict follow-up spawned under
 *  `originalTask` — doubles as the idempotency key `maybeSpawnConflict
 *  Integrator` searches for (see below), so it's built from `task.id`
 *  rather than `task.title`, which could in principle collide across
 *  two different tasks or change after the follow-up was created. */
function conflictIntegratorTitle(originalTask: TaskCard): string {
  return `Resolve merge conflict: ${originalTask.id}`;
}

/**
 * Auto-creates a single `integrator`-routed follow-up the moment
 * `tryAutoMerge` detects a *fresh* merge conflict — see
 * docs/SDD-crash-recovery.md §3.3 for why this specific moment (and
 * only this moment) is safe to auto-resolve in: nothing else has had a
 * chance to touch a conflict that didn't exist an instant ago, so
 * there's no risk of racing a human's own in-progress manual
 * resolution — unlike reacting to a conflict found lingering at an
 * arbitrary later startup (the separate dangling-merge *visibility*
 * work, which deliberately does not auto-resolve, for exactly that
 * reason).
 *
 * Deliberately does **not** set `parentTaskId` to `originalTask.id`,
 * even though that's the obvious-looking way to link the two cards.
 * `resolveHandoffAllowlist` (above) restricts a follow-up's routing
 * candidates to its parent's routed agent's own declared `handoffs`
 * when `parentTaskId` is set — correct for a real handoff relationship
 * (a reviewer task under an implementer, a pushback re-attempt under a
 * reviewer), but wrong here: `originalTask` is very often routed to
 * `implementer`, whose `handoffs` is `[reviewer]` — setting
 * `parentTaskId` would restrict this follow-up to *only* "reviewer",
 * silently stranding it exactly the way a planner subtask once was
 * (see resolveHandoffAllowlist's own doc comment, and the identical
 * deliberate omission in `POST /tasks/:id/mcp-approval/approve`,
 * src/api/server.ts, which hit this exact trap first). Idempotency and
 * display linkage are instead carried by a deterministic title (see
 * conflictIntegratorTitle) built from `originalTask.id`, plus the id
 * spelled out again in the body for a human reading the card.
 *
 * Idempotent: a second conflict for a task that already has a
 * follow-up (e.g. a retried merge attempt hitting the same conflict
 * twice) creates no duplicate — mirrors maybeSpawnIntegrator's own
 * "check before create" discipline, just keyed by title instead of
 * parentTaskId+label for the reason above.
 *
 * Deliberately does NOT add `handoffs: [reviewer]` to `integrator`'s
 * own manifest entry (agents/manifest.yaml) to put this follow-up's own
 * attempt through the automated reviewer pushback loop before it lands.
 * `integrator` is shared with a second, unrelated trigger
 * (maybeSpawnIntegrator's subtask-set-completion check above) —
 * `handoffs` is a static per-agent field (see AgentDef.handoffs), so
 * adding it here would turn on the pushback loop for *that* use case
 * too, a behavior change well beyond this one trigger's scope (and the
 * same reasoning `pipeline-reviewer` was given its own separate agent
 * id over, rather than widening `reviewer`, for a similar "two callers
 * want different behavior off one id" shape — see its own manifest
 * comment). The safety net this follow-up actually gets is the
 * existing one every write-tier task without a reviewer handoff
 * already has: it lands on the human `review` queue, where a bad
 * resolution is caught before anyone clicks Merge — same gate, not a
 * weaker one, just not the extra automated pass. Worth revisiting as a
 * dedicated `handoffs`-enabled agent id if conflict-resolution quality
 * in practice ever calls for it.
 *
 * Sets `extraAllowedDirs: [originalTask.repo]` on the created task —
 * not optional decoration. This follow-up's own write-tier run gets a
 * *fresh* worktree of its own (WriteExecutor/createTaskWorktree, same
 * as every other write-tier task), a different absolute path from
 * `originalTask.repo`, where the real conflict actually lives (that's
 * where `mergeTaskWorktree`'s `git merge` ran). Without this grant, the
 * `--add-dir`-gated sandbox that confirmed-live denies file/Bash access
 * outside a run's own worktree (see TaskCard.extraAllowedDirs's own doc
 * comment, docs/SDD-pipeline-automation.md's Subtask 3 smoke-test
 * notes) would make every instruction below to touch
 * `originalTask.repo` directly fail closed instead of actually
 * resolving anything — a task that *looks* actionable but structurally
 * can't do the one thing it was spawned to do.
 *
 * Also sets `extraAllowedTools` granting the exact `git -C
 * <originalTask.repo> status/diff/add/commit` invocations
 * `buildConflictIntegratorBody` below instructs the agent to run —
 * `extraAllowedDirs` alone only grants file-system access to the path
 * (`--add-dir`), it does NOT make `acceptEdits`' own Bash gating
 * reliably allow those specific commands (confirmed live: a real run
 * with only `extraAllowedDirs` set hit repeated Bash permission denials
 * on exactly these commands and never completed the merge — see
 * TaskCard.extraAllowedTools' own doc comment). Without this, the
 * follow-up could read/inspect the conflict but could never actually
 * finish it.
 */
export async function maybeSpawnConflictIntegrator(
  board: Board,
  registry: Registry,
  originalTask: TaskCard,
  worktree: TaskWorktree,
  conflictMessage: string,
): Promise<void> {
  const integratorAgent = registry.get("integrator");
  if (!integratorAgent) return; // no integrator agent registered — nothing to route this to

  const title = conflictIntegratorTitle(originalTask);
  const existing = (await board.list()).some((t) => t.title === title && t.labels.includes(CONFLICT_LABEL));
  if (existing) return;

  const repo = originalTask.repo!;
  await board.create({
    title,
    body: buildConflictIntegratorBody(originalTask, worktree, conflictMessage),
    labels: [CONFLICT_LABEL],
    repo: originalTask.repo,
    extraAllowedDirs: [repo],
    extraAllowedTools: [
      `Bash(git -C ${repo} status:*)`,
      `Bash(git -C ${repo} diff:*)`,
      `Bash(git -C ${repo} add:*)`,
      `Bash(git -C ${repo} commit:*)`,
    ],
  });
}

function buildConflictIntegratorBody(originalTask: TaskCard, worktree: TaskWorktree, conflictMessage: string): string {
  return [
    `Auto-merging "${originalTask.title}" (task ${originalTask.id}) hit a conflict merging worktree branch`,
    `\`${worktree.branch}\` into \`${originalTask.repo}\`. The worktree itself (${worktree.path}) is untouched;`,
    `the conflict is sitting in ${originalTask.repo}'s own working tree right now, left exactly as git produced`,
    "it — nothing has been committed, aborted, or otherwise cleaned up.",
    "",
    "IMPORTANT — your own working directory for this task is a fresh, separate git worktree checked out clean",
    `from the current HEAD of ${originalTask.repo}. It does NOT contain the conflict — your own files will look`,
    "untouched and your own `git status` will come back clean. The actual conflict markers live only at",
    `${originalTask.repo} itself (an absolute path, not your own working directory). You've been granted explicit`,
    `access to that path (--add-dir) specifically so this works — use Bash with that absolute path — e.g.`,
    "`git -C " + originalTask.repo + " status`, `git -C " + originalTask.repo + " diff`, editing files" +
      ` by their full path under ${originalTask.repo} — to actually inspect and resolve the conflict there. Do not`,
    "trust or edit your own working directory's copy of the file; it reflects a different, unrelated commit.",
    "",
    "Real git conflict output:",
    "```",
    conflictMessage,
    "```",
    "",
    "The common case for a conflict here is two features additively touching the same section or file — both",
    "sides added real content, nothing contradictory. If that's what this is, resolve it directly in",
    `${originalTask.repo}'s own working tree by combining both sides faithfully: keep everything either side`,
    "added, drop nothing from either, then `git add`/`git commit` there to finish the merge.",
    "",
    "But if this looks like a genuine semantic contradiction instead — not just two additions near each other,",
    "but two changes that actually disagree about what the code should do — stop. Leave the conflict exactly as",
    "found. Never guess, and never silently pick one side and discard the other. Report what you found and why",
    "it isn't safely combinable; a human will resolve it from there.",
  ].join("\n");
}

/**
 * Resolves the candidate allowlist a follow-up task is restricted to:
 * its parent's routed agent's declared `handoffs`, if the parent exists
 * and is itself routed. Undefined means unrestricted — no parent, an
 * unrouted parent, or a parent whose agent never declared a handoff
 * graph at all all mean "the whole registry is eligible." A parent
 * agent that declared `handoffs: []` returns that empty array as-is —
 * a deliberate "hands off to no one," not the same as no restriction.
 *
 * A parent whose `outputContractFormat` is `"subtask-plan"` (today, only
 * the planner) is a separate, deliberate exception: its children (see
 * spawnSubtasksFromPlan) and any auto-integrator follow-up spawned under
 * them (see maybeSpawnIntegrator) carry `parentTaskId` purely for
 * grouping/dependency tracking — visibility and `dependsOn` chaining, not
 * a real handoff relationship. The planner's own decomposition can, by
 * design, route a subtask's `labels` to *any* agent in the registry
 * (fixer, integrator, pr-description-writer, ...), not just a fixed
 * graph declared in advance — restricting to a `handoffs` list here would
 * silently strand any subtask whose labels target an agent the planner
 * never happened to list, exactly the bug caught live against the real
 * registry/router (see test/orchestrator.test.ts's sweep()-driven
 * planner test).
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
  if (!parentAgent) return undefined;
  if (parentAgent.outputContractFormat === "subtask-plan") return undefined;
  if (parentAgent.handoffs === undefined) return undefined;
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
  // A pipeline step's parentTaskId is its run's root card: run grouping,
  // not subtask decomposition. pipeline-runner.ts settles the run itself;
  // integrating it spawned a bogus "Integrate: Pipeline: ..." card once
  // every step was done (seen live 2026-10-07, "AI news podcast").
  if (task.pipelineId !== undefined) return;

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
  /** Tasks held because no harness is available for them, and the reason
   *  last logged. Used only to log once per task (per reason), not on
   *  every sweep. */
  private waitingForHarness = new Map<string, string>();

  constructor(
    private board: Board & { events: EventEmitter },
    private registry: Registry,
    private router: Router,
    private executors: Executor[],
    private telemetry?: TelemetryLog,
    private opts: OrchestratorOptions = {},
  ) {}

  private started = false;
  private onBoardEvent = () => void this.sweep();
  /** The one pending wake-up for the earliest future `retryAfter` (a card
   *  rescheduled after a 429). Board events alone never fire when a retry
   *  time passes, so on a quiet board a rate-limited card waited until
   *  some unrelated event or a restart (seen 2026-10-09: card d3f87348
   *  sat ~2h past its retry time). */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimerAt: number | undefined;

  /** Runs an initial sweep, then re-sweeps on every board event that could
   *  make a previously-blocked task eligible, and when the earliest
   *  scheduled retry comes due. */
  start(): void {
    this.started = true;
    this.board.events.on("event", this.onBoardEvent);
    void this.sweep();
  }

  /** Stops reacting to board events and cancels the retry wake-up. */
  stop(): void {
    this.started = false;
    this.board.events.off("event", this.onBoardEvent);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryTimerAt = undefined;
  }

  /** Arms (or moves earlier) a single timer for the earliest future
   *  retryAfter among unrouted inbox/ready cards. Only while started, so
   *  a test calling sweep() directly never leaves a timer behind. */
  private scheduleRetryWake(tasks: TaskCard[]): void {
    if (!this.started) return;
    const now = Date.now();
    let earliest: number | undefined;
    for (const t of tasks) {
      if (!t.retryAfter || t.routedTo || t.archivedAt || (t.status !== "inbox" && t.status !== "ready")) continue;
      const at = new Date(t.retryAfter).getTime();
      if (Number.isNaN(at) || at <= now) continue;
      if (earliest === undefined || at < earliest) earliest = at;
    }
    if (earliest === undefined) return;
    if (this.retryTimer && this.retryTimerAt !== undefined && this.retryTimerAt <= earliest) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerAt = earliest;
    // +1s so the retry time has definitely passed when the sweep reads it.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryTimerAt = undefined;
      void this.sweep();
    }, Math.min(earliest - now + 1000, 2 ** 31 - 1));
    this.retryTimer.unref?.();
  }

  /** Processes every currently-eligible task once, and doesn't resolve
   *  until all of them have finished — callers (including tests) can rely
   *  on `await sweep()` meaning "this round is done," not just "started."
   *  Public so it can also be triggered manually (a future `wissel tick`). */
  async sweep(): Promise<void> {
    const tasks = await this.board.list();
    const byId = new Map(tasks.map((t) => [t.id, t]));
    this.scheduleRetryWake(tasks);
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
      // pipeline-runner.ts owns every card in a run (root and steps) and
      // picks each step's agent from the definition, never the Router.
      // Without this, the board event from creating a card triggered a
      // sweep that routed it before the runner moved it to "running":
      // labels [] matched nothing and the card went to no-match (seen
      // live 2026-10-07 on the first "AI news podcast" run; the root,
      // which stays in inbox, hit it every time).
      if (task.pipelineId !== undefined) continue;
      // Archived means put away by a human: never routed or run, even if
      // it was archived while still in inbox (seen 2026-10-09: an
      // archived stray integrator card was re-routed on every sweep).
      if (task.archivedAt) continue;

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

      // Defense in depth alongside POST /tasks' own synchronous check
      // (src/api/server.ts): that check only catches a *confident*
      // routing decision at creation time, so a task created with
      // ambiguous/no-match labels and no repo could still land here
      // later with a real write/bash-capable agent after a label edit.
      // Without this, a repo-less task would reach WriteExecutor/
      // CodexWriteExecutor's createTaskWorktree(task.repo!, ...) with
      // `undefined` for `repo` — never a crash (JS has no runtime type
      // enforcement), but a silently wrong `git worktree add` run
      // against whatever the server process's own cwd happens to be.
      if ((agent.toolAccess.includes("write") || agent.toolAccess.includes("bash")) && !task.repo) {
        console.error(`orchestrator: task ${task.id} routed to "${agent.id}" (file/bash access) but has no repo`);
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

      // Nothing acquire() would pick right now: hold the task, don't run
      // it. Covers a disabled harness (before this check the executor ran
      // with no harness on ambient credentials, e.g. ANTHROPIC_API_KEY
      // from .env), every harness at its maxConcurrent, and an agent whose
      // own `harnesses` list has nothing available (it waits; it never
      // moves to a harness it didn't list). Returning before
      // recordDecision leaves the task unrouted in its column, so the next
      // sweep retries it: the harness enable endpoint triggers one, and a
      // finishing run frees capacity and moves its own task, whose board
      // event triggers one. An explicit harnessOverride is excluded:
      // acquire() fails it loud below.
      if (executor?.harnessTool && this.opts.harnesses && !task.harnessOverride && !this.opts.harnesses.canAcquire(executor.harnessTool, agent.harnesses)) {
        const reason = agent.harnesses?.length
          ? `none of [${agent.harnesses.join(", ")}] enabled and under capacity`
          : this.opts.harnesses.all().some((h) => h.enabled && h.tool === executor.harnessTool)
            ? `every enabled ${executor.harnessTool} harness at capacity`
            : `no enabled ${executor.harnessTool} harness`;
        if (this.waitingForHarness.get(task.id) !== reason) {
          this.waitingForHarness.set(task.id, reason);
          console.log(`orchestrator: task ${task.id} (${agent.id}) waiting: ${reason}`);
        }
        return;
      }
      this.waitingForHarness.delete(task.id);

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
      // wissel's behavior before harnesses existed. Passing
      // task.harnessOverride through as the forced pick means a mismatch
      // between the override and the agent's own routed executor tool
      // (executor!.harnessTool) surfaces as the same tool-mismatch
      // HarnessOverrideError acquire() throws for any other bad override.
      // That path only fires when executor!.harnessTool and
      // this.opts.harnesses are both truthy, though — harnessTool is
      // optional on Executor and a pool isn't guaranteed configured, so
      // an explicit override with either one missing is checked here
      // instead of falling through to a silent `undefined` harness,
      // which would contradict "fail loud on an unresolvable override."
      if (task.harnessOverride && (!executor!.harnessTool || !this.opts.harnesses)) {
        const reason = !executor!.harnessTool
          ? `agent "${agent.id}" runs on an executor with no harness tool`
          : "no harness pool is configured";
        const result: TaskResult = {
          taskId: task.id,
          agentId: agent.id,
          ok: false,
          summary: `harness override '${task.harnessOverride}' can't be honored: ${reason}`,
        };
        await finishResult(this.board, this.registry, result, this.telemetry, undefined, this.opts.memoryPath);
        return;
      }

      let harness: Harness | undefined;
      try {
        harness = executor!.harnessTool ? this.opts.harnesses?.acquire(executor!.harnessTool, task.harnessOverride, agent.harnesses) : undefined;
      } catch (e) {
        if (!(e instanceof HarnessOverrideError)) throw e;
        const result: TaskResult = {
          taskId: task.id,
          agentId: agent.id,
          ok: false,
          summary: `harness override '${task.harnessOverride}' can't be honored: ${e.message}`,
        };
        await finishResult(this.board, this.registry, result, this.telemetry, undefined, this.opts.memoryPath);
        return;
      }
      // What the check above saw as available is gone by now
      // (recordDecision/telemetry awaited in between): the last harness
      // was disabled, or another task in the same sweep took its last
      // slot under maxConcurrent. Same rule: don't run without one. resetToInbox clears routedTo, and the
      // sweep its event triggers holds the task at the check above
      // without emitting another event, so this can't loop.
      if (executor!.harnessTool && this.opts.harnesses && !harness) {
        await this.board.resetToInbox(task.id);
        return;
      }
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
