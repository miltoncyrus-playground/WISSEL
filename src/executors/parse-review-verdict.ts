import type { ReviewVerdict } from "../core/types.ts";

const VALID_VERDICTS = new Set<ReviewVerdict["verdict"]>(["approve", "changes_requested"]);

/** Matches a fenced ```review-verdict block anywhere in the text — the
 *  contract requires the final message to *end with* one, but the raw
 *  text passed in here is whatever claude printed, prose and all, so
 *  this has to find the block rather than assume the whole string is
 *  JSON. `g` + taking the last match handles a model that "thinks out
 *  loud" with an earlier example block before the real one. */
const VERDICT_BLOCK = /```review-verdict\s*\n([\s\S]*?)```/g;

/**
 * The only code allowed to turn raw claude output into a ReviewVerdict.
 * Strict on purpose: malformed, missing, or ambiguous input returns
 * null — it never guesses "approve" as a safe default, because a
 * silently-approved review is worse than a loudly-failed one.
 */
export function parseReviewVerdict(rawOutput: string): ReviewVerdict | null {
  const matches = [...rawOutput.matchAll(VERDICT_BLOCK)];
  if (matches.length === 0) return null;

  const body = matches[matches.length - 1]![1]!.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { verdict, feedback } = candidate as Record<string, unknown>;

  if (typeof verdict !== "string" || !VALID_VERDICTS.has(verdict as ReviewVerdict["verdict"])) return null;
  if (typeof feedback !== "string") return null;

  return { verdict: verdict as ReviewVerdict["verdict"], feedback };
}
