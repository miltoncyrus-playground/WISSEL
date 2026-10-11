// The concierge's output contract and the only gate between what the
// model asks for and what wissel does (docs/SDD-wissel-app.md §3.4).
// Pure: no board, no I/O. The model proposes; this decides. Anything not
// on the short list below, or not valid against the board as it is, is
// dropped and named in the reply, never executed.

/** The three things Ask may do. Everything else (merge, delete, archive,
 *  retry, approve, harness or settings changes) stays on the board. */
export const ALLOWED_ACTION_TYPES = ["create_task", "run_pipeline", "show_task"] as const;
export type ConciergeActionType = (typeof ALLOWED_ACTION_TYPES)[number];

/** At most this many actions are taken per message; the rest are dropped. */
export const MAX_ACTIONS = 3;

/** Card title length cap, so a runaway model can't post a novel as a title. */
export const MAX_TITLE_LENGTH = 200;
/** Card body / pipeline input length cap. */
export const MAX_BODY_LENGTH = 8000;

export type ValidAction =
  | { type: "create_task"; title: string; body: string; labels: string[]; repo?: string }
  | { type: "run_pipeline"; pipelineId: string; name: string; input?: string }
  | { type: "show_task"; id: string };

/** A proposed action that was not taken, and why. `type` is what the
 *  model called it (or "unknown" when it had none). `disallowed` is true
 *  only for a type outside ALLOWED_ACTION_TYPES: the eval's "zero
 *  disallowed actions" counts those. */
export interface DroppedAction {
  type: string;
  reason: string;
  disallowed: boolean;
}

export interface ConciergeOutput {
  reply: string;
  actions: unknown[];
}

/** What validation checks against: the board as it is right now. */
export interface ActionContext {
  /** Registered projects (src/services/projects.ts). */
  projects: { name: string; path: string }[];
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

type Checked = { ok: true; action: ValidAction } | { ok: false; reason: string };

function checkCreateTask(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.title)) return { ok: false, reason: "a card needs a title" };
  const title = a.title.trim();
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, reason: `the title is longer than ${MAX_TITLE_LENGTH} characters` };
  if (a.body !== undefined && typeof a.body !== "string") return { ok: false, reason: "the body must be text" };
  const body = (a.body as string | undefined)?.trim() ?? "";
  if (body.length > MAX_BODY_LENGTH) return { ok: false, reason: `the body is longer than ${MAX_BODY_LENGTH} characters` };
  if (!Array.isArray(a.labels) || a.labels.length === 0 || !a.labels.every(nonEmptyString)) {
    return { ok: false, reason: "a card needs at least one label" };
  }
  const labels = [...new Set((a.labels as string[]).map((l) => l.trim()))];
  const unknown = labels.filter((l) => !ctx.knownLabels.includes(l));
  if (unknown.length > 0) return { ok: false, reason: `unknown label ${unknown.map((l) => `"${l}"`).join(", ")}` };

  let repo: string | undefined;
  if (a.repo !== undefined && a.repo !== null && a.repo !== "") {
    if (typeof a.repo !== "string") return { ok: false, reason: "repo must be a project path" };
    // A registered project's path, or its exact name, stored as the path.
    const project = ctx.projects.find((p) => p.path === a.repo) ?? ctx.projects.find((p) => p.name === a.repo);
    if (!project) return { ok: false, reason: `"${a.repo}" is not a registered project` };
    repo = project.path;
  }
  if (!repo) {
    const agent = ctx.repoRequiredBy(labels);
    if (agent) return { ok: false, reason: `it would go to ${agent}, which needs a repo, and none was given` };
  }
  return { ok: true, action: { type: "create_task", title, body, labels, ...(repo ? { repo } : {}) } };
}

function checkRunPipeline(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.name)) return { ok: false, reason: "no pipeline named" };
  const name = a.name.trim();
  const lower = name.toLowerCase();
  const pipeline = ctx.pipelines.find((p) => p.id === name) ?? ctx.pipelines.find((p) => p.name.toLowerCase() === lower);
  if (!pipeline) return { ok: false, reason: `there is no pipeline called "${name}"` };
  if (a.input !== undefined && a.input !== null && typeof a.input !== "string") return { ok: false, reason: "the input must be text" };
  const input = typeof a.input === "string" && a.input.trim() !== "" ? a.input.trim() : undefined;
  if (input && input.length > MAX_BODY_LENGTH) return { ok: false, reason: `the input is longer than ${MAX_BODY_LENGTH} characters` };
  if (ctx.pipelineNeedsRepo(pipeline.id)) return { ok: false, reason: `"${pipeline.name}" needs a repo; run it from the board` };
  return { ok: true, action: { type: "run_pipeline", pipelineId: pipeline.id, name: pipeline.name, ...(input ? { input } : {}) } };
}

function checkShowTask(a: Record<string, unknown>, ctx: ActionContext): Checked {
  if (!nonEmptyString(a.id)) return { ok: false, reason: "no card id given" };
  const id = resolveTaskId(a.id, ctx.taskIds);
  if (!id) return { ok: false, reason: `no single card matches "${a.id.trim()}"` };
  return { ok: true, action: { type: "show_task", id } };
}

/** Two actions are the same when they'd do the same thing twice. */
function sameAction(x: ValidAction, y: ValidAction): boolean {
  return JSON.stringify(x) === JSON.stringify(y);
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
      dropped.push({ type, reason: "not something Ask can do; use the board", disallowed: true });
      continue;
    }
    const checked =
      type === "create_task" ? checkCreateTask(raw, ctx) : type === "run_pipeline" ? checkRunPipeline(raw, ctx) : checkShowTask(raw, ctx);
    if (!checked.ok) {
      dropped.push({ type, reason: checked.reason, disallowed: false });
      continue;
    }
    if (valid.some((v) => sameAction(v, checked.action))) {
      dropped.push({ type, reason: "the same action twice", disallowed: false });
      continue;
    }
    if (valid.length >= MAX_ACTIONS) {
      dropped.push({ type, reason: `over the limit of ${MAX_ACTIONS} actions per message`, disallowed: false });
      continue;
    }
    valid.push(checked.action);
  }
  return { valid, dropped };
}

const ACTION_WORDS: Record<string, string> = {
  create_task: "create a card",
  run_pipeline: "run a pipeline",
  show_task: "show a card",
};

/** The sentence added to the reply for what was left out, or "" when
 *  nothing was. Plain words, one line per action. */
export function droppedNote(dropped: DroppedAction[]): string {
  if (dropped.length === 0) return "";
  const lines = dropped.map((d) => `- ${ACTION_WORDS[d.type] ?? d.type.replace(/_/g, " ")}: ${d.reason}`);
  return ["I left out:", ...lines].join("\n");
}
