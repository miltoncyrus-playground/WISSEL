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
  /** Set when an existing card is being edited: its own key, and the
   *  attempts and reviews of the same work, don't count as a clash. */
  editing?: Pick<TaskCard, "id" | "reviewLineageId">;
}

/** TaskCard.key: a short name such as "A4". */
export const CARD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Why `key` can't be used on a card in `repo`, or undefined when it can
 *  (docs/SDD-coordinator.md §3.3). Until workstreams exist a key is
 *  unique per project: no other live card (not archived, not replaced by
 *  a later attempt) in the same repo may carry it, except the attempts
 *  and reviews of the same work. */
export async function cardKeyRefusal(board: Board, key: unknown, repo: string | undefined, editing?: Pick<TaskCard, "id" | "reviewLineageId">): Promise<string | undefined> {
  if (typeof key !== "string" || !CARD_KEY_PATTERN.test(key)) return "key must be 1 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit (such as A4)";
  const lineage = editing ? (editing.reviewLineageId ?? editing.id) : undefined;
  const clash = (await board.list(repo ? { repo } : {})).find(
    (t) => t.key === key && !t.archivedAt && !t.supersededBy && (repo ? true : !t.repo) && t.id !== editing?.id && (lineage === undefined || (t.reviewLineageId ?? t.id) !== lineage),
  );
  return clash ? `key "${key}" is already used by "${clash.title}" (${clash.id}) in this project` : undefined;
}

export type NewTaskCheck = { ok: true; task: NewTask } | { ok: false; error: string };

/** On success `task` is the body normalized the way it is stored
 *  (tool grants normalized, `notBefore` in UTC). */
export async function validateNewTask(input: NewTask, deps: NewTaskDeps): Promise<NewTaskCheck> {
  const body: NewTask = { ...input };
  // The round and the pull request are recorded by Wissel itself (the
  // orchestrator, and POST /tasks/:id/pr), never sent with a new card.
  delete body.round;
  delete body.pr;
  if (body.key !== undefined && body.key !== null) {
    const refused = await cardKeyRefusal(deps.board, body.key, body.repo, deps.editing);
    if (refused) return { ok: false, error: refused };
  } else {
    body.key = undefined;
  }
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
