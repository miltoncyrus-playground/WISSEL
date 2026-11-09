/**
 * Review policy (docs/SDD-coordinator.md §4.6): what a review verdict
 * means for a card. Pure: the evaluator reads the structured verdict
 * (its `findings`, never the feedback prose) against the project's
 * `reviewPolicy` and says pass, fix round or at-cap; the fix-round
 * builder renders the project's `fix-round` template from the FULL
 * review text and refuses an empty one. Nothing here reads the store,
 * creates a card or merges anything; the delivery cards wire the loop.
 * The review guard (`WISSEL_REVIEW_GUARD`, src/core/orchestrator.ts)
 * sits in front of this: a rework that changed nothing never reaches a
 * verdict to evaluate.
 */

import type { Project, ReviewBlock, ReviewFinding, ReviewPolicy, ReviewSeverity, ReviewTier, ReviewVerdict } from "../core/types.ts";
import { renderCardTemplateFor, type RenderedTemplate } from "./card-templates.ts";

export const REVIEW_BLOCKS: readonly ReviewBlock[] = ["HIGH", "MED", "MED-with-scenario"];
export const CARRY_FORWARD: readonly ReviewPolicy["carryForward"][] = ["ticket", "card", "drop"];
export const AT_CAP: readonly ReviewPolicy["atCap"][] = ["ask-decider", "spec-question", "accept"];
export const REVIEWER_MODES: readonly ReviewTier["reviewers"][number]["mode"][] = ["standard", "adversarial"];
export const MAX_REVIEW_TIERS = 10;
export const MAX_REVIEW_ROUNDS = 20;

export type ReviewOutcome =
  /** Nothing blocks; `carried` are the findings to carry forward (empty when the policy drops them). */
  | { kind: "pass"; carryForward: ReviewPolicy["carryForward"]; carried: ReviewFinding[] }
  /** Blocked under the cap: start fix round `round` of `maxRounds`. */
  | { kind: "fix-round"; round: number; maxRounds: number; blocking: ReviewFinding[]; carryForward: ReviewPolicy["carryForward"]; carried: ReviewFinding[] }
  /** Blocked at the cap: `atCap` decides what happens next. */
  | { kind: "at-cap"; atCap: ReviewPolicy["atCap"]; maxRounds: number; blocking: ReviewFinding[] };

/** How many findings of each severity the verdict lists. */
export function severityCounts(verdict: ReviewVerdict): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { HIGH: 0, MED: 0, LOW: 0 };
  for (const f of verdict.findings ?? []) counts[f.severity] += 1;
  return counts;
}

/** Whether one finding stops a merge under `blocks`. */
export function findingBlocks(finding: ReviewFinding, blocks: readonly ReviewBlock[]): boolean {
  if (finding.severity === "HIGH") return blocks.includes("HIGH");
  if (finding.severity === "MED") return blocks.includes("MED") || (finding.scenario && blocks.includes("MED-with-scenario"));
  return false;
}

/** The tier the card named, else the policy's first tier. */
export function tierFor(policy: ReviewPolicy, tierId: string | undefined): ReviewTier {
  return policy.tiers.find((t) => t.id === tierId) ?? policy.tiers[0]!;
}

/**
 * Evaluates a verdict for a card on `round` (its attempt within the
 * lineage, counting from 1; 0 or undefined for a card that has had no
 * round yet). The policy decides from `findings`: a verdict that lists
 * them blocks only where one of them matches `blocks`, whatever word the
 * reviewer chose. A `changes_requested` with no findings (the contract
 * before findings existed) blocks on the reviewer's word alone. Blocked
 * under the tier's `maxRounds` is a fix round; at or past it, `atCap`.
 */
export function evaluateReviewVerdict(policy: ReviewPolicy, tierId: string | undefined, verdict: ReviewVerdict, round: number | undefined): ReviewOutcome {
  const findings = verdict.findings ?? [];
  const blocking = findings.filter((f) => findingBlocks(f, policy.blocks));
  const blocked = blocking.length > 0 || (findings.length === 0 && verdict.verdict === "changes_requested");
  const carried = policy.carryForward === "drop" ? [] : findings.filter((f) => !blocking.includes(f));
  if (!blocked) return { kind: "pass", carryForward: policy.carryForward, carried };

  const { maxRounds } = tierFor(policy, tierId);
  const current = round ?? 0;
  if (current >= maxRounds) return { kind: "at-cap", atCap: policy.atCap, maxRounds, blocking };
  return { kind: "fix-round", round: current + 1, maxRounds, blocking, carryForward: policy.carryForward, carried };
}

/** The whole review as text for a fix card: the full feedback, then one
 *  line per finding. Never an excerpt. */
export function reviewTextOf(verdict: ReviewVerdict): string {
  const feedback = verdict.feedback.trim();
  const findings = (verdict.findings ?? []).map((f) => `- ${f.severity}: ${f.title}${f.scenario ? " (scenario given)" : ""}`);
  return findings.length === 0 ? feedback : `${feedback}\n\nFindings:\n${findings.join("\n")}`.trim();
}

export interface FixRoundInput {
  /** The round the fix card is for (ReviewOutcome.round). */
  round: number;
  /** The full review text (reviewTextOf), never an excerpt. */
  review: string;
  key?: string;
  ticket?: string;
  files?: string;
}

/**
 * The body of a fix-round card: the project's `fix-round` template with
 * `{round}`, `{review}`, `{key}`, `{ticket}` and `{files}`, plus its
 * `cardRules`. Refuses an empty review outright, before any template
 * is consulted, and otherwise whatever renderCardTemplateFor refuses
 * (no template, over the size limit). `key`, `ticket` and `files` may be
 * empty; the review and the round never are.
 */
export function buildFixRoundBody(project: Pick<Project, "cardRules" | "cardTemplates">, input: FixRoundInput): RenderedTemplate {
  if (typeof input.review !== "string" || input.review.trim() === "") {
    return { ok: false, error: "review text is empty; a fix round is never started from an empty review" };
  }
  const vars = { round: String(input.round), review: input.review.trim(), key: input.key, ticket: input.ticket, files: input.files };
  return renderCardTemplateFor(project, "fix-round", vars, { optional: ["key", "ticket", "files"] });
}

/** Why one `reviewPolicy` value is refused, or undefined when acceptable. */
export function reviewPolicyError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "reviewPolicy must be an object { tiers, blocks, carryForward, atCap }, or null to clear it";
  const { tiers, blocks, carryForward, atCap } = value as Record<string, unknown>;
  if (!Array.isArray(tiers) || tiers.length === 0) return "reviewPolicy.tiers must list at least one tier";
  if (tiers.length > MAX_REVIEW_TIERS) return `reviewPolicy.tiers has ${tiers.length} tiers; at most ${MAX_REVIEW_TIERS}`;
  const ids = new Set<string>();
  for (const [i, tier] of tiers.entries()) {
    const error = tierError(tier, `reviewPolicy.tiers[${i}]`);
    if (error) return error;
    const id = (tier as ReviewTier).id;
    if (ids.has(id)) return `reviewPolicy.tiers: duplicate tier id "${id}"`;
    ids.add(id);
  }
  if (!Array.isArray(blocks) || blocks.some((b) => !(REVIEW_BLOCKS as readonly unknown[]).includes(b))) return `reviewPolicy.blocks must be a list of any of: ${REVIEW_BLOCKS.join(", ")}`;
  if (!(CARRY_FORWARD as readonly unknown[]).includes(carryForward)) return `reviewPolicy.carryForward must be one of: ${CARRY_FORWARD.join(", ")}`;
  if (!(AT_CAP as readonly unknown[]).includes(atCap)) return `reviewPolicy.atCap must be one of: ${AT_CAP.join(", ")}`;
  return undefined;
}

function tierError(tier: unknown, at: string): string | undefined {
  if (typeof tier !== "object" || tier === null || Array.isArray(tier)) return `${at} must be an object { id, when, reviewers, maxRounds }`;
  const { id, when, reviewers, maxRounds } = tier as Record<string, unknown>;
  if (typeof id !== "string" || id.trim() === "") return `${at}.id must be a non-empty string`;
  if (typeof when !== "string") return `${at}.when must be a string`;
  if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1 || (maxRounds as number) > MAX_REVIEW_ROUNDS) return `${at}.maxRounds must be an integer from 1 to ${MAX_REVIEW_ROUNDS}`;
  if (!Array.isArray(reviewers) || reviewers.length === 0) return `${at}.reviewers must list at least one reviewer`;
  for (const [j, r] of reviewers.entries()) {
    if (typeof r !== "object" || r === null) return `${at}.reviewers[${j}] must be an object { model, mode }`;
    const { model, mode } = r as Record<string, unknown>;
    if (typeof model !== "string" || model.trim() === "") return `${at}.reviewers[${j}].model must be "other-than-coder" or a model id`;
    if (!(REVIEWER_MODES as readonly unknown[]).includes(mode)) return `${at}.reviewers[${j}].mode must be one of: ${REVIEWER_MODES.join(", ")}`;
  }
  return undefined;
}
