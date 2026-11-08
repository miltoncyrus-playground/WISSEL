// The checks `POST /tasks` runs on a new card's body, moved out of
// server.ts so a task schedule's `taskTemplate` (src/services/schedules.ts,
// docs/SDD-schedules.md §3.2) is refused by exactly the same rules, with
// the same words, as the card it will later create.

import type { Board } from "./board.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { Registry } from "../core/registry.ts";
import type { Router } from "../core/router.ts";
import { resolveHandoffAllowlist } from "../core/orchestrator.ts";
import { readModelsCache } from "../core/model-refresh-scheduler.ts";
import { validateExtraAllowedTools } from "../core/allowed-tools.ts";
import { validateNotBefore } from "../core/not-before.ts";
import { validateMergeTarget } from "./worktree.ts";
import type { ScheduleTaskTemplate, TaskCard } from "../core/types.ts";

export type NewTask = Omit<TaskCard, "id" | "status">;

export interface NewTaskDeps {
  board: Board;
  registry: Registry;
  router: Router;
  harnesses: HarnessPool;
  modelsCachePath: string;
  now: Date;
  /** The harness the project registered at `repo` asks its new cards to
   *  run on (Project.harness), if any. Filled in when the card names
   *  none. docs/SDD-project-harness.md. */
  projectHarnessFor?: (repo: string) => Promise<string | undefined>;
  /** `PATCH /tasks/:id`: the card being edited, so keeping its own
   *  `key` doesn't count as a duplicate of itself. */
  editingTaskId?: string;
}

/** docs/SDD-coordinator.md §3.3: the shape of `key`, `round`, `pr` and
 *  `workstreamId`, and that `key` is unique within a workstream. A key on
 *  a card with no workstream is not checked. Returns the refusal, or
 *  undefined when the fields are fine. */
export async function checkCardFields(body: NewTask, board: Board, editingTaskId?: string): Promise<string | undefined> {
  const { key, round, pr, workstreamId } = body as Record<string, unknown>;
  if (key !== undefined && (typeof key !== "string" || key.trim() === "")) return "key must be a non-empty string";
  if (round !== undefined && (!Number.isInteger(round) || (round as number) < 1)) return "round must be a whole number from 1";
  if (pr !== undefined) {
    const p = pr as { number?: unknown; url?: unknown; head?: unknown } | null;
    if (p === null || typeof p !== "object" || Array.isArray(p) || !Number.isInteger(p.number) || (p.number as number) < 1 || typeof p.url !== "string" || typeof p.head !== "string") {
      return "pr must be { number: whole number from 1, url: string, head: string }";
    }
  }
  if (workstreamId !== undefined && (typeof workstreamId !== "string" || workstreamId.trim() === "")) return "workstreamId must be a non-empty string";
  if (typeof key === "string" && typeof workstreamId === "string") {
    const taken = (await board.list()).find((t) => t.id !== editingTaskId && t.workstreamId === workstreamId && t.key === key);
    if (taken) return `key "${key}" is already used in workstream "${workstreamId}" by task ${taken.id}`;
  }
  return undefined;
}

export type NewTaskCheck = { ok: true; task: NewTask } | { ok: false; error: string };

/** On success `task` is the body normalized the way it is stored
 *  (tool grants normalized, `notBefore` in UTC). */
export async function validateNewTask(input: NewTask, deps: NewTaskDeps): Promise<NewTaskCheck> {
  const body: NewTask = { ...input };
  // Per-card tool grants (src/core/allowed-tools.ts): command-scoped
  // Bash only, never a blanket grant. Stored normalized.
  const grants = validateExtraAllowedTools(body.extraAllowedTools);
  if (!grants.ok) return { ok: false, error: grants.error };
  body.extraAllowedTools = grants.tools.length > 0 ? grants.tools : undefined;
  // "Start at" (docs/SDD-schedules.md §4): future, at most 30
  // days out, stored normalized to UTC.
  if (body.notBefore !== undefined && body.notBefore !== null) {
    const start = validateNotBefore(body.notBefore, deps.now);
    if (!start.ok) return { ok: false, error: start.error };
    body.notBefore = start.notBefore;
  } else {
    body.notBefore = undefined;
  }
  // `mergeTarget` (docs/SDD-merge-target.md): a plain local branch name,
  // or none. A bad one is refused here, not discovered at merge time.
  const mergeTarget = validateMergeTarget(body.mergeTarget);
  if (!mergeTarget.ok) return { ok: false, error: mergeTarget.error };
  body.mergeTarget = mergeTarget.target;
  // Card key, round, PR and workstream (docs/SDD-coordinator.md §3.3).
  // `null` means "none", as for `notBefore` above.
  for (const k of ["key", "round", "pr", "workstreamId"] as const) if (body[k] === null) body[k] = undefined;
  const fieldsError = await checkCardFields(body, deps.board, deps.editingTaskId);
  if (fieldsError) return { ok: false, error: fieldsError };
  // `harnessOverride` is validated eagerly, at creation time,
  // because we already know exactly which harness it names.
  // `model` with no `harnessOverride` is deliberately NOT
  // validated here — which harness/tool will actually run this
  // task isn't known until routing happens, so there's nothing
  // yet to check it against (see docs/SDD-model-selection.md §9,
  // and the fail-loud precedence resolution in
  // src/core/model-resolution.ts, which validates it for real at
  // dispatch time).
  if (!body.harnessOverride && body.repo && deps.projectHarnessFor) {
    body.harnessOverride = (await deps.projectHarnessFor(body.repo)) ?? undefined;
  }
  if (body.harnessOverride) {
    const harness = deps.harnesses.get(body.harnessOverride);
    if (!harness) return { ok: false, error: `unknown harnessOverride "${body.harnessOverride}"` };
    if (body.model) {
      const cache = await readModelsCache(deps.modelsCachePath);
      const availableModels = cache[harness.id]?.models ?? [];
      if (availableModels.length > 0 && !availableModels.includes(body.model)) {
        return { ok: false, error: `model "${body.model}" is not in the known model list for harness "${harness.id}"` };
      }
    }
  }
  // `repo` is required only for a task that will route to a
  // write- or bash-capable agent — a readonly, no-file-access
  // agent (e.g. "check Jira, post to Slack") never touches a
  // filesystem, so forcing a repo on it would just be a directory
  // name nothing ever reads (see TaskCard.repo's own doc
  // comment). Resolved synchronously here, the same way
  // `/route/preview` already resolves a routing decision with no
  // side effects — routing itself normally happens later, inside
  // `sweep()`, but a confident resolution here lets a bad
  // no-repo submission 400 immediately instead of silently
  // stalling once sweep() actually routes it. A task that
  // doesn't resolve confidently yet (ambiguous/no-match labels)
  // is allowed through without a repo — see Orchestrator.process's
  // own write/bash-access check for the dispatch-time safety net
  // that covers this case if it's later routed to a write-tier
  // agent by a label edit.
  if (!body.repo) {
    const allowIds = await resolveHandoffAllowlist(deps.board, deps.registry, body.parentTaskId);
    const previewTask: TaskCard = {
      id: "repo-check",
      title: body.title ?? "",
      body: body.body ?? "",
      labels: body.labels ?? [],
      status: "inbox",
    };
    const decision = await deps.router.route(previewTask, allowIds);
    const agent = decision.confident && decision.selected ? deps.registry.get(decision.selected) : undefined;
    if (agent && (agent.toolAccess.includes("write") || agent.toolAccess.includes("bash"))) {
      return { ok: false, error: `repo is required — this task would route to "${agent.id}", which has file/bash access` };
    }
  }
  return { ok: true, task: body };
}

/** validateNewTask as SqliteScheduleStore's `validateTaskTemplate`
 *  option (src/services/schedules.ts): a task schedule's template is
 *  refused by the very rules its cards will meet at `POST /tasks`. */
export function taskTemplateValidator(deps: Omit<NewTaskDeps, "now">): (template: ScheduleTaskTemplate) => Promise<{ ok: true } | { ok: false; error: string }> {
  return async (template) => {
    const check = await validateNewTask(template, { ...deps, now: new Date() });
    return check.ok ? { ok: true } : check;
  };
}
