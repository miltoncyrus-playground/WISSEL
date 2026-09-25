import type { PipelineHandoff } from "../core/types.ts";

/** Matches a fenced ```pipeline-handoff block anywhere in the text — same
 *  reasoning as VERDICT_BLOCK in parse-review-verdict.ts: the contract
 *  requires the final message to *end with* one, but the raw text here
 *  is whatever claude printed, prose and all, so this has to find the
 *  block rather than assume the whole string is JSON. `g` + taking the
 *  last match handles a model that "thinks out loud" with an earlier
 *  example block before the real one. */
const HANDOFF_BLOCK = /```pipeline-handoff\s*\n([\s\S]*?)```/g;

/**
 * The only code allowed to turn raw claude output into a PipelineHandoff.
 * Strict on purpose, mirroring parseReviewVerdict's own contract:
 * malformed, missing, or ambiguous input returns null — it never guesses
 * a `next` value, because a silently-misrouted pipeline step is worse
 * than a loudly-failed one.
 *
 * Every field is optional at this layer — an "all"/fan-out step's handoff
 * legitimately has no `next` at all (see PipelineHandoff's own doc
 * comment). Whether a *specific* step required `next` is a
 * pipeline-runner.ts concern (it knows the step's own transition type),
 * not this parser's — this only rejects a block that's malformed JSON or
 * has a field of the wrong type.
 */
export function parsePipelineHandoff(rawOutput: string): PipelineHandoff | null {
  const matches = [...rawOutput.matchAll(HANDOFF_BLOCK)];
  if (matches.length === 0) return null;

  const body = matches[matches.length - 1]![1]!.trim();

  let candidate: unknown;
  try {
    candidate = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { next, data, note } = candidate as Record<string, unknown>;

  if (next !== undefined && (typeof next !== "string" || next.length === 0)) return null;
  if (data !== undefined && (typeof data !== "object" || data === null || Array.isArray(data))) return null;
  if (note !== undefined && typeof note !== "string") return null;

  return {
    ...(next !== undefined ? { next } : {}),
    ...(data !== undefined ? { data: data as Record<string, unknown> } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}
