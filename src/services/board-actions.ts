// What the board's buttons do, once (docs/SDD-wissel-app.md §3.7). Each
// function is the body of one `POST /tasks/:id/...`, `/harnesses/:id/...`,
// `/mcp-servers/:id/...` or `/schedules/...` route, moved out of server.ts so the route
// and Ask's control actions run the very same code: Ask never calls our
// own HTTP API and never has a second copy of an endpoint's checks.
//
// The `...Refusal` predicates are pure: Ask's validator
// (concierge-actions.ts) runs them up front to say why, and the
// functions here run them again on the board as it is when they act.

import { EDITABLE_CARD_FIELDS, type Board, type CardEdit } from "./board.ts";
import { validateNewTask, type NewTask, type NewTaskDeps } from "./task-input.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { McpServerPool, CheckMcpServerReachableOptions } from "../core/mcp-server-pool.ts";
import { checkMcpServerReachable } from "../core/mcp-server-pool.ts";
import { setMcpServerEnabled, setMcpServerToolTrust } from "../core/mcp-manifest.ts";
import { checkHarnessAuth } from "../core/harness-discovery.ts";
import { setHarnessEnabled, setHarnessModel } from "../core/harness-manifest.ts";
import { readModelsCache } from "../core/model-refresh-scheduler.ts";
import { validateExtraAllowedTools } from "../core/allowed-tools.ts";
import { validateNotBefore } from "../core/not-before.ts";
import { mergeTaskWorktree, removeTaskWorktree, type MergeContext } from "./worktree.ts";
import { afterMergeAttempt, MAX_CONFLICT_INTEGRATORS, MAX_PUSHBACKS, withConflictIntegratorCheck } from "../core/orchestrator.ts";
import { Registry } from "../core/registry.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { ScheduleValidationError, type ScheduleInput, type SchedulePatch, type ScheduleStore } from "./schedules.ts";
import { ScheduleNotFoundError, ScheduleOverlapError, type ScheduleRunner } from "../core/schedule-runner.ts";
import { DEFAULT_SCHEDULE_TIMEZONE, describeCadence, nextRuns, validateSchedule } from "../core/schedule-time.ts";
import type { Harness, McpServer, ScheduleDef, TaskCard, TaskResult } from "../core/types.ts";

/** A route's answer before it is a Response: the value on success, or
 *  the status and error it answers with. 404 routes answer "not found". */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = (status: 400 | 404 | 409, error: string): Outcome<never> => ({ ok: false, status, error });

// ---------- pure predicates: undefined means allowed ----------

/** Merge and Discard need a worktree (a write-tier run's result). */
export function worktreeRefusal(result: Pick<TaskResult, "worktree"> | undefined, verb: "merge" | "discard"): string | undefined {
  return result?.worktree ? undefined : `task has no worktree to ${verb}`;
}

/** Abandon, approve, grant-and-retry and retry of an escalation. */
export function escalationRefusal(task: Pick<TaskCard, "status">): string | undefined {
  return task.status === "escalated" ? undefined : "task is not escalated";
}

/** Approve or deny an MCP tool call request. */
export function mcpApprovalRefusal(task: Pick<TaskCard, "status" | "pendingMcpApproval">): string | undefined {
  return task.status === "review" && task.pendingMcpApproval ? undefined : "task has no pending MCP approval request";
}

/** Per-card settings (tools, harness) change only while the card isn't
 *  running: a running card keeps what it started with. */
export function cardSettingsRefusal(task: Pick<TaskCard, "status">, what: "tools" | "harness"): string | undefined {
  return task.status === "running" || task.status === "dispatched" ? `task is ${task.status}; change its ${what} once it stops` : undefined;
}

/** A start time (TaskCard.notBefore) only means something on a card
 *  sweep() has yet to pick up: queued, not routed, not archived, and not
 *  a pipeline card (the pipeline runner starts those, never sweep). */
export function notBeforeRefusal(task: Pick<TaskCard, "status" | "routedTo" | "archivedAt" | "pipelineId">): string | undefined {
  if (task.archivedAt) return "task is archived; unarchive it to give it a start time";
  if (task.pipelineId !== undefined) return "a pipeline card starts with its pipeline, not on its own start time";
  if (task.status !== "inbox" && task.status !== "ready") return `task is ${task.status}; a start time only applies to a card in inbox or ready`;
  if (task.routedTo) return `task is already routed to ${task.routedTo}; it is past its start`;
  return undefined;
}

// ---------- tasks ----------

/** `POST /tasks/:id/merge`: runs the merge path (mergeTaskWorktree:
 *  gate in the worktree, fast-forward into task.repo, recorded sha),
 *  and moves the card to done once it lands. Every miss is a 409 whose
 *  error says what happened:
 *  - gate failed: the card goes back as a pushback attempt (or
 *    escalates at the cap), same as a reviewer's changes_requested;
 *  - conflict: left in the worktree, one integrator card spawned per
 *    conflicting HEAD (at most MAX_CONFLICT_INTEGRATORS per card, then
 *    the card escalates to a human). Once that card has finished and no
 *    marker is left, the next merge commits the resolution itself
 *    (worktree.ts finishResolvedMerge);
 *  - blocked by uncommitted local changes: lists the files; nothing
 *    touched, no integrator (it isn't a conflict);
 *  - HEAD moved twice while checking: merge again. */
export async function mergeTask(
  board: Board,
  id: string,
  runner: CommandRunner | MergeContext,
  registry?: Registry,
): Promise<Outcome<{ merged: true; message: string; task: TaskCard; mergedSha?: string }>> {
  const task = await board.get(id);
  if (!task) return no(404, "not found");
  const result = await board.getResult(id);
  const refused = worktreeRefusal(result, "merge");
  if (refused) return no(409, refused);
  // A worktree only ever exists for a write-tier run, which requires
  // `repo` at creation time (see POST /tasks) — never reachable for a
  // repo-less readonly task.
  const worktree = result!.worktree!;
  const merge = await mergeTaskWorktree(task.repo!, worktree, task, withConflictIntegratorCheck(board, runner), (sha) => board.recordMerge(task.id, sha));
  if (!merge.ok) {
    const next = await afterMergeAttempt(board, registry ?? Registry.from([]), task, worktree, merge);
    // The gate's full output tail goes to the new attempt's body, not to
    // the button: the error names the command and where to look.
    const failed = merge.gate.runs[merge.gate.runs.length - 1];
    const gateLine = failed
      ? `Merge gate failed: \`${failed.argv.join(" ")}\` ${failed.timedOut ? "timed out" : `exited ${failed.exitCode}`}. Nothing landed.`
      : merge.message;
    if (next === "pushback") {
      const attempt = (await board.get(task.id))?.supersededBy;
      return no(409, `${gateLine} Sent back for re-attempt ${(task.pushbackCount ?? 0) + 1} of ${MAX_PUSHBACKS}${attempt ? ` (card ${attempt})` : ""}, with the output.`);
    }
    if (next === "escalated" && merge.outcome === "conflict") {
      return no(409, `${merge.message}\nEscalated: ${MAX_CONFLICT_INTEGRATORS} integrator cards have already been spawned for this card's conflicts. Resolve this one in the worktree yourself, \`git commit --no-edit\` there, then merge again.`);
    }
    if (next === "escalated") return no(409, `${gateLine} Escalated: the pushback limit is reached.`);
    return no(409, merge.message);
  }
  const moved = await board.move(task.id, "done");
  return ok({ merged: true as const, message: merge.message, task: moved, ...(merge.mergedSha ? { mergedSha: merge.mergedSha } : {}) });
}

/** `POST /tasks/:id/discard`: removes the worktree and its branch
 *  without merging, and moves the card to failed. */
export async function discardTask(board: Board, id: string, runner: CommandRunner): Promise<Outcome<{ discarded: true; task: TaskCard }>> {
  const task = await board.get(id);
  if (!task) return no(404, "not found");
  const result = await board.getResult(id);
  const refused = worktreeRefusal(result, "discard");
  if (refused) return no(409, refused);
  await removeTaskWorktree(task.repo!, result!.worktree!, runner);
  const moved = await board.move(task.id, "failed");
  return ok({ discarded: true as const, task: moved });
}

/** `POST /tasks/:id/escalation/abandon`: gives up on an escalated card. */
export async function abandonEscalation(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = escalationRefusal(task);
  if (refused) return no(400, refused);
  return ok(await board.move(task.id, "failed"));
}

/** `POST /tasks/:id/mcp-approval/approve`: a new, narrow follow-up card
 *  scoped to exactly the one approved server and tool. See the route's
 *  comment in server.ts for why it is a new card, not a resumption. */
export async function approveMcpRequest(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = mcpApprovalRefusal(task);
  if (refused) return no(400, refused);
  const request = task.pendingMcpApproval!;
  const followUp = await board.create({
    title: `Approved MCP call: ${request.server}/${request.tool}`,
    body:
      `A human approved exactly one MCP tool call. Make exactly this one call, then end your turn — do not take any other action.\n\n` +
      `Server: ${request.server}\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.args)}\n\n` +
      `Reason originally given for this call: ${request.reason}`,
    labels: task.labels,
    repo: task.repo,
    mcpAccessOverride: [{ server: request.server, tools: [request.tool] }],
  });
  await board.setSupersededBy(task.id, followUp.id);
  await board.move(task.id, "done");
  return ok(followUp);
}

/** `POST /tasks/:id/mcp-approval/deny`: no follow-up; the card fails. */
export async function denyMcpRequest(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = mcpApprovalRefusal(task);
  if (refused) return no(400, refused);
  return ok(await board.move(task.id, "failed"));
}

/** `POST /tasks/:id/allowed-tools`: replaces the card's per-card tool
 *  grants (`[]` clears), command-scoped Bash only. */
export async function setAllowedTools(board: Board, task: TaskCard, extraAllowedTools: unknown): Promise<Outcome<TaskCard>> {
  const refused = cardSettingsRefusal(task, "tools");
  if (refused) return no(409, refused);
  if (extraAllowedTools === undefined) return no(400, "body needs extraAllowedTools (a list; [] clears)");
  const grants = validateExtraAllowedTools(extraAllowedTools);
  if (!grants.ok) return no(400, grants.error);
  return ok(await board.setExtraAllowedTools(task.id, grants.tools));
}

/** `POST /tasks/:id/harness`: the harness a card asks to run on
 *  (TaskCard.harnessOverride), or null to clear it. Same rule as a new
 *  card's `harnessOverride` in POST /tasks: the harness must exist. */
export async function setTaskHarnessOverride(board: Board, harnesses: HarnessPool, task: TaskCard, harnessId: unknown): Promise<Outcome<TaskCard>> {
  const refused = cardSettingsRefusal(task, "harness");
  if (refused) return no(409, refused);
  if (harnessId !== null && typeof harnessId !== "string") return no(400, "body needs harness (a harness id, or null to clear)");
  if (typeof harnessId === "string" && !harnesses.get(harnessId)) return no(400, `unknown harness "${harnessId}"`);
  return ok(await board.setHarnessOverride(task.id, harnessId ?? undefined));
}

/** `POST /tasks/:id/not-before`: the card's start time
 *  (TaskCard.notBefore), or null to clear it. Same rules as a new
 *  card's `notBefore` in POST /tasks (validateNotBefore). */
export async function setTaskNotBefore(board: Board, task: TaskCard, notBefore: unknown, now: Date): Promise<Outcome<TaskCard>> {
  const refused = notBeforeRefusal(task);
  if (refused) return no(409, refused);
  if (notBefore === null) return ok(await board.setNotBefore(task.id, undefined));
  const check = validateNotBefore(notBefore, now);
  if (!check.ok) return no(400, check.error);
  return ok(await board.setNotBefore(task.id, check.notBefore));
}

/** A card can be edited only before anything has happened to it: queued
 *  (inbox or ready), not routed to an agent, not archived, not replaced
 *  by a later attempt. Once it has run, the card is a record. */
export function editRefusal(task: Pick<TaskCard, "status" | "routedTo" | "archivedAt" | "supersededBy">): string | undefined {
  if (task.archivedAt) return "task is archived; it can't be edited";
  if (task.supersededBy) return "task was replaced by a later attempt; edit that one";
  if (task.status !== "inbox" && task.status !== "ready") return `task is ${task.status}; only a queued card can be edited`;
  if (task.routedTo) return `task is already routed to ${task.routedTo}; only an unrouted card can be edited`;
  return undefined;
}

/** `PATCH /tasks/:id` (docs/SDD-card-edit.md): changes title, body,
 *  labels, repo, model, harnessOverride, mergeTarget, extraAllowedTools or
 *  extraAllowedDirs on a card that hasn't started. The result is checked
 *  by the very rules a new card meets (validateNewTask), so an edit can't
 *  make a card that creation would have refused. A key set to null
 *  clears it. Anything else in the body is refused by name. */
export async function editTask(board: Board, task: TaskCard, patch: unknown, deps: NewTaskDeps): Promise<Outcome<TaskCard>> {
  const refused = editRefusal(task);
  if (refused) return no(409, refused);
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return no(400, "body must be a JSON object of the fields to change");
  const given = patch as Record<string, unknown>;
  const keys = Object.keys(given);
  if (keys.length === 0) return no(400, `body names no field to change (editable: ${EDITABLE_CARD_FIELDS.join(", ")})`);
  const unknown = keys.filter((k) => !(EDITABLE_CARD_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) return no(400, `can't edit ${unknown.join(", ")} (editable: ${EDITABLE_CARD_FIELDS.join(", ")})`);
  const typeError = editTypeError(given);
  if (typeError) return no(400, typeError);

  // The card as it would be, run through creation's checks. `notBefore`
  // is left out: it isn't editable here, and a start time that has
  // since passed would otherwise fail a check it already met.
  const candidate: NewTask = {
    title: task.title,
    body: task.body,
    labels: task.labels,
    repo: task.repo,
    model: task.model,
    harnessOverride: task.harnessOverride,
    mergeTarget: task.mergeTarget,
    extraAllowedTools: task.extraAllowedTools,
    extraAllowedDirs: task.extraAllowedDirs,
    ...Object.fromEntries(keys.map((k) => [k, given[k] === null ? undefined : given[k]])),
  };
  const check = await validateNewTask(candidate, deps);
  if (!check.ok) return no(400, check.error);
  const fields: CardEdit = {};
  for (const k of keys) (fields as Record<string, unknown>)[k] = (check.task as Record<string, unknown>)[k];
  return ok(await board.updateFields(task.id, fields));
}

function editTypeError(given: Record<string, unknown>): string | undefined {
  for (const k of ["title", "body", "repo", "model", "harnessOverride", "mergeTarget"]) {
    const v = given[k];
    if (k in given && v !== null && typeof v !== "string") return `${k} must be a string (or null to clear it)`;
  }
  if ((given.title === null || given.title === "") && "title" in given) return "title can't be empty";
  for (const k of ["labels", "extraAllowedTools", "extraAllowedDirs"]) {
    const v = given[k];
    if (k in given && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return `${k} must be a list of strings (or null to clear it)`;
  }
  return undefined;
}

// ---------- harnesses ----------

export interface HarnessControlDeps {
  harnesses: HarnessPool;
  /** harnesses.yaml, where a human's decision persists. */
  harnessesPath: string;
  /** For the enable re-check (checkHarnessAuth). */
  harnessRunner: CommandRunner;
  modelsCachePath: string;
  /** After a successful enable: held tasks are only re-checked on a
   *  sweep, and a harness toggle isn't a board event. */
  afterEnable?: () => void;
}

/** `POST /harnesses/:id/enable`: only for real. Re-runs the auth check
 *  first and refuses (409) a harness that still isn't signed in. */
export async function enableHarness(deps: HarnessControlDeps, harness: Harness): Promise<Outcome<Harness>> {
  const { authenticated } = await checkHarnessAuth(harness, { runner: deps.harnessRunner });
  if (!authenticated) {
    deps.harnesses.setEnabled(harness.id, false, "not authenticated");
    return no(409, "still not authenticated");
  }
  await setHarnessEnabled(deps.harnessesPath, harness, true);
  const enabled = deps.harnesses.setEnabled(harness.id, true)!;
  deps.afterEnable?.();
  return ok(enabled);
}

/** `POST /harnesses/:id/disable`. */
export async function disableHarness(deps: HarnessControlDeps, harness: Harness): Promise<Outcome<Harness>> {
  await setHarnessEnabled(deps.harnessesPath, harness, false);
  return ok(deps.harnesses.setEnabled(harness.id, false)!);
}

/** `POST /harnesses/:id/model`: sets or (undefined) clears the harness's
 *  default model. Refuses (400) a model outside the harness's cached
 *  list, when there is one; an empty cache has no opinion. */
export async function setHarnessDefaultModel(deps: HarnessControlDeps, harness: Harness, model: string | undefined): Promise<Outcome<Harness>> {
  if (model !== undefined) {
    const cache = await readModelsCache(deps.modelsCachePath);
    const availableModels = cache[harness.id]?.models ?? [];
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      return no(400, `model "${model}" is not in the known model list for harness "${harness.id}"`);
    }
  }
  await setHarnessModel(deps.harnessesPath, harness, model);
  return ok(deps.harnesses.setModel(harness.id, model)!);
}

// ---------- MCP servers ----------

export interface McpControlDeps {
  mcpServers: McpServerPool;
  mcpServersPath: string;
  reachability: CheckMcpServerReachableOptions;
}

/** `POST /mcp-servers/:id/enable`: only for real, after a reachability
 *  re-check; refuses (409) with the reason otherwise. */
export async function enableMcpServer(deps: McpControlDeps, server: McpServer): Promise<Outcome<McpServer>> {
  const { reachable, reason } = await checkMcpServerReachable(server, deps.reachability);
  if (!reachable) {
    deps.mcpServers.setEnabled(server.id, false, reason ?? "not reachable");
    return no(409, reason ?? "not reachable");
  }
  await setMcpServerEnabled(deps.mcpServersPath, server, true);
  return ok(deps.mcpServers.setEnabled(server.id, true)!);
}

/** `POST /mcp-servers/:id/disable`. */
export async function disableMcpServer(deps: McpControlDeps, server: McpServer): Promise<Outcome<McpServer>> {
  await setMcpServerEnabled(deps.mcpServersPath, server, false);
  return ok(deps.mcpServers.setEnabled(server.id, false)!);
}

/** `POST /mcp-servers/:id/tools/:tool/trust`: 404 for a tool the server
 *  doesn't have, 400 for a trust that isn't one of the two. */
export async function setMcpToolTrust(deps: McpControlDeps, server: McpServer, toolName: string, trust: unknown): Promise<Outcome<McpServer>> {
  if (!server.tools.some((t) => t.name === toolName)) return no(404, "not found");
  if (trust !== "auto" && trust !== "approval-required") {
    return no(400, `trust must be "auto" or "approval-required", got ${JSON.stringify(trust)}`);
  }
  await setMcpServerToolTrust(deps.mcpServersPath, server, toolName, trust);
  return ok(deps.mcpServers.setToolTrust(server.id, toolName, trust)!);
}

// ---------- schedules ----------

/** The `/schedules` routes and (later) Ask's schedule actions share
 *  these (docs/SDD-schedules.md §3.5, §3.9). */
export interface ScheduleControlDeps {
  schedules: ScheduleStore;
  runner: ScheduleRunner;
  /** The clock previews count from; the runner and store keep their own. */
  now?: () => Date;
}

/** A schedule as the API shows it: plus its cadence in words and the
 *  status of its last run card (null when there is none). */
export type ScheduleView = ScheduleDef & { cadence: string; lastRunStatus: TaskCard["status"] | null };

export interface SchedulePreview {
  valid: boolean;
  error?: string;
  cadence: string;
  /** The next 5 runs, ISO UTC; [] when invalid. */
  next: string[];
}

const CREATE_FIELDS = new Set(["name", "kind", "pipelineId", "input", "repo", "taskTemplate", "cron", "timezone", "enabled", "catchUpHours"]);
const PATCH_FIELDS = new Set(["name", "cron", "timezone", "enabled", "input", "repo", "taskTemplate", "catchUpHours"]);

function bodyObject(body: unknown, allowed: Set<string>, fixed: string[] = []): Outcome<Record<string, unknown>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return no(400, "body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (fixed.includes(key)) return no(400, `${key} can't be changed; make a new schedule instead`);
    if (!allowed.has(key)) return no(400, `unknown field "${key}"`);
  }
  return ok(body as Record<string, unknown>);
}

/** The store's refusals are 400s with their own message; anything else
 *  is a real failure and is rethrown. */
async function storeOutcome<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ScheduleValidationError) return no(400, e.message);
    throw e;
  }
}

export async function scheduleView(deps: ScheduleControlDeps, s: ScheduleDef): Promise<ScheduleView> {
  return { ...s, cadence: describeCadence(s.cron), lastRunStatus: await deps.runner.lastRunStatus(s) };
}

/** `GET /schedules`. */
export async function listSchedules(deps: ScheduleControlDeps): Promise<ScheduleView[]> {
  return Promise.all((await deps.schedules.list()).map((s) => scheduleView(deps, s)));
}

/** `GET /schedules/:id`. */
export async function getSchedule(deps: ScheduleControlDeps, id: string): Promise<Outcome<ScheduleView>> {
  const s = await deps.schedules.get(id);
  return s ? ok(await scheduleView(deps, s)) : no(404, "not found");
}

/** `POST /schedules`. `timezone` defaults to DEFAULT_SCHEDULE_TIMEZONE;
 *  every other rule is the store's. */
export async function createSchedule(deps: ScheduleControlDeps, body: unknown): Promise<Outcome<ScheduleView>> {
  const b = bodyObject(body, CREATE_FIELDS);
  if (!b.ok) return b;
  const input = { ...b.value, timezone: b.value.timezone ?? DEFAULT_SCHEDULE_TIMEZONE } as unknown as ScheduleInput;
  const created = await storeOutcome(() => deps.schedules.create(input));
  return created.ok ? ok(await scheduleView(deps, created.value)) : created;
}

/** `PATCH /schedules/:id`: any of the PATCH_FIELDS; a new cron, timezone
 *  or enabled recomputes `nextRunAt` (the store's rule). */
export async function updateSchedule(deps: ScheduleControlDeps, id: string, body: unknown): Promise<Outcome<ScheduleView>> {
  if (!(await deps.schedules.get(id))) return no(404, "not found");
  const b = bodyObject(body, PATCH_FIELDS, ["kind", "pipelineId"]);
  if (!b.ok) return b;
  const updated = await storeOutcome(() => deps.schedules.update(id, b.value as SchedulePatch));
  return updated.ok ? ok(await scheduleView(deps, updated.value)) : updated;
}

/** `DELETE /schedules/:id`. Its past run cards stay on the board. */
export async function deleteSchedule(deps: ScheduleControlDeps, id: string): Promise<Outcome<null>> {
  if (!(await deps.schedules.get(id))) return no(404, "not found");
  await deps.schedules.delete(id);
  return ok(null);
}

/** `POST /schedules/:id/run-now`: 409 while the last run is going, 400
 *  when the run couldn't start (recorded on the schedule as `error`). */
export async function runScheduleNow(deps: ScheduleControlDeps, id: string): Promise<Outcome<{ runId: string }>> {
  try {
    const fired = await deps.runner.runNow(id);
    return fired.runId ? ok({ runId: fired.runId }) : no(400, fired.error ?? "the run didn't start");
  } catch (e) {
    if (e instanceof ScheduleNotFoundError) return no(404, "not found");
    if (e instanceof ScheduleOverlapError) return no(409, e.message);
    throw e;
  }
}

/** `GET /schedules/preview`: what the editors show while you type. Never
 *  a 400: an invalid cadence is `valid: false` with the reason. */
export function previewSchedule(cron: unknown, timezone: unknown, now: Date): SchedulePreview {
  const tz = timezone === undefined || timezone === null || timezone === "" ? DEFAULT_SCHEDULE_TIMEZONE : timezone;
  const cadence = typeof cron === "string" ? describeCadence(cron) : "";
  const check = validateSchedule({ cron, timezone: tz }, now);
  if (!check.ok) return { valid: false, error: check.error, cadence, next: [] };
  return { valid: true, cadence, next: nextRuns(cron as string, tz as string, 5, now).map((d) => d.toISOString()) };
}
