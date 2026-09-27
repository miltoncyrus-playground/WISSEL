import type { SubtaskPlanItem } from "../core/types.ts";

/** The opening fence marker. Matched via `lastIndexOf`, not a regex, and
 *  deliberately NOT paired with a non-greedy "nearest closing fence"
 *  search — a real planner response legitimately embeds markdown code
 *  samples (their own ` ``` ` fences) inside an item's own `body` field,
 *  since `body` is the literal prompt text a fresh implementer session
 *  will read, and showing it a fenced snippet is normal, useful prose.
 *  An earlier version of this parser used
 *  `/```subtask-plan\s*\n([\s\S]*?)```/g` (non-greedy), which stopped at
 *  the FIRST `` ``` `` after the opening marker — i.e. a nested code
 *  sample's own closing fence inside `body`, not the block's real end —
 *  truncating the captured JSON mid-string and failing every real plan
 *  that included one (caught live: a planner run decomposing "Add/import
 *  projects" embedded a TypeScript interface snippet in its first item's
 *  `body`, truncating the capture at 445 of 20800+ real characters and
 *  failing with a JSON "Unterminated string" error). The contract
 *  (`agents/manifest.yaml`'s `planner.outputContract`) mandates the
 *  block is the LAST thing in the message — nothing follows it — so the
 *  correct closing fence is the LAST `` ``` `` in the text after the
 *  opening marker, not the nearest one. */
const OPEN_MARKER = "```subtask-plan";

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
  // Last occurrence of the opening marker — same "a model that thinks out
  // loud with an earlier example block" handling the old regex's `g` +
  // last-match already gave us, kept on purpose.
  const openIdx = rawOutput.lastIndexOf(OPEN_MARKER);
  if (openIdx === -1) return null;

  const afterMarker = rawOutput.slice(openIdx + OPEN_MARKER.length);
  const firstNewline = afterMarker.indexOf("\n");
  if (firstNewline === -1) return null; // opening fence with no body at all

  const rest = afterMarker.slice(firstNewline + 1);
  const closeIdx = rest.lastIndexOf("```"); // the LAST fence, not the nearest — see this file's own doc comment
  if (closeIdx === -1) return null;

  const body = rest.slice(0, closeIdx).trim();

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
