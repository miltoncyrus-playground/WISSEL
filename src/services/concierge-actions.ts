// The concierge's output contract and the only gate between what the
// model asks for and what wissel does (docs/SDD-wissel-app.md §3.4, §3.7).
// Pure: no board, no I/O. The model proposes; this decides. Anything not
// on the lists below, or not valid against the board as it is, is
// dropped and named in the reply, never executed.

import type { TaskCard } from "../core/types.ts";
import { validateExtraAllowedTools } from "../core/allowed-tools.ts";
import { cardSettingsRefusal, escalationRefusal, mcpApprovalRefusal, worktreeRefusal } from "./board-actions.ts";

/** Ask's first three: make a card, run a pipeline, point at a card. */
export const BASIC_ACTION_TYPES = ["create_task", "run_pipeline", "show_task"] as const;
export type BasicActionType = (typeof BASIC_ACTION_TYPES)[number];

/** Control actions on one card (or a batch of cards), each named after
 *  the endpoint whose service function it runs (board-actions.ts). */
export const CARD_ACTION_TYPES = [
  "move_task",
  "run_task",
  "retry_task",
  "stop_task",
  "approve_mcp_request",
  "deny_mcp_request",
  "grant_and_retry",
  "abandon_escalation",
  "archive_task",
  "unarchive_task",
  "add_dependency",
  "set_task_harness",
  "merge_task",
  "discard_task",
  "delete_task",
  "grant_allowed_tools",
] as const;
export type CardActionType = (typeof CARD_ACTION_TYPES)[number];

/** Control actions on something other than a card. */
export const OTHER_CONTROL_TYPES = [
  "set_harness_enabled",
  "set_harness_model",
  "set_mcp_server_enabled",
  "trust_mcp_tool",
  "delete_pipeline",
  "remove_project",
] as const;

export const CONTROL_ACTION_TYPES = [...CARD_ACTION_TYPES, ...OTHER_CONTROL_TYPES] as const;
export type ControlActionType = (typeof CONTROL_ACTION_TYPES)[number];

/** Everything Ask may do. Anything else is dropped as disallowed. */
export const ALLOWED_ACTION_TYPES = [...BASIC_ACTION_TYPES, ...CONTROL_ACTION_TYPES] as const;
export type ConciergeActionType = (typeof ALLOWED_ACTION_TYPES)[number];

/** A: runs at once (reversible or low risk). B: waits for a Confirm tap
 *  in the app; the model can never confirm (§3.7). */
export type Tier = "A" | "B";

/** One tier per control action. A type with no entry fails to compile
 *  and fails test/concierge-control.test.ts. */
export const ACTION_TIERS: Record<ControlActionType, Tier> = {
  move_task: "A",
  run_task: "A",
  retry_task: "A",
  stop_task: "A",
  approve_mcp_request: "A",
  deny_mcp_request: "A",
  grant_and_retry: "A",
  abandon_escalation: "A",
  archive_task: "A",
  unarchive_task: "A",
  add_dependency: "A",
  set_task_harness: "A",
  set_harness_enabled: "A",
  set_mcp_server_enabled: "A",
  set_harness_model: "A",
  merge_task: "B",
  discard_task: "B",
  delete_task: "B",
  delete_pipeline: "B",
  grant_allowed_tools: "B",
  trust_mcp_tool: "B",
  remove_project: "B",
};

/** Card actions that take `where: {status}` for "every <status> card". */
export const BATCHABLE: readonly CardActionType[] = [
  "move_task",
  "run_task",
  "retry_task",
  "stop_task",
  "deny_mcp_request",
  "abandon_escalation",
  "archive_task",
  "unarchive_task",
  "delete_task",
];

/** At most this many actions are taken per message; the rest are dropped. */
export const MAX_ACTIONS = 3;
/** A batch expands to at most this many cards; the rest are named. */
export const MAX_BATCH = 10;
/** A batch of more cards than this needs a Confirm, whatever its tier. */
export const CONFIRM_BATCH_OVER = 3;

/** Card title length cap, so a runaway model can't post a novel as a title. */
export const MAX_TITLE_LENGTH = 200;
/** Card body / pipeline input length cap. */
export const MAX_BODY_LENGTH = 8000;
/** Title text shorter than this names no card ("a", "it"). */
export const MIN_TITLE_REF = 3;

/** Where `move_task` may put a card. Running and dispatched are the
 *  orchestrator's to set; escalated, pending-review and no-match are
 *  outcomes, not places. */
export const MOVE_TARGETS = ["inbox", "ready", "review", "done", "failed"] as const satisfies readonly TaskCard["status"][];

const STATUSES: readonly TaskCard["status"][] = ["inbox", "ready", "running", "dispatched", "review", "done", "failed", "no-match", "pending-review", "escalated"];

export type BasicAction =
  | { type: "create_task"; title: string; body: string; labels: string[]; repo?: string }
  | { type: "run_pipeline"; pipelineId: string; name: string; input?: string }
  | { type: "show_task"; id: string };

/** A card action with its targets resolved to full ids. `batch` is true
 *  when it came from `where`, so it confirms over CONFIRM_BATCH_OVER. */
export interface CardControl {
  type: CardActionType;
  tier: Tier;
  taskIds: string[];
  batch: boolean;
  /** move_task: where to. */
  status?: TaskCard["status"];
  /** add_dependency: the card it will wait for. */
  dependsOn?: string;
  /** set_task_harness: a harness id, or null to clear. */
  harness?: string | null;
  /** grant_allowed_tools: what to add to the card's grants. */
  tools?: string[];
}

export type OtherControl =
  | { type: "set_harness_enabled"; tier: Tier; harnessId: string; enabled: boolean }
  | { type: "set_harness_model"; tier: Tier; harnessId: string; model: string | null }
  | { type: "set_mcp_server_enabled"; tier: Tier; serverId: string; enabled: boolean }
  | { type: "trust_mcp_tool"; tier: Tier; serverId: string; tool: string; trust: "auto" | "approval-required" }
  | { type: "delete_pipeline"; tier: Tier; pipelineId: string; name: string }
  | { type: "remove_project"; tier: Tier; projectId: string; name: string };

export type ControlAction = CardControl | OtherControl;
export type ValidAction = BasicAction | ControlAction;

/** A proposed action that was not taken, and why. `type` is what the
 *  model called it (or "unknown" when it had none). `disallowed` is true
 *  only for a type outside ALLOWED_ACTION_TYPES: the eval's "zero
 *  disallowed actions" counts those. `never` marks the never-from-chat
 *  list (secrets, accounts, manifest, pipeline contents, the server).
 *  `question` is the clarifying question for a target that named no
 *  card or several. `text` is the plain sentence the reply shows for a
 *  control action refused on a card it did resolve. */
export interface DroppedAction {
  type: string;
  reason: string;
  disallowed: boolean;
  never?: true;
  question?: string;
  text?: string;
}

export interface ConciergeOutput {
  reply: string;
  actions: unknown[];
}

export interface ContextHarness {
  id: string;
  label: string;
  enabled: boolean;
  model?: string;
}

export interface ContextMcpServer {
  id: string;
  label: string;
  enabled: boolean;
  tools: { name: string; trust: "auto" | "approval-required" }[];
}

/** What validation checks against: the board as it is right now. */
export interface ActionContext {
  /** Registered projects (src/services/projects.ts). */
  projects: { id?: string; name: string; path: string }[];
  pipelines: { id: string; name: string }[];
  /** Labels a chat card may carry (chatLabels, src/services/concierge-context.ts). */
  knownLabels: string[];
  /** Every task id on the board. */
  taskIds: string[];
  /** The agent id a card with these labels would route to confidently,
   *  when that agent needs a repo (write or bash access); undefined
   *  otherwise. Same rule POST /tasks applies. */
  repoRequiredBy(labels: string[]): string | undefined;
  /** True when the pipeline has a step that needs a repo
   *  (stepsNeedingRepo): Ask can't give it one, so it can't run it. */
  pipelineNeedsRepo(pipelineId: string): boolean;
  /** Every card, archived ones too: what control actions resolve
   *  against. Without it no control action on a card can resolve. */
  tasks?: TaskCard[];
  /** True when the card's latest result has a worktree (Merge/Discard). */
  hasWorktree?(taskId: string): boolean;
  harnesses?: ContextHarness[];
  mcpServers?: ContextMcpServer[];
  /** The harness's cached model list; [] when never refreshed (then any
   *  model is accepted, as POST /harnesses/:id/model does). */
  availableModels?(harnessId: string): string[];
  /** False when the server gave Ask no board controls: control actions
   *  are then dropped with a reason. */
  controlsEnabled?: boolean;
}

/** Matches a fenced ```wissel-actions block. Global so the last one wins,
 *  the same as parsePipelineHandoff: a model that shows an example block
 *  before its real one still parses. */
const ACTIONS_BLOCK = /```wissel-actions\s*\n([\s\S]*?)```/g;

/**
 * The only code that turns the concierge's raw final message into a
 * reply and a list of proposed actions. Null when there is no block, the
 * JSON is malformed, `reply` is not a non-empty string, or `actions` is
 * present and not a list. Strict on purpose: a missing block takes no
 * action rather than guessing one from prose.
 */
export function parseConciergeOutput(raw: string): ConciergeOutput | null {
  const matches = [...raw.matchAll(ACTIONS_BLOCK)];
  if (matches.length === 0) return null;
  let candidate: unknown;
  try {
    candidate = JSON.parse(matches[matches.length - 1]![1]!.trim());
  } catch {
    return null;
  }
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
  const { reply, actions } = candidate as Record<string, unknown>;
  if (typeof reply !== "string" || reply.trim() === "") return null;
  if (actions !== undefined && !Array.isArray(actions)) return null;
  return { reply: reply.trim(), actions: (actions as unknown[] | undefined) ?? [] };
}

/** The raw text minus any fenced block, for a reply when the block is
 *  missing or broken: the prose is still worth showing, the JSON isn't. */
export function proseOf(raw: string): string {
  return raw.replace(/```[\s\S]*?(```|$)/g, "").trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** A task id from a full id or a unique prefix of at least 8 characters
 *  (the id8 the context shows). Undefined when it names nothing or more
 *  than one card. */
export function resolveTaskId(ref: string, taskIds: string[]): string | undefined {
  const r = ref.trim().toLowerCase();
  if (taskIds.includes(r)) return r;
  if (r.length < 8) return undefined;
  const hits = taskIds.filter((id) => id.toLowerCase().startsWith(r));
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------- target resolution (§3.7: in code, never by the model) ----------

export type CardMatch = { ok: true; task: TaskCard } | { ok: false; reason: "none" | "ambiguous"; candidates: TaskCard[] };

/** "'Feed and Stories' (card 2f0cd188)": how the reply names a card. */
export function cardName(t: Pick<TaskCard, "id" | "title">): string {
  return `'${t.title}' (card ${t.id.slice(0, 8)})`;
}

const ID_REF = /^[0-9a-f][0-9a-f-]{7,}$/i;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/['"`‘’“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** A card a title can name: not a pipeline step (its run's root stands
 *  for it), not replaced by a retry, and archived only when `archived`. */
function nameable(t: TaskCard, archived: boolean): boolean {
  return t.pipelineRunId === undefined && !t.supersededBy && Boolean(t.archivedAt) === archived;
}

/**
 * The one card `ref` names: an id prefix of 8+ characters (any card), or
 * title text: an exact title (case and quotes ignored) first, else the
 * one title that contains it as whole words. `archived` picks archived
 * cards instead of live ones, for unarchive. Zero or several matches is
 * not a match.
 */
export function resolveCard(ref: string, tasks: readonly TaskCard[], archived = false): CardMatch {
  const r = ref.trim();
  if (ID_REF.test(r)) {
    const lower = r.toLowerCase();
    const hits = tasks.filter((t) => t.id.toLowerCase().startsWith(lower));
    if (hits.length === 1) return { ok: true, task: hits[0]! };
    if (hits.length > 1) return { ok: false, reason: "ambiguous", candidates: hits };
  }
  const n = norm(r);
  if (n.length < MIN_TITLE_REF) return { ok: false, reason: "none", candidates: [] };
  const pool = tasks.filter((t) => nameable(t, archived));
  const exact = pool.filter((t) => norm(t.title) === n);
  if (exact.length === 1) return { ok: true, task: exact[0]! };
  if (exact.length > 1) return { ok: false, reason: "ambiguous", candidates: exact };
  // Whole words only: "all" must not name "Install the linter".
  const words = new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u");
  const contains = pool.filter((t) => words.test(norm(t.title)));
  if (contains.length === 1) return { ok: true, task: contains[0]! };
  return { ok: false, reason: contains.length ? "ambiguous" : "none", candidates: contains };
}

/** The clarifying question for a target that named zero or several cards. */
export function clarifyingQuestion(ref: string, match: Extract<CardMatch, { ok: false }>, verb: string): string {
  if (match.reason === "none") return `Which card should I ${verb}? No card matches "${ref.trim()}".`;
  const shown = match.candidates.slice(0, 5).map(cardName);
  const more = match.candidates.length > 5 ? `, or one of ${match.candidates.length - 5} more` : "";
  return `Which card should I ${verb}: ${shown.slice(0, -1).join(", ")}${shown.length > 1 ? " or " : ""}${shown[shown.length - 1]}${more}?`;
}

// ---------- preconditions (the endpoints' own, never looser) ----------

/** What a card action's extra fields resolved to. */
type CardExtra = Pick<CardControl, "status" | "dependsOn" | "harness" | "tools">;

/** True when `from` already waits, directly or through others, on `to`. */
function dependsOnTransitively(from: string, to: string, byId: Map<string, TaskCard>): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}

/**
 * Why `type` can't be done to `task` right now, or undefined when it
 * can. Uses board-actions.ts's predicates (the routes' own checks) and
 * adds what the board's UI enforces by only showing a button in one
 * state: Merge/Discard in review, Run while not running, and so on.
 */
export function cardRefusal(type: CardActionType, task: TaskCard, extra: CardExtra, ctx: ActionContext): string | undefined {
  const running = task.status === "running" || task.status === "dispatched";
  if (type === "unarchive_task") return task.archivedAt ? undefined : "it is not archived";
  if (task.archivedAt) return "it is archived; unarchive it first";
  switch (type) {
    case "move_task":
      if (running) return `it is ${task.status}; stop it instead`;
      if (task.status === extra.status) return `it is already ${task.status}`;
      if (extra.status === "done" && ctx.hasWorktree?.(task.id)) return "it has a worktree; merge it instead";
      return undefined;
    case "run_task":
      if (running) return `it is already ${task.status}`;
      if (task.supersededBy) return `it was replaced by card ${task.supersededBy.slice(0, 8)}; run that one`;
      return undefined;
    case "retry_task":
      if (task.status !== "failed") return `it is ${task.status}, not failed`;
      if (task.supersededBy) return `it was replaced by card ${task.supersededBy.slice(0, 8)}; retry that one`;
      return undefined;
    case "stop_task":
      return running ? undefined : `it is ${task.status}, not running`;
    case "approve_mcp_request":
    case "deny_mcp_request":
      return mcpApprovalRefusal(task);
    case "grant_and_retry":
      return escalationRefusal(task) ?? (task.suggestedGrants?.length ? undefined : "it has no suggested grants; name the tools on the board");
    case "abandon_escalation":
      return escalationRefusal(task);
    case "archive_task":
      return undefined;
    case "add_dependency": {
      const dep = extra.dependsOn!;
      if (dep === task.id) return "a card can't wait for itself";
      if (task.dependsOn?.includes(dep)) return "it already waits for that card";
      const byId = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
      if (dependsOnTransitively(dep, task.id, byId)) return "that card already waits for it, so this would be a loop";
      return undefined;
    }
    case "set_task_harness":
      if (extra.harness && !(ctx.harnesses ?? []).some((h) => h.id === extra.harness)) return `unknown harness "${extra.harness}"`;
      return cardSettingsRefusal(task, "harness");
    case "merge_task":
    case "discard_task":
      if (task.status !== "review" || task.pendingMcpApproval) return `it is ${task.pendingMcpApproval ? "waiting on an MCP approval" : task.status}, not in review`;
      return ctx.hasWorktree?.(task.id) ? undefined : worktreeRefusal(undefined, type === "merge_task" ? "merge" : "discard");
    case "delete_task":
      return running ? `it is ${task.status}; stop it first` : undefined;
    case "grant_allowed_tools": {
      const refused = cardSettingsRefusal(task, "tools");
      if (refused) return refused;
      const merged = validateExtraAllowedTools([...(task.extraAllowedTools ?? []), ...(extra.tools ?? [])]);
      return merged.ok ? undefined : merged.error;
    }
  }
}

// ---------- checking one proposed action ----------

/** `overflow`: a batch's cards past MAX_BATCH, named in the reply. */
type Checked = { ok: true; action: ValidAction; overflow?: number } | { ok: false; drop: Omit<DroppedAction, "type"> };

const refuse = (reason: string, extra: Partial<DroppedAction> = {}): Checked => ({ ok: false, drop: { reason, disallowed: false, ...extra } });

function checkCreateTask(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.title)) return refuse("a card needs a title");
  const title = a.title.trim();
  if (title.length > MAX_TITLE_LENGTH) return refuse(`the title is longer than ${MAX_TITLE_LENGTH} characters`);
  if (a.body !== undefined && typeof a.body !== "string") return refuse("the body must be text");
  const body = (a.body as string | undefined)?.trim() ?? "";
  if (body.length > MAX_BODY_LENGTH) return refuse(`the body is longer than ${MAX_BODY_LENGTH} characters`);
  if (!Array.isArray(a.labels) || a.labels.length === 0 || !a.labels.every(nonEmptyString)) {
    return refuse("a card needs at least one label");
  }
  const labels = [...new Set((a.labels as string[]).map((l) => l.trim()))];
  const unknown = labels.filter((l) => !ctx.knownLabels.includes(l));
  if (unknown.length > 0) return refuse(`unknown label ${unknown.map((l) => `"${l}"`).join(", ")}`);

  let repo: string | undefined;
  if (a.repo !== undefined && a.repo !== null && a.repo !== "") {
    if (typeof a.repo !== "string") return refuse("repo must be a project path");
    // A registered project's path, or its exact name, stored as the path.
    const project = ctx.projects.find((p) => p.path === a.repo) ?? ctx.projects.find((p) => p.name === a.repo);
    if (!project) return refuse(`"${a.repo}" is not a registered project`);
    repo = project.path;
  }
  if (!repo) {
    const agent = ctx.repoRequiredBy(labels);
    if (agent) return refuse(`it would go to ${agent}, which needs a repo, and none was given`);
  }
  return { ok: true, action: { type: "create_task", title, body, labels, ...(repo ? { repo } : {}) } };
}

function checkRunPipeline(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.name)) return refuse("no pipeline named");
  const name = a.name.trim();
  const lower = name.toLowerCase();
  const pipeline = ctx.pipelines.find((p) => p.id === name) ?? ctx.pipelines.find((p) => p.name.toLowerCase() === lower);
  if (!pipeline) return refuse(`there is no pipeline called "${name}"`);
  if (a.input !== undefined && a.input !== null && typeof a.input !== "string") return refuse("the input must be text");
  const input = typeof a.input === "string" && a.input.trim() !== "" ? a.input.trim() : undefined;
  if (input && input.length > MAX_BODY_LENGTH) return refuse(`the input is longer than ${MAX_BODY_LENGTH} characters`);
  if (ctx.pipelineNeedsRepo(pipeline.id)) return refuse(`"${pipeline.name}" needs a repo; run it from the board`);
  return { ok: true, action: { type: "run_pipeline", pipelineId: pipeline.id, name: pipeline.name, ...(input ? { input } : {}) } };
}

function checkShowTask(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.id)) return refuse("no card id given");
  const id = resolveTaskId(a.id, ctx.taskIds);
  if (!id) return refuse(`no single card matches "${a.id.trim()}"`);
  return { ok: true, action: { type: "show_task", id } };
}

/** The verb a sentence uses for an action: "retry", "merge"... */
export const ACTION_VERBS: Record<ControlActionType, string> = {
  move_task: "move",
  run_task: "run",
  retry_task: "retry",
  stop_task: "stop",
  approve_mcp_request: "approve the MCP call on",
  deny_mcp_request: "deny the MCP call on",
  grant_and_retry: "grant the suggested tools to and retry",
  abandon_escalation: "abandon",
  archive_task: "archive",
  unarchive_task: "unarchive",
  add_dependency: "add a dependency to",
  set_task_harness: "set the harness of",
  merge_task: "merge",
  discard_task: "discard",
  delete_task: "delete",
  grant_allowed_tools: "grant tools to",
  set_harness_enabled: "change harness",
  set_harness_model: "set the model of harness",
  set_mcp_server_enabled: "change MCP server",
  trust_mcp_tool: "change the trust of",
  delete_pipeline: "delete pipeline",
  remove_project: "remove project",
};

/** The card action's own fields (status, dependsOn, harness, tools),
 *  checked, or why not. */
function cardExtra(type: CardActionType, a: Record<string, unknown>, ctx: ActionContext): { ok: true; extra: CardExtra } | { ok: false; drop: Omit<DroppedAction, "type"> } {
  if (type === "move_task") {
    if (typeof a.status !== "string" || !(MOVE_TARGETS as readonly string[]).includes(a.status)) {
      return { ok: false, drop: { reason: `a card can be moved to ${MOVE_TARGETS.join(", ")}`, disallowed: false } };
    }
    return { ok: true, extra: { status: a.status as TaskCard["status"] } };
  }
  if (type === "add_dependency") {
    const ref = a.dependsOn ?? a.on;
    if (!nonEmptyString(ref)) return { ok: false, drop: { reason: "no card to wait for", disallowed: false } };
    const match = resolveCard(ref, ctx.tasks ?? []);
    if (!match.ok) return { ok: false, drop: { reason: `no single card matches "${ref.trim()}"`, disallowed: false, question: clarifyingQuestion(ref, match, "make it wait for") } };
    return { ok: true, extra: { dependsOn: match.task.id } };
  }
  if (type === "set_task_harness") {
    if (a.harness === null || a.harness === "") return { ok: true, extra: { harness: null } };
    if (!nonEmptyString(a.harness)) return { ok: false, drop: { reason: "no harness named (null clears it)", disallowed: false } };
    const h = findHarness(a.harness, ctx);
    if (!h) return { ok: false, drop: { reason: `there is no harness called "${a.harness.trim()}"`, disallowed: false } };
    return { ok: true, extra: { harness: h.id } };
  }
  if (type === "grant_allowed_tools") {
    const v = validateExtraAllowedTools(a.tools);
    if (!v.ok) return { ok: false, drop: { reason: v.error, disallowed: false } };
    if (v.tools.length === 0) return { ok: false, drop: { reason: "no tools named", disallowed: false } };
    return { ok: true, extra: { tools: v.tools } };
  }
  return { ok: true, extra: {} };
}

function checkCardAction(type: CardActionType, a: Record<string, unknown>, ctx: ActionContext): Checked {
  const verb = ACTION_VERBS[type];
  const extraChecked = cardExtra(type, a, ctx);
  if (!extraChecked.ok) return { ok: false, drop: extraChecked.drop };
  const extra = extraChecked.extra;
  const tasks = ctx.tasks ?? [];
  const ref = a.card ?? a.id;
  const archived = type === "unarchive_task";

  if (a.where !== undefined) {
    if (ref !== undefined) return refuse("name one card or a status, not both");
    if (!BATCHABLE.includes(type)) return refuse(`"${verb}" takes one card at a time; name it`);
    const status = isRecord(a.where) ? a.where.status : undefined;
    if (typeof status !== "string" || !STATUSES.includes(status as TaskCard["status"])) return refuse("where needs a card status");
    const eligible = tasks.filter((t) => nameable(t, archived) && t.status === status && !cardRefusal(type, t, extra, ctx));
    if (eligible.length === 0) return refuse(`no ${status} card can be ${verbPast(type)}`);
    const taken = eligible.slice(0, MAX_BATCH);
    const left = eligible.length - taken.length;
    const action: CardControl = { type, tier: ACTION_TIERS[type], taskIds: taken.map((t) => t.id), batch: true, ...extra };
    return { ok: true, action, ...(left > 0 ? { overflow: left } : {}) };
  }

  if (!nonEmptyString(ref)) return refuse(`no card named; say which card to ${verb}`, { question: `Which card should I ${verb}?` });
  const match = resolveCard(ref, tasks, archived);
  if (!match.ok) return refuse(`no single card matches "${ref.trim()}"`, { question: clarifyingQuestion(ref, match, verb) });
  const why = cardRefusal(type, match.task, extra, ctx);
  if (why) return refuse(why, { text: `Did not ${verb} ${cardName(match.task)}: ${why}.` });
  return { ok: true, action: { type, tier: ACTION_TIERS[type], taskIds: [match.task.id], batch: false, ...extra } };
}

/** "retried", "merged"... for a batch that found nothing. */
function verbPast(type: CardActionType): string {
  const v: Partial<Record<CardActionType, string>> = {
    move_task: "moved",
    run_task: "run",
    retry_task: "retried",
    stop_task: "stopped",
    deny_mcp_request: "denied",
    abandon_escalation: "abandoned",
    archive_task: "archived",
    unarchive_task: "unarchived",
    delete_task: "deleted",
  };
  return v[type] ?? "changed";
}

function findHarness(ref: string, ctx: ActionContext): ContextHarness | undefined {
  const r = ref.trim().toLowerCase();
  const all = ctx.harnesses ?? [];
  return all.find((h) => h.id.toLowerCase() === r) ?? all.find((h) => h.label.toLowerCase() === r);
}

function findMcpServer(ref: string, ctx: ActionContext): ContextMcpServer | undefined {
  const r = ref.trim().toLowerCase();
  const all = ctx.mcpServers ?? [];
  return all.find((s) => s.id.toLowerCase() === r) ?? all.find((s) => s.label.toLowerCase() === r);
}

function checkOther(type: (typeof OTHER_CONTROL_TYPES)[number], a: Record<string, unknown>, ctx: ActionContext): Checked {
  const tier = ACTION_TIERS[type];
  if (type === "set_harness_enabled" || type === "set_harness_model") {
    if (!nonEmptyString(a.harness)) return refuse("no harness named");
    const h = findHarness(a.harness, ctx);
    if (!h) return refuse(`there is no harness called "${a.harness.trim()}"`);
    if (type === "set_harness_enabled") {
      if (typeof a.enabled !== "boolean") return refuse("say enabled: true or false");
      if (h.enabled === a.enabled) return refuse(`harness ${h.id} is already ${h.enabled ? "enabled" : "disabled"}`);
      return { ok: true, action: { type, tier, harnessId: h.id, enabled: a.enabled } };
    }
    if (a.model !== null && a.model !== "" && !nonEmptyString(a.model)) return refuse("no model named (null clears it)");
    const model = nonEmptyString(a.model) ? a.model.trim() : null;
    const known = ctx.availableModels?.(h.id) ?? [];
    if (model && known.length > 0 && !known.includes(model)) return refuse(`model "${model}" is not in the known model list for harness "${h.id}"`);
    if ((h.model ?? null) === model) return refuse(`harness ${h.id} already uses ${model ?? "the agent default"}`);
    return { ok: true, action: { type, tier, harnessId: h.id, model } };
  }
  if (type === "set_mcp_server_enabled" || type === "trust_mcp_tool") {
    if (!nonEmptyString(a.server)) return refuse("no MCP server named");
    const s = findMcpServer(a.server, ctx);
    if (!s) return refuse(`there is no MCP server called "${a.server.trim()}"`);
    if (type === "set_mcp_server_enabled") {
      if (typeof a.enabled !== "boolean") return refuse("say enabled: true or false");
      if (s.enabled === a.enabled) return refuse(`MCP server ${s.id} is already ${s.enabled ? "enabled" : "disabled"}`);
      return { ok: true, action: { type, tier, serverId: s.id, enabled: a.enabled } };
    }
    if (!nonEmptyString(a.tool)) return refuse("no tool named");
    const tool = s.tools.find((t) => t.name === (a.tool as string).trim());
    if (!tool) return refuse(`MCP server ${s.id} has no tool "${(a.tool as string).trim()}"`);
    if (a.trust !== "auto" && a.trust !== "approval-required") return refuse('trust must be "auto" or "approval-required"');
    if (tool.trust === a.trust) return refuse(`${s.id}/${tool.name} is already ${tool.trust}`);
    return { ok: true, action: { type, tier, serverId: s.id, tool: tool.name, trust: a.trust } };
  }
  if (type === "delete_pipeline") {
    if (!nonEmptyString(a.pipeline)) return refuse("no pipeline named");
    const r = a.pipeline.trim().toLowerCase();
    const p = ctx.pipelines.find((x) => x.id === a.pipeline) ?? ctx.pipelines.find((x) => x.name.toLowerCase() === r);
    if (!p) return refuse(`there is no pipeline called "${a.pipeline.trim()}"`);
    return { ok: true, action: { type, tier, pipelineId: p.id, name: p.name } };
  }
  // remove_project
  if (!nonEmptyString(a.project)) return refuse("no project named");
  const r = a.project.trim();
  const p = ctx.projects.find((x) => x.id === r || x.path === r) ?? ctx.projects.find((x) => x.name.toLowerCase() === r.toLowerCase());
  if (!p || !p.id) return refuse(`there is no project called "${r}"`);
  return { ok: true, action: { type, tier, projectId: p.id, name: p.name } };
}

// ---------- never from chat ----------

/** The never-from-chat list (§3.7), by what an action's name is about.
 *  Checked only for types outside ALLOWED_ACTION_TYPES. */
const NEVER_RULES: [RegExp, string][] = [
  [/secret|credential|password|passwd|token|api_?key|account|login|logout|auth|env/i, "secrets, accounts and credentials never change from chat; do it by hand"],
  [/manifest|agent/i, "agents/manifest.yaml is edited by hand, never from chat"],
  [/pipeline/i, "a pipeline's contents are edited in the board's pipeline editor, never from chat"],
  [/restart|shutdown|shut_down|reboot|stop_server|kill|server_stop|stop_wissel|exit/i, "the server is restarted by hand, never from chat"],
];

/** The never-from-chat reason for a type, or undefined. */
export function neverReason(type: string): string | undefined {
  return NEVER_RULES.find(([re]) => re.test(type))?.[1];
}

// ---------- the whole list ----------

/** Two actions are the same when they'd do the same thing twice. */
function sameAction(x: ValidAction, y: ValidAction): boolean {
  return JSON.stringify(x) === JSON.stringify(y);
}

export function isControl(a: ValidAction): a is ControlAction {
  return "tier" in a;
}

export function isCardControl(a: ControlAction): a is CardControl {
  return "taskIds" in a;
}

/** A control action that waits for a Confirm tap: Tier B, or a batch
 *  of more than CONFIRM_BATCH_OVER cards. */
export function needsConfirm(a: ControlAction): boolean {
  return a.tier === "B" || (isCardControl(a) && a.batch && a.taskIds.length > CONFIRM_BATCH_OVER);
}

/**
 * Checks every proposed action in order. A valid one is kept until
 * MAX_ACTIONS are kept; after that, and for anything invalid or not on
 * the allowed list, it is dropped with a reason. A repeat of a kept
 * action is dropped too, so "create it" twice makes one card.
 */
export function validateActions(proposed: unknown[], ctx: ActionContext): { valid: ValidAction[]; dropped: DroppedAction[] } {
  const valid: ValidAction[] = [];
  const dropped: DroppedAction[] = [];
  for (const raw of proposed) {
    const type = isRecord(raw) && typeof raw.type === "string" && raw.type.trim() ? raw.type.trim() : "unknown";
    if (!isRecord(raw) || !(ALLOWED_ACTION_TYPES as readonly string[]).includes(type)) {
      const never = neverReason(type);
      dropped.push(never ? { type, reason: never, disallowed: true, never: true } : { type, reason: "not something Ask can do; use the board", disallowed: true });
      continue;
    }
    let checked: Checked;
    if (type === "create_task") checked = checkCreateTask(raw, ctx);
    else if (type === "run_pipeline") checked = checkRunPipeline(raw, ctx);
    else if (type === "show_task") checked = checkShowTask(raw, ctx);
    else if (ctx.controlsEnabled === false) checked = refuse("board controls are not set up on this server; use the board");
    else if ((CARD_ACTION_TYPES as readonly string[]).includes(type)) checked = checkCardAction(type as CardActionType, raw, ctx);
    else checked = checkOther(type as (typeof OTHER_CONTROL_TYPES)[number], raw, ctx);

    if (!checked.ok) {
      dropped.push({ type, ...checked.drop });
      continue;
    }
    const overflow = checked.overflow;
    if (valid.some((v) => sameAction(v, checked.action))) {
      dropped.push({ type, reason: "the same action twice", disallowed: false });
      continue;
    }
    if (valid.length >= MAX_ACTIONS) {
      dropped.push({ type, reason: `over the limit of ${MAX_ACTIONS} actions per message`, disallowed: false });
      continue;
    }
    valid.push(checked.action);
    if (overflow) dropped.push({ type, reason: `${overflow} more card${overflow === 1 ? "" : "s"} left out: at most ${MAX_BATCH} at a time; ask again for the rest`, disallowed: false });
  }
  return { valid, dropped };
}

/**
 * The same checks again for a control action already validated, on the
 * board as it is now (a Confirm can come minutes later). Card actions
 * keep the cards that still pass and name the rest; other actions pass
 * or fail whole.
 */
export function recheckControl(action: ControlAction, ctx: ActionContext): { action: ControlAction | null; refused: { taskId?: string; reason: string }[] } {
  if (isCardControl(action)) {
    const byId = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
    const keep: string[] = [];
    const refused: { taskId?: string; reason: string }[] = [];
    if (action.dependsOn && !byId.has(action.dependsOn)) return { action: null, refused: action.taskIds.map((taskId) => ({ taskId, reason: "the card to wait for is gone" })) };
    for (const id of action.taskIds) {
      const task = byId.get(id);
      const why = task ? cardRefusal(action.type, task, action, ctx) : "the card is gone";
      if (why) refused.push({ taskId: id, reason: why });
      else keep.push(id);
    }
    return { action: keep.length ? { ...action, taskIds: keep } : null, refused };
  }
  const raw: Record<string, unknown> =
    action.type === "set_harness_enabled"
      ? { type: action.type, harness: action.harnessId, enabled: action.enabled }
      : action.type === "set_harness_model"
        ? { type: action.type, harness: action.harnessId, model: action.model }
        : action.type === "set_mcp_server_enabled"
          ? { type: action.type, server: action.serverId, enabled: action.enabled }
          : action.type === "trust_mcp_tool"
            ? { type: action.type, server: action.serverId, tool: action.tool, trust: action.trust }
            : action.type === "delete_pipeline"
              ? { type: action.type, pipeline: action.pipelineId }
              : { type: action.type, project: action.projectId };
  const checked = checkOther(action.type, raw, ctx);
  return checked.ok ? { action: checked.action as ControlAction, refused: [] } : { action: null, refused: [{ reason: checked.drop.reason }] };
}

const ACTION_WORDS: Record<string, string> = {
  create_task: "create a card",
  run_pipeline: "run a pipeline",
  show_task: "show a card",
};

/** The sentences added to the reply for what was left out, or "" when
 *  nothing was: questions first (a target that named no card or
 *  several), then refusals on a resolved card in plain words, then the
 *  rest as a list, one line per action. */
export function droppedNote(dropped: DroppedAction[]): string {
  if (dropped.length === 0) return "";
  const questions = [...new Set(dropped.flatMap((d) => (d.question ? [d.question] : [])))];
  const sentences = dropped.flatMap((d) => (!d.question && d.text ? [d.text] : []));
  const rest = dropped.filter((d) => !d.question && !d.text);
  const parts = [...questions, ...sentences];
  if (rest.length) parts.push(["I left out:", ...rest.map((d) => `- ${ACTION_WORDS[d.type] ?? d.type.replace(/_/g, " ")}: ${d.reason}`)].join("\n"));
  return parts.join("\n");
}
