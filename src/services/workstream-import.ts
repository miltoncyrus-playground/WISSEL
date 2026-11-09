import type { CardTemplateKind, PrRef } from "../core/types.ts";
import { validateCron, validateTimezone } from "../core/schedule-time.ts";
import type { Board } from "./board.ts";
import { cardRulesError, cardTemplatesError } from "./card-templates.ts";
import type { ProjectStore } from "./projects.ts";
import type { Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * Import (docs/SDD-coordinator.md §7 step 1, `POST /workstreams/:id/import`):
 * a team that already has a coordinator hands over its registry of work
 * items as JSONL (`{ key, cardId?, pr?, sha?, round? }`), its standing
 * rules (the workstream's projects' `cardRules` and `cardTemplates`), its
 * channel cursor and its schedule (the workstream's `digests`).
 *
 * Existing cards get `key`, `pr`, `round` and this `workstreamId` set.
 * NOTHING is created: an item whose `cardId` matches no card is reported
 * under `unknownCards`, an item with no `cardId` under `unplaced`. A key
 * that would end up on two cards of the workstream is refused before
 * anything is written. With `dryRun` the plan comes back unapplied.
 */
export interface ImportItem {
  key: string;
  cardId?: string;
  pr?: PrRef;
  /** The head sha the old coordinator last reviewed: becomes `pr.reviewedSha`. */
  sha?: string;
  round?: number;
}

export type ImportSchedule = { cron: string; timezone: string };
export type ImportRules = { cardRules?: string; cardTemplates?: Partial<Record<CardTemplateKind, string>> };

export interface ImportPlan {
  dryRun: boolean;
  /** Existing cards and the fields each gets. */
  cards: { cardId: string; key: string; round?: number; pr?: PrRef }[];
  /** Items whose cardId matches no card: reported, never invented. */
  unknownCards: { key: string; cardId: string }[];
  /** Keys of items with no cardId: nothing is created for them. */
  unplaced: string[];
  rules?: ImportRules & { projectIds: string[] };
  channelCursor?: string;
  schedule?: ImportSchedule[];
}

export type ImportResult = { ok: true; plan: ImportPlan } | { ok: false; status: 400; error: string };
export interface ImportDeps {
  board: Board;
  projects: ProjectStore;
  workstreams: WorkstreamStore;
}

type Check<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const ITEM_FIELDS = ["key", "cardId", "pr", "sha", "round"];

function importItem(v: unknown): Check<ImportItem> {
  if (!isRecord(v)) return fail("must be a JSON object");
  if (!isText(v.key)) return fail("key must be a non-empty string");
  const unknown = Object.keys(v).find((k) => !ITEM_FIELDS.includes(k));
  if (unknown) return fail(`unknown field ${unknown}`);
  const item: ImportItem = { key: v.key.trim() };
  if (v.cardId !== undefined) {
    if (!isText(v.cardId)) return fail("cardId must be a non-empty string");
    item.cardId = v.cardId.trim();
  }
  if (v.pr !== undefined) {
    const p = v.pr as Partial<PrRef>;
    if (!isRecord(p) || !Number.isInteger(p.number) || (p.number as number) < 1 || typeof p.url !== "string" || typeof p.head !== "string") {
      return fail("pr must be { number: whole number from 1, url: string, head: string }");
    }
    item.pr = { number: p.number as number, url: p.url, head: p.head };
  }
  if (v.sha !== undefined) {
    if (typeof v.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(v.sha)) return fail("sha must be 7 to 40 hex characters");
    item.sha = v.sha;
  }
  if (v.round !== undefined) {
    if (!Number.isInteger(v.round) || (v.round as number) < 1) return fail("round must be a whole number from 1");
    item.round = v.round as number;
  }
  return { ok: true, value: item };
}

/** The registry: a JSONL string (one object per line, blank lines
 *  skipped) or an already-parsed list. Every refusal names its line. */
export function parseRegistry(registry: unknown): { ok: true; items: ImportItem[] } | { ok: false; error: string } {
  let raw: unknown[];
  if (typeof registry === "string") {
    raw = [];
    for (const line of registry.split("\n")) {
      if (line.trim() === "") continue;
      try {
        raw.push(JSON.parse(line));
      } catch {
        return fail(`registry line ${raw.length + 1} is not JSON`);
      }
    }
  } else if (Array.isArray(registry)) raw = registry;
  else return fail("registry must be a JSONL string or a list of items");
  if (raw.length === 0) return fail("registry is empty");
  const items: ImportItem[] = [];
  for (const [i, v] of raw.entries()) {
    const item = importItem(v);
    if (!item.ok) return fail(`registry line ${i + 1}: ${item.error}`);
    if (items.some((o) => o.key === item.value.key)) return fail(`registry line ${i + 1}: key "${item.value.key}" is listed twice`);
    if (item.value.cardId && items.some((o) => o.cardId === item.value.cardId)) return fail(`registry line ${i + 1}: card ${item.value.cardId} is listed twice`);
    items.push(item.value);
  }
  return { ok: true, items };
}

function rules(v: unknown): Check<ImportRules> {
  if (!isRecord(v)) return fail("rules must be an object with cardRules and/or cardTemplates");
  const unknown = Object.keys(v).find((k) => k !== "cardRules" && k !== "cardTemplates");
  if (unknown) return fail(`rules: unknown field ${unknown}`);
  const out: ImportRules = {};
  if (v.cardRules !== undefined) {
    const error = cardRulesError(v.cardRules);
    if (error) return fail(error);
    out.cardRules = v.cardRules as string;
  }
  if (v.cardTemplates !== undefined) {
    const error = cardTemplatesError(v.cardTemplates);
    if (error) return fail(error);
    out.cardTemplates = v.cardTemplates as ImportRules["cardTemplates"];
  }
  if (out.cardRules === undefined && out.cardTemplates === undefined) return fail("rules must carry cardRules and/or cardTemplates");
  return { ok: true, value: out };
}

function schedule(v: unknown): Check<ImportSchedule[]> {
  const list = Array.isArray(v) ? v : [v];
  const out: ImportSchedule[] = [];
  for (const s of list) {
    if (!isRecord(s)) return fail("schedule must be { cron, timezone } or a list of them");
    const c = validateCron(s.cron);
    if (!c.ok) return fail(`schedule: ${c.error}`);
    const t = validateTimezone(s.timezone);
    if (!t.ok) return fail(`schedule: ${t.error}`);
    out.push({ cron: s.cron as string, timezone: s.timezone as string });
  }
  return { ok: true, value: out };
}

const BODY_FIELDS = ["registry", "rules", "channelCursor", "schedule"];

/** Validates the body, resolves every item against the board, refuses a
 *  collision, and (unless dryRun) writes the plan. */
export async function importWorkstream(ws: Workstream, body: unknown, dryRun: boolean, deps: ImportDeps): Promise<ImportResult> {
  const refuse = (error: string): ImportResult => ({ ok: false, status: 400, error });
  if (!isRecord(body)) return refuse("body must be an object");
  const unknown = Object.keys(body).find((k) => !BODY_FIELDS.includes(k));
  if (unknown) return refuse(`unknown field ${unknown}`);
  const registry = parseRegistry(body.registry);
  if (!registry.ok) return refuse(registry.error);
  const plan: ImportPlan = { dryRun, cards: [], unknownCards: [], unplaced: [] };
  if (body.rules !== undefined) {
    const r = rules(body.rules);
    if (!r.ok) return refuse(r.error);
    if (ws.projects.length === 0) return refuse("rules given but the workstream has no project to carry them");
    plan.rules = { projectIds: ws.projects.map((p) => p.projectId), ...r.value };
  }
  if (body.channelCursor !== undefined) {
    if (typeof body.channelCursor !== "string") return refuse("channelCursor must be a string");
    plan.channelCursor = body.channelCursor;
  }
  if (body.schedule !== undefined) {
    const s = schedule(body.schedule);
    if (!s.ok) return refuse(s.error);
    plan.schedule = s.value;
  }

  // Resolve items. Keys end up unique per workstream: start from the keys
  // the workstream's cards hold today, drop the ones of cards being
  // re-keyed, then place each planned key.
  const held = new Map<string, string>();
  for (const t of await deps.board.list()) if (t.workstreamId === ws.id && t.key) held.set(t.key, t.id);
  const planned: ImportPlan["cards"] = [];
  for (const item of registry.items) {
    if (!item.cardId) {
      plan.unplaced.push(item.key);
      continue;
    }
    const card = await deps.board.get(item.cardId);
    if (!card) {
      plan.unknownCards.push({ key: item.key, cardId: item.cardId });
      continue;
    }
    if (card.workstreamId && card.workstreamId !== ws.id) return refuse(`card ${card.id} belongs to workstream ${card.workstreamId}`);
    const entry: ImportPlan["cards"][number] = { cardId: card.id, key: item.key };
    if (item.round !== undefined) entry.round = item.round;
    const pr = item.pr ?? card.pr;
    if (pr) entry.pr = item.sha ? { ...pr, reviewedSha: item.sha } : pr;
    if (card.key) held.delete(card.key);
    planned.push(entry);
  }
  for (const entry of planned) {
    const holder = held.get(entry.key);
    if (holder && holder !== entry.cardId) return refuse(`key "${entry.key}" is already used in workstream ${ws.id} by card ${holder}`);
    held.set(entry.key, entry.cardId);
  }
  plan.cards = planned;
  if (dryRun) return { ok: true, plan };

  for (const { cardId, ...fields } of plan.cards) await deps.board.updateFields(cardId, { ...fields, workstreamId: ws.id });
  if (plan.rules) {
    const { projectIds, ...settings } = plan.rules;
    for (const id of projectIds) await deps.projects.setSettings(id, settings);
  }
  if (plan.channelCursor !== undefined || plan.schedule) {
    await deps.workstreams.update(ws.id, { ...(plan.channelCursor !== undefined ? { channelCursor: plan.channelCursor } : {}), ...(plan.schedule ? { digests: plan.schedule } : {}) });
  }
  return { ok: true, plan };
}
