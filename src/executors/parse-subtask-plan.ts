import type { SubtaskPlanItem } from "../core/types.ts";

/** Matches a fenced ```subtask-plan block anywhere in the text — the
 *  contract requires the final message to *end with* one, but the raw
 *  text passed in here is whatever claude printed, prose and all, so
 *  this has to find the block rather than assume the whole string is
 *  JSON. `g` + taking the last match handles a model that "thinks out
 *  loud" with an earlier example block before the real one. */
const PLAN_BLOCK = /```subtask-plan\s*\n([\s\S]*?)```/g;

function isValidItem(candidate: unknown, index: number): candidate is SubtaskPlanItem {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
  const { title, body, labels, dependsOnIndex } = candidate as Record<string, unknown>;

  if (typeof title !== "string" || title.length === 0) return false;
  if (typeof body !== "string") return false;
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) return false;

  if (dependsOnIndex !== undefined) {
    if (typeof dependsOnIndex !== "number" || !Number.isInteger(dependsOnIndex)) return false;
    // Forward or self references are invalid — an item can only depend
    // on a strictly earlier item in the same array, never one that
    // doesn't exist yet at the time it's created.
    if (dependsOnIndex < 0 || dependsOnIndex >= index) return false;
  }

  return true;
}

/**
 * The only code allowed to turn raw claude output into a
 * SubtaskPlanItem[]. Strict on purpose: malformed, missing, or ambiguous
 * input returns null — it never partial-parses a plan or drops an
 * invalid item silently, because a silently truncated decomposition is
 * worse than a loudly-failed one.
 */
export function parseSubtaskPlan(rawOutput: string): SubtaskPlanItem[] | null {
  const matches = [...rawOutput.matchAll(PLAN_BLOCK)];
  if (matches.length === 0) return null;

  const body = matches[matches.length - 1]![1]!.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return null;
  }

  if (!Array.isArray(candidate)) return null;

  for (let i = 0; i < candidate.length; i++) {
    if (!isValidItem(candidate[i], i)) return null;
  }

  return candidate as SubtaskPlanItem[];
}
