import type { PipelineGraph } from "./types.ts";

/**
 * Recreates Wissel's existing hardcoded review-handoff loop
 * (finishResult's `handoffs.includes("reviewer")` branch ->
 * spawnReviewerTask -> handleReviewVerdict -> spawnPushbackImplementer /
 * buildEscalationContext, all in src/core/orchestrator.ts — none of it
 * touched by this file) as a real PipelineGraph that runs on the generic
 * engine in pipeline-runner.ts. See docs/SDD-pipelines.md §6 Subtask 5
 * for the full point-by-point comparison against the legacy loop's real
 * behavior — this graph reproduces the loop's *shape* (attempt cap,
 * retry-vs-escalate branching), not every one of its behaviors; the
 * comparison section names exactly which parts carry over and which
 * don't.
 *
 * PUSHBACK_LIMIT mirrors handleReviewVerdict's own check
 * (`implementerTask.pushbackCount >= 5`, evaluated on the rejected
 * attempt *before* incrementing) exactly: escalation happens on the 6th
 * rejected implementer attempt — the 1st attempt plus up to 5 pushback
 * re-attempts. If that legacy cap ever changes, this constant must
 * change with it for the two systems to stay comparable.
 *
 * A generic step/edge graph can't express "loop back to the same step N
 * more times, where N is decided at runtime" at all — pipeline-runner.ts's
 * own `startPipelineRun` defines an entry step as one with zero incoming
 * edges, and a literal cycle (any step "retry"-ing back to an earlier
 * step in the same cycle, including back to itself) means EVERY step in
 * that cycle has an incoming edge from somewhere in the cycle, so there
 * is no entry step at all — the run fails immediately, before a single
 * step ever executes, not after one bad retry. See the "a literal cycle
 * has no entry point at all" test in test/review-handoff-pipeline.test.ts,
 * which proves this concretely (a real 2-step impl/rev cycle, zero claude
 * calls made) rather than just asserting it. So the bounded 6-attempt
 * loop is unrolled here into ATTEMPTS distinct implementer/reviewer
 * step-id pairs instead of a real cycle. This faithfully encodes a
 * *known, fixed* bound — but, unlike handleReviewVerdict's runtime
 * pushbackCount check, can't generalize to a bound decided dynamically.
 * Worth reconsidering in a future revision of docs/SDD-pipelines.md §3 if
 * the engine ever needs an open-ended retry loop.
 */
export const REVIEW_HANDOFF_PUSHBACK_LIMIT = 5;
const ATTEMPTS = REVIEW_HANDOFF_PUSHBACK_LIMIT + 1; // 6 — matches handleReviewVerdict's own cap exactly

export const REVIEW_HANDOFF_PIPELINE_NAME = "Review-Handoff Loop";
export const REVIEW_HANDOFF_PIPELINE_DESCRIPTION =
  'Recreates the hardcoded implementer -> reviewer -> pushback (up to 5x) -> escalate loop ' +
  "(src/core/orchestrator.ts's finishResult/handleReviewVerdict) as a real, inspectable PipelineDef. " +
  "See docs/SDD-pipelines.md §6 Subtask 5.";

/**
 * Builds the review-handoff loop's graph fresh every call — pure, no I/O,
 * no shared mutable state — so a test or a caller seeding a stored
 * PipelineDef (`pipelines.create({ name: REVIEW_HANDOFF_PIPELINE_NAME,
 * ... graph: buildReviewHandoffPipelineGraph() })`) always gets an
 * independent object it's safe to mutate or serialize.
 */
export function buildReviewHandoffPipelineGraph(): PipelineGraph {
  const steps: PipelineGraph["steps"] = [];
  const edges: PipelineGraph["edges"] = [];

  for (let n = 1; n <= ATTEMPTS; n++) {
    const isLast = n === ATTEMPTS;

    steps.push({
      id: `impl-${n}`,
      name: `Implementer (attempt ${n} of ${ATTEMPTS})`,
      agentId: "implementer",
      // "all", not "choose": the real, unmodified `implementer` agent
      // (agents/manifest.yaml) has no pipeline-handoff outputContract,
      // deliberately — giving it one would force EVERY implementer run
      // anywhere, including every ordinary (non-pipeline) run through
      // the legacy hardcoded loop that shares this exact agent id,
      // through pipeline-handoff parsing, failing every one of them for
      // never emitting a block they were never told to produce. "all"
      // needs no `next` at all: it activates its one outgoing edge
      // unconditionally, off nothing but the implementer's plain
      // success/failure — see docs/SDD-pipelines.md's Subtask 5
      // comparison section.
      transition: "all",
    });

    steps.push({
      id: `rev-${n}`,
      // The attempt number and retry-availability are baked into the
      // step's own `name` (which becomes part of the step task's title —
      // see runStepAndSuccessors, pipeline-runner.ts, and buildAgentPrompt,
      // src/core/prompt.ts, which renders `Task: ${task.title}`) because
      // the SAME generic `pipeline-reviewer` agent (agents/manifest.yaml)
      // is bound to every one of these 6 review steps — the only way a
      // shared, static agent definition can behave differently on the
      // final attempt than on an earlier one is to tell it apart via the
      // one thing that legitimately varies per step instance: the task
      // text itself. This is also the one genuine behavioral difference
      // from the legacy loop worth flagging: handleReviewVerdict's
      // retry-vs-escalate decision is deterministic code
      // (`pushbackCount >= 5`), never something the reviewer itself
      // decides; here, the reviewer's own choice of "retry" vs "escalate"
      // is what the graph resolves against, informed only by this prompt
      // text. See docs/SDD-pipelines.md's Subtask 5 comparison section.
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

  // Two shared terminal steps, one per outcome — every reviewer step's
  // "approve" edge points at the same "approved" step id (harmless: only
  // one reviewer pass per run will ever actually resolve to "approve",
  // since a step task, once created for a given pipelineRunId, is never
  // re-created — see handlePipelineStepResult's own idempotent-activation
  // guard). Bound to `quick-answer` (agents/manifest.yaml, already
  // shipped, executor: api, no tool/repo access) rather than a new agent:
  // a terminal step here only needs to produce a short human-readable
  // acknowledgment from whatever context the run handed it — reusing an
  // existing, cheap, read-nothing skill for that avoids adding two
  // near-duplicate "just say something" agents for a purely cosmetic
  // final step. Its own summary text is otherwise unused: pipeline-runner
  // only reads whether it succeeded.
  steps.push({ id: "approved", name: "Approved — write a one-sentence completion note", agentId: "quick-answer", transition: "all" });
  steps.push({
    id: "escalated",
    name: `Escalated after ${ATTEMPTS} rejected attempts — write a one-sentence handoff note for the human who will pick this up`,
    agentId: "quick-answer",
    transition: "all",
  });

  return { steps, edges };
}
