// Review tiers, reviewer panels, carry-forward and keeping a PASS
// (docs/SDD-coordinator.md §4.6, coordinator card 8b). Pure: the
// orchestrator decides when, this decides what.
import type { ReviewPolicy, ReviewSeverity, ReviewTier, ReviewerSpec, TaskCard, TaskResult } from "../core/types.ts";

/** The card's tier: its own `review.tier` when the policy has that tier,
 *  else the first tier whose `when` matches, else none (one reviewer, as
 *  before). A tier the card names that the policy lacks matches nothing,
 *  so the card falls back to `when`. */
export function tierFor(policy: ReviewPolicy | undefined, card: Pick<TaskCard, "labels" | "files" | "review">): ReviewTier | undefined {
  const tiers = policy?.tiers ?? [];
  const named = card.review?.tier ? tiers.find((t) => t.id === card.review!.tier) : undefined;
  if (named) return named;
  return tiers.find((t) => tierMatches(t.when, card));
}

export function tierMatches(when: string | undefined, card: Pick<TaskCard, "labels" | "files">): boolean {
  if (!when) return false;
  if (when === "always") return true;
  if (when.startsWith("label:")) return card.labels.includes(when.slice("label:".length));
  const files = /^files>=(\d+)$/.exec(when);
  if (files) return (card.files?.length ?? 0) >= Number(files[1]);
  return false;
}

/** The model a reviewer runs on, and a note when "other-than-coder"
 *  could not be honoured. */
export function reviewerModel(spec: ReviewerSpec, coderModel: string | undefined, otherModels: string[] | undefined): { model?: string; note?: string } {
  if (spec.model !== "other-than-coder") return { model: spec.model };
  const other = (otherModels ?? []).find((m) => m !== coderModel);
  if (other) return { model: other };
  return {
    note: otherModels?.length
      ? `The policy asks for a model other than the coder's (${coderModel ?? "unknown"}), and every model in otherModels is that one: this review runs on the reviewer's own model.`
      : "The policy asks for a model other than the coder's, but names no otherModels: this review runs on the reviewer's own model.",
  };
}

export const ADVERSARIAL_BRIEF =
  "Review this adversarially. Assume the change is wrong until you find otherwise: look for the input, state or sequence that breaks it, and for what it claims but does not do. Report each problem with the failing scenario. Approve only when you looked for those and found none.";

/** The review card's body for one reviewer of a tier. */
export function reviewerBody(base: string, spec: ReviewerSpec, note: string | undefined, seat: { index: number; of: number }): string {
  const parts = [base];
  if (seat.of > 1) parts.push(`---\nYou are reviewer ${seat.index} of ${seat.of} on this change. Review it on your own; the verdicts are combined.`);
  if (spec.mode === "adversarial") parts.push(`---\n${ADVERSARIAL_BRIEF}`);
  if (note) parts.push(`---\n${note}`);
  return parts.join("\n\n");
}

/** One panel verdict from its reviewers' results: approve only when all
 *  approve; the feedback of each, under its reviewer's name, in full;
 *  severity counts summed; grants joined. */
export function combineVerdicts(results: { label: string; result: TaskResult }[]): Pick<TaskResult, "verdict" | "reviewFeedback" | "reviewSeverity" | "reviewGrants" | "summary"> {
  const verdict = results.every((r) => r.result.verdict === "approve") ? "approve" : "changes_requested";
  const feedback = results
    .filter((r) => r.result.reviewFeedback?.trim())
    .map((r) => `### ${r.label} (${r.result.verdict === "approve" ? "approved" : "changes requested"})\n\n${r.result.reviewFeedback!.trim()}`)
    .join("\n\n");
  const counted = results.map((r) => r.result.reviewSeverity).filter((s): s is ReviewSeverity => !!s);
  const severity: ReviewSeverity | undefined = counted.length
    ? {
        high: counted.reduce((n, s) => n + s.high, 0),
        med: counted.reduce((n, s) => n + s.med, 0),
        medWithScenario: counted.reduce((n, s) => n + (s.medWithScenario ?? 0), 0),
        low: counted.reduce((n, s) => n + (s.low ?? 0), 0),
      }
    : undefined;
  const grants = [...new Set(results.flatMap((r) => r.result.reviewGrants ?? []))];
  return {
    verdict,
    ...(feedback ? { reviewFeedback: feedback } : {}),
    ...(severity ? { reviewSeverity: severity } : {}),
    ...(grants.length ? { reviewGrants: grants } : {}),
    summary: results.map((r) => `${r.label}: ${r.result.summary.trim() || r.result.verdict || "no verdict"}`).join("\n"),
  };
}

/** A passing review's findings worth carrying forward: there is feedback
 *  text and it isn't only "no findings". */
export function carryForwardText(result: Pick<TaskResult, "verdict" | "reviewFeedback" | "reviewSeverity">): string | undefined {
  if (result.verdict !== "approve") return undefined;
  const text = result.reviewFeedback?.trim();
  if (!text) return undefined;
  const s = result.reviewSeverity;
  if (s && s.high + s.med + (s.low ?? 0) === 0) return undefined;
  return text;
}

export function isTextFile(path: string): boolean {
  return /\.(md|mdx|txt|rst|adoc)$/i.test(path) || path.startsWith("docs/") || /(^|\/)(README|CHANGELOG|LICENSE|NOTICE)(\.[a-z]+)?$/i.test(path);
}

export function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|e2e|__tests__)\//.test(path) || /\.(test|spec)\.[a-z0-9]+$/i.test(path);
}

/** Whether a change to `files` after a PASS keeps it under the policy's
 *  keepPass. No files (a clean merge) always keeps it. */
export function keepsPass(files: string[], keepPass: ReviewPolicy["keepPass"]): boolean {
  if (files.length === 0) return true;
  const kinds = keepPass ?? [];
  return files.every((f) => (kinds.includes("text") && isTextFile(f)) || (kinds.includes("test") && isTestFile(f)));
}
