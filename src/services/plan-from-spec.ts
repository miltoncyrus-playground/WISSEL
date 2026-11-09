import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Project } from "../core/types.ts";
import type { IngestResult, InboxEvent, NewInboxEvent } from "./inbox.ts";
import type { Workstream } from "./workstreams.ts";

/**
 * Plan from spec (docs/SDD-coordinator.md §4.4 plan-batch, §7): the owner
 * hands the coordinator the workstream's spec and it plans the work.
 * `POST /workstreams/:id/plan` reads the spec file from disk (the
 * workstream's `spec` unless the body names another file in the repo),
 * refuses a path outside the repo or a text over SPEC_TEXT_LIMIT, and
 * ingests a `plan-batch` inbox event from the owner. The id is
 * source-stable: `owner:plan:<ws>:<sha256 of the text, 12>:<n>`, where n
 * counts the earlier plan events for the same text that are older than
 * REPLAN_AFTER_MS. A double click lands on the same id and is ignored by
 * the inbox; a re-plan later is a new event. The spec text rides in the
 * payload and reaches the decision card only inside the untrusted fence
 * (renderDecisionCard).
 */
export const SPEC_TEXT_LIMIT = 40_000;
/** How long after a plan event the same text counts as a double click rather than a re-plan. */
export const REPLAN_AFTER_MS = 60_000;

export interface PlanRequest { repo?: string; path?: string; note?: string }
export interface PlanBatchPayload { specRepo: string; specPath: string; specText: string; note?: string; workstreamId: string }
export type PlanOutcome = { ok: true; eventId: string; path: string; duplicate: boolean } | { ok: false; error: string };

export interface PlanDeps {
  projects: { list(): Promise<Pick<Project, "id" | "path">[]> };
  inbox: { list(filter: { workstreamId?: string }): InboxEvent[] };
  ingest: (event: NewInboxEvent) => Promise<IngestResult>;
  now?: () => Date;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The optional body: repo, path and note, each a non-empty string when present; nothing else. */
export function validatePlanRequest(body: unknown): { ok: true; request: PlanRequest } | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, request: {} };
  if (!isRecord(body)) return { ok: false, error: "body must be an object with optional repo, path and note" };
  const request: PlanRequest = {};
  for (const [key, value] of Object.entries(body)) {
    if (key !== "repo" && key !== "path" && key !== "note") return { ok: false, error: `unknown field ${key}` };
    if (typeof value !== "string" || value.trim() === "") return { ok: false, error: `${key} must be a non-empty string` };
    request[key] = value.trim();
  }
  return { ok: true, request };
}

/** Reads the spec and ingests the plan-batch event; every refusal is a 400 for the route. */
export async function planFromSpec(ws: Workstream, body: PlanRequest, deps: PlanDeps): Promise<PlanOutcome> {
  const projectId = ws.projects[0]?.projectId;
  const project = projectId ? (await deps.projects.list()).find((p) => p.id === projectId) : undefined;
  if (!project) return { ok: false, error: `workstream ${ws.name} has no project to plan for` };
  const path = body.path ?? ws.spec?.path;
  if (!path) return { ok: false, error: `workstream ${ws.name} has no spec; give a path in the body or set spec on the workstream` };
  const repo = resolve(body.repo ?? ws.spec?.repo ?? project.path);
  const full = resolve(repo, path);
  const rel = relative(repo, full);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: `spec path ${path} escapes the repo ${repo}` };
  let text: string;
  try {
    text = await readFile(full, "utf8");
  } catch (e) {
    return { ok: false, error: `cannot read spec ${path} in ${repo}: ${(e as NodeJS.ErrnoException).code ?? String(e)}` };
  }
  if (text.length > SPEC_TEXT_LIMIT) return { ok: false, error: `spec ${path} is ${text.length} characters; at most ${SPEC_TEXT_LIMIT}` };
  if (text.trim() === "") return { ok: false, error: `spec ${path} is empty` };
  const sha = createHash("sha256").update(text).digest("hex").slice(0, 12);
  const prefix = `owner:plan:${ws.id}:${sha}:`;
  const cutoff = (deps.now ?? (() => new Date()))().getTime() - REPLAN_AFTER_MS;
  const n = deps.inbox.list({ workstreamId: ws.id }).filter((e) => e.kind === "plan-batch" && e.id.startsWith(prefix) && Date.parse(e.receivedAt) <= cutoff).length;
  const payload: PlanBatchPayload = { specRepo: repo, specPath: path, specText: text, ...(body.note ? { note: body.note } : {}), workstreamId: ws.id };
  const r = await deps.ingest({ id: `${prefix}${n}`, source: "owner", kind: "plan-batch", workstreamId: ws.id, payload });
  return { ok: true, eventId: `${prefix}${n}`, path, duplicate: r.duplicate };
}
