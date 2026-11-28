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
import type { Project, ScheduleTaskTemplate, TaskCard } from "../core/types.ts";
import { cardFilesError, startConditionsError } from "./start-conditions.ts";
import { appendCardRules, CARD_TEMPLATE_KINDS, renderCardTemplate, type CardTemplateKind } from "../core/card-templates.ts";

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
  editing?: Pick<TaskCard, "id" | "reviewLineageId" | "review">;
  /** Whether a workstream id is known (WorkstreamStore). Without it a
   *  card can't name a workstream. */
  workstreamExists?: (id: string) => boolean;
}

/** TaskCard.key: a short name such as "A4". */
export const CARD_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

/** Why `key` can't be used on a card in `repo`, or undefined when it can
 *  (docs/SDD-coordinator.md §3.3). Until workstreams exist a key is
 *  unique per project: no other live card (not archived, not replaced by
 *  a later attempt) in the same repo may carry it, except the attempts
 *  and reviews of the same work. A card in a workstream is unique across
 *  the whole workstream instead (§3.3), whatever repo it is in. */
export async function cardKeyRefusal(board: Board, key: unknown, repo: string | undefined, editing?: Pick<TaskCard, "id" | "reviewLineageId">, workstreamId?: string): Promise<string | undefined> {
  if (typeof key !== "string" || !CARD_KEY_PATTERN.test(key)) return "key must be 1 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit (such as A4)";
  const lineage = editing ? (editing.reviewLineageId ?? editing.id) : undefined;
  const scope = workstreamId ? (await board.list()).filter((t) => t.workstreamId === workstreamId) : (await board.list(repo ? { repo } : {})).filter((t) => (repo ? true : !t.repo));
  const clash = scope.find((t) => t.key === key && !t.archivedAt && !t.supersededBy && t.id !== editing?.id && (lineage === undefined || (t.reviewLineageId ?? t.id) !== lineage));
  return clash ? `key "${key}" is already used by "${clash.title}" (${clash.id}) in this ${workstreamId ? "workstream" : "project"}` : undefined;
}

export type NewTaskCheck = { ok: true; task: NewTask } | { ok: false; error: string };

/** On success `task` is the body normalized the way it is stored
 *  (tool grants normalized, `notBefore` in UTC). */
/** Why `review` from outside is refused: it may only be
 *  `{ "tier": "<id>" }` (or null to clear it). */
export function reviewTierError(review: unknown): string | undefined {
  if (review === undefined || review === null) return undefined;
  if (typeof review !== "object" || Array.isArray(review)) return 'review must be an object: { "tier": "<tier id>" }';
  const extra = Object.keys(review).find((k) => k !== "tier" && k !== "panel" && k !== "mode" && k !== "reReview");
  if (extra) return `unknown review field "${extra}"; only tier can be set`;
  const tier = (review as Record<string, unknown>).tier;
  if (tier !== undefined && tier !== null && !(typeof tier === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(tier))) return "review.tier must be a tier id (lowercase letters, digits and hyphens)";
  return undefined;
}

export async function validateNewTask(input: NewTask, deps: NewTaskDeps): Promise<NewTaskCheck> {
  const body: NewTask = { ...input };
  // The round and the pull request are recorded by Wissel itself (the
  // orchestrator, and POST /tasks/:id/pr), never sent with a new card.
  delete body.round;
  delete body.pr;
  // Of the review details only the tier comes from outside
  // (docs/SDD-coordinator.md §4.6); a panel or re-review is Wissel's.
  const tierError = reviewTierError(body.review);
  if (tierError) return { ok: false, error: tierError };
  const tier = (body.review as { tier?: string } | null | undefined)?.tier ?? undefined;
  const { tier: _oldTier, ...kept } = deps.editing?.review ?? {};
  const review = { ...kept, ...(tier ? { tier } : {}) };
  body.review = Object.keys(review).length ? review : undefined;
  if (body.workstreamId !== undefined && body.workstreamId !== null) {
    if (typeof body.workstreamId !== "string" || !deps.workstreamExists?.(body.workstreamId)) return { ok: false, error: `no such workstream: ${JSON.stringify(body.workstreamId)}` };
  } else body.workstreamId = undefined;
  // Start conditions and named files (docs/SDD-coordinator.md §4.8).
  if (body.waitsFor !== undefined && body.waitsFor !== null) {
    const refused = await startConditionsError(body.waitsFor, async (id) => (await deps.board.get(id)) !== undefined);
    if (refused) return { ok: false, error: refused };
    if (body.waitsFor.length === 0) body.waitsFor = undefined;
  } else body.waitsFor = undefined;
  if (body.files !== undefined && body.files !== null) {
    const refused = cardFilesError(body.files);
    if (refused) return { ok: false, error: refused };
    body.files = body.files.length ? [...new Set(body.files)] : undefined;
  } else body.files = undefined;
  if (body.key !== undefined && body.key !== null) {
    const refused = await cardKeyRefusal(deps.board, body.key, body.repo, deps.editing, body.workstreamId ?? undefined);
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

/** A `POST /tasks` body: a new card, optionally started from one of its
 *  project's templates (docs/SDD-coordinator.md §4.16). */
export type CardStart = NewTask & { template?: unknown; fields?: unknown };

/** The card's body as it will be stored: the project's template for
 *  `template` rendered with `fields` (plus the card's own `key`, `title`
 *  and `body`), then the project's `cardRules` appended. Refused when the
 *  kind is unknown, the project has no such template, or a required
 *  placeholder is empty. Without `template`, only the rules are added. */
export function prepareCardStart(input: CardStart, project: Pick<Project, "cardRules" | "cardTemplates"> | undefined): { ok: true; task: NewTask } | { ok: false; error: string } {
  const { template, fields, ...task } = input;
  let body = task.body ?? "";
  if (template !== undefined && template !== null) {
    if (typeof template !== "string" || !(CARD_TEMPLATE_KINDS as readonly string[]).includes(template)) {
      return { ok: false, error: `template must be one of: ${CARD_TEMPLATE_KINDS.join(", ")}` };
    }
    const source = project?.cardTemplates?.[template as CardTemplateKind];
    if (!source) return { ok: false, error: `this project has no "${template}" template (set cardTemplates with POST /projects/:id/settings)` };
    if (fields !== undefined && (fields === null || typeof fields !== "object" || Array.isArray(fields))) return { ok: false, error: "fields must be an object of placeholder values" };
    const rendered = renderCardTemplate(source, { ...(fields as Record<string, unknown> | undefined), key: task.key, title: task.title, body: task.body }, template);
    if (!rendered.ok) return { ok: false, error: rendered.error };
    body = rendered.body;
  } else if (fields !== undefined) {
    return { ok: false, error: "fields are only used with template" };
  }
  return { ok: true, task: { ...task, body: appendCardRules(body, project?.cardRules) } };
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
