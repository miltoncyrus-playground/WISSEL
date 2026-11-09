import type { ReviewFinding, ReviewSeverity, ReviewVerdict } from "../core/types.ts";
import { lastFencedBlock } from "./fenced-block.ts";

const VALID_VERDICTS = new Set<ReviewVerdict["verdict"]>(["approve", "changes_requested"]);
const SEVERITIES: readonly ReviewSeverity[] = ["HIGH", "MED", "LOW"];

/** One `findings` entry, or null when it isn't one: an object with a
 *  known severity (any case) and a non-blank title. `scenario` is a
 *  boolean, false when absent. */
function parseFinding(entry: unknown): ReviewFinding | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const { severity, title, scenario } = entry as Record<string, unknown>;
  const level = typeof severity === "string" ? severity.trim().toUpperCase() : "";
  if (!(SEVERITIES as readonly string[]).includes(level)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  return { severity: level as ReviewSeverity, title: title.trim(), scenario: scenario === true };
}

/**
 * The only code allowed to turn raw claude output into a ReviewVerdict.
 * Strict on purpose: malformed, missing, or ambiguous input returns
 * null — it never guesses "approve" as a safe default, because a
 * silently-approved review is worse than a loudly-failed one.
 */
export function parseReviewVerdict(rawOutput: string): ReviewVerdict | null {
  // The contract requires the final message to *end with* the block, but
  // the raw text is whatever claude printed, prose and all; and feedback
  // may quote fences of its own. See lastFencedBlock.
  const body = lastFencedBlock(rawOutput, "review-verdict")?.trim();
  if (body === undefined) return null;

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { verdict, feedback, grants, findings } = candidate as Record<string, unknown>;

  if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict as ReviewVerdict["verdict"])) return null;
  if (typeof feedback !== "string") return null;

  // Optional, and only meaningful with changes_requested. Lenient where
  // the verdict is strict: a malformed `grants` is dropped, never turns a
  // readable verdict into a failed review. Each entry is validated later
  // (validateExtraAllowedTools) before anything can use it.
  const grantList =
    verdict === "changes_requested" && Array.isArray(grants)
      ? [...new Set(grants.filter((g): g is string => typeof g === "string" && g.trim() !== "").map((g) => g.trim()))]
      : [];

  // Same leniency for `findings` (docs/SDD-coordinator.md §4.6): entries
  // that don't parse are dropped, never a failed review.
  const findingList = Array.isArray(findings) ? findings.map(parseFinding).filter((f): f is ReviewFinding => f !== null) : [];

  return {
    verdict: verdict as ReviewVerdict["verdict"],
    feedback,
    ...(grantList.length ? { grants: grantList } : {}),
    ...(findingList.length ? { findings: findingList } : {}),
  };
}
