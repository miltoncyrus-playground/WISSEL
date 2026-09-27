import type { PipelineGraph } from "./types.ts";
import { REVIEW_HANDOFF_PUSHBACK_LIMIT } from "./review-handoff-pipeline.ts";

/**
 * Extends `review-handoff-pipeline.ts`'s recreated loop with the one
 * other piece of Wissel's real day-to-day flow that a static
 * step/edge graph CAN represent: intake. A real card doesn't start at
 * "implementer" — it starts as raw input that `triager`
 * (agents/manifest.yaml) turns into a structured card before anything
 * else touches it (`handoffs: [planner]` in the manifest, though this
 * graph routes straight to the implementer/reviewer loop instead — see
 * below for why `planner` itself isn't included).
 *
 * Deliberately does NOT include `planner` or `integrator`, and this is
 * a real architectural limit, not an oversight:
 *
 * - `planner`'s whole job is producing a *variable* number of subtask
 *   cards at runtime (`SubtaskPlanItem[]`, parsed by `parseSubtaskPlan`
 *   and turned into real `board.create()` calls by
 *   `spawnSubtasksFromPlan`, src/core/orchestrator.ts). A
 *   `PipelineStepDef`'s outgoing edges (src/core/types.ts) are fixed at
 *   authoring time — there is no way to express "however many steps the
 *   agent decides to create" in this graph model at all. See
 *   docs/SDD-pipelines.md §3.3: migrating `planner` onto this engine is
 *   an explicit, separate, later phase, not something this pipeline can
 *   fake by bolting on a fixed-arity step.
 * - `integrator` (`wireAutoIntegrator`/`maybeSpawnIntegrator`,
 *   src/core/orchestrator.ts) only ever runs today when every sibling
 *   subtask under a *planner-created* parent has independently reached a
 *   terminal state — it is triggered by, and only makes sense downstream
 *   of, that same dynamic fan-out. Adding an "integrate" step directly
 *   after a single implementer/reviewer approve here would not
 *   reproduce real behavior; today an approve auto-merges deterministically
 *   (`finishResult`'s `autoMerge` branch, no agent call at all) — there is
 *   nothing to model, and the honest thing is to leave the "approved"
 *   terminal exactly as it already is.
 *
 * So this graph is precisely: triage -> [review-handoff-pipeline.ts's
 * unrolled implementer/reviewer loop], unchanged from `buildReviewHandoffPipelineGraph`
 * in every other respect (same step ids, same agents, same cap, same
 * terminals) — proof the two builders can share the loop without
 * duplicating its logic, not a rewrite of it.
 */
export const FULL_LIFECYCLE_PIPELINE_NAME = "Full Task Lifecycle";
export const FULL_LIFECYCLE_PIPELINE_DESCRIPTION =
  "Triage -> implementer -> reviewer (pushback up to 5x) -> approve/escalate, " +
  "as a real, inspectable PipelineDef — review-handoff-pipeline.ts's loop " +
  "with a triager entry step in front of it, matching how a real card " +
  "actually starts in Wissel today. Deliberately excludes `planner` and " +
  "`integrator`: both are tied to a dynamic, runtime-decided number of " +
  "subtask cards that a fixed step/edge graph can't express. See this " +
  "file's own doc comment and docs/SDD-pipelines.md §3.3/§10.";

export function buildFullLifecyclePipelineGraph(): PipelineGraph {
  const steps: PipelineGraph["steps"] = [];
  const edges: PipelineGraph["edges"] = [];

  const ATTEMPTS = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1; // 6 — same cap as review-handoff-pipeline.ts, kept in lockstep via the shared constant

  steps.push({
    id: "triage",
    name: "Triager — turn raw input into a structured task card",
    agentId: "triager",
    // "all", not "choose": triager (agents/manifest.yaml) has no
    // pipeline-handoff outputContract, and never should — it's also
    // used unchanged by the real (non-pipeline) intake path, exactly
    // the same reasoning review-handoff-pipeline.ts already applies to
    // `implementer`'s own steps below. A single outgoing edge with no
    // `next` needed means triager's own success/failure is all that
    // gates progress to the implementer loop.
    transition: "all",
  });
  edges.push({ id: "e-triage-impl1", from: "triage", to: "impl-1" });

  for (let n = 1; n <= ATTEMPTS; n++) {
    const isLast = n === ATTEMPTS;

    steps.push({
      id: `impl-${n}`,
      name: `Implementer (attempt ${n} of ${ATTEMPTS})`,
      agentId: "implementer",
      transition: "all",
    });

    steps.push({
      id: `rev-${n}`,
      name: isLast
        ? `Reviewer (attempt ${n} of ${ATTEMPTS} — FINAL attempt: if changes are still needed, you MUST respond next: "escalate", not "retry" — there is no retry step left)`
        : `Reviewer (attempt ${n} of ${ATTEMPTS} — retry is available if you request changes)`,
      agentId: "pipeline-reviewer",
      transition: "choose",
    });

    edges.push({ id: `e-impl${n}-rev${n}`, from: `impl-${n}`, to: `rev-${n}` });
    edges.push({ id: `e-rev${n}-approve`, from: `rev-${n}`, to: "approved", label: "approve" });

    if (isLast) {
      edges.push({ id: `e-rev${n}-escalate`, from: `rev-${n}`, to: "escalated", label: "escalate" });
    } else {
      edges.push({ id: `e-rev${n}-retry`, from: `rev-${n}`, to: `impl-${n + 1}`, label: "retry" });
    }
  }

  // Same shared-terminal precedent as review-handoff-pipeline.ts: only one
  // reviewer pass per run will ever actually resolve to "approve" (a step
  // task, once created for a given pipelineRunId, is never re-created —
  // see handlePipelineStepResult's idempotent-activation guard), and
  // "quick-answer" is reused rather than adding two near-duplicate
  // "just say something" agents for a purely cosmetic final step.
  steps.push({ id: "approved", name: "Approved — write a one-sentence completion note", agentId: "quick-answer", transition: "all" });
  steps.push({
    id: "escalated",
    name: `Escalated after ${ATTEMPTS} rejected attempts — write a one-sentence handoff note for the human who will pick this up`,
    agentId: "quick-answer",
    transition: "all",
  });

  return { steps, edges };
}
