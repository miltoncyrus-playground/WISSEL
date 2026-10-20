import type { PipelineHandoff } from "../core/types.ts";
import { lastFencedBlock } from "./fenced-block.ts";

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
  // Last block, last closing fence: handoff data can hold markdown with
  // its own fences. See lastFencedBlock.
  const body = lastFencedBlock(rawOutput, "pipeline-handoff")?.trim();
  if (body === undefined) return null;

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
