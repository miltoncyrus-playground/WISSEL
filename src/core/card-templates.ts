// Card templates and rules (docs/SDD-coordinator.md §4.16, phase 1 card 2).
//
// A project may keep a markdown template per kind of card, with
// placeholders such as {key}, {ticket}, {files} and {review}, and rules
// appended to every card's body (`cardRules`). Starting a card from a
// template renders it, appends the rules, and refuses to start when a
// required placeholder is empty: the pilot once sent a fix round with an
// empty brief, and this is what would have stopped it.
//
// Placeholder syntax:
// - {name}: required. Missing or blank refuses the card.
// - {name?}: optional. Missing or blank renders as nothing.
// - {{ and }}: a literal brace.

export const CARD_TEMPLATE_KINDS = ["coder", "review", "fix-round", "split-only", "merge-forward"] as const;
export type CardTemplateKind = (typeof CARD_TEMPLATE_KINDS)[number];

/** Longest a rendered template may be, before `cardRules` (§4.16). */
export const MAX_RENDERED_TEMPLATE_CHARS = 2500;
/** Longest a stored template or rule text may be. */
export const MAX_TEMPLATE_SOURCE_CHARS = 10_000;
export const MAX_CARD_RULES_CHARS = 10_000;

const TOKEN = /\{\{|\}\}|\{([a-z][A-Za-z0-9_]*)(\?)?\}/g;

export interface Placeholder {
  name: string;
  optional: boolean;
}

/** The placeholders a template uses, in order of first use. */
export function placeholders(template: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1];
    if (!name) continue;
    const optional = m[2] === "?";
    const prior = seen.get(name);
    // Required anywhere means required.
    if (!prior) seen.set(name, { name, optional });
    else if (!optional) prior.optional = false;
  }
  return [...seen.values()];
}

/** Why a stored template is malformed, or undefined. A lone brace that is
 *  not a placeholder or an escape is refused, so a typo like {ticket
 *  can't silently render as text. */
export function templateError(template: string): string | undefined {
  if (template.length > MAX_TEMPLATE_SOURCE_CHARS) return `is ${template.length} characters; at most ${MAX_TEMPLATE_SOURCE_CHARS}`;
  const stripped = template.replace(TOKEN, "");
  const stray = stripped.match(/[{}]/);
  if (stray) return `has a "${stray[0]}" that is not a placeholder like {ticket} or {notes?}; write {{ or }} for a literal brace`;
  return undefined;
}

export type RenderResult = { ok: true; body: string } | { ok: false; error: string; missing: string[] };

/** Renders `template` with `values`. Refuses when a required placeholder
 *  is missing or blank, naming every one, or when the result is longer
 *  than MAX_RENDERED_TEMPLATE_CHARS. */
export function renderCardTemplate(template: string, values: Record<string, unknown>, kind = "card"): RenderResult {
  const text = (name: string) => {
    const v = values[name];
    return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  };
  const missing = placeholders(template)
    .filter((p) => !p.optional && text(p.name) === "")
    .map((p) => p.name);
  if (missing.length > 0) {
    return { ok: false, missing, error: `the ${kind} template needs ${missing.map((m) => `{${m}}`).join(", ")}, and ${missing.length === 1 ? "it is" : "they are"} empty; nothing was started` };
  }
  const body = template.replace(TOKEN, (whole, name: string | undefined) => (whole === "{{" ? "{" : whole === "}}" ? "}" : text(name!))).trim();
  if (body.length > MAX_RENDERED_TEMPLATE_CHARS) {
    return { ok: false, missing: [], error: `the rendered ${kind} brief is ${body.length} characters; at most ${MAX_RENDERED_TEMPLATE_CHARS} before the project's rules. Split the card or shorten what was filled in` };
  }
  return { ok: true, body };
}

/** Separates a card's own brief from the project's rules. */
export const CARD_RULES_HEADING = "Project rules:";

/** `body` with the project's rules appended, once. A body that already
 *  carries them (an edited or re-created card) is returned unchanged. */
export function appendCardRules(body: string, rules: string | undefined): string {
  const r = rules?.trim();
  if (!r) return body;
  const block = `---\n${CARD_RULES_HEADING}\n${r}`;
  if (body.includes(block)) return body;
  return body.trim() ? `${body.trimEnd()}\n\n${block}` : block;
}
