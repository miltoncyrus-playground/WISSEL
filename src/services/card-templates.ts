/**
 * Card body templates and rules (docs/SDD-coordinator.md §3.2, §4.16).
 *
 * A template is markdown with `{placeholder}`s (`{key}`, `{ticket}`,
 * `{files}`, `{review}` and so on). Rendering substitutes each one,
 * enforces a size limit on the result (default 2,500 characters) and
 * then appends the project's `cardRules`, which don't count against the
 * limit. Every placeholder the template names is required unless the
 * caller lists it as optional: an empty required value is refused, so
 * an empty fix-round brief can never be produced. Pure: nothing here
 * reads the store or starts a card; `card.start` will call
 * renderCardTemplateFor when it is wired in.
 */

import type { CardTemplateKind, Project } from "../core/types.ts";

export const CARD_TEMPLATE_KINDS: readonly CardTemplateKind[] = ["coder", "review", "fix-round", "split-only", "merge-forward"];
/** Characters a rendered template may have before `cardRules`. */
export const DEFAULT_TEMPLATE_LIMIT = 2500;
/** Characters `cardRules` may have, so rules alone can't bloat a brief. */
export const MAX_CARD_RULES_CHARS = 4000;

/** `{name}` where name is letters, digits, `_` or `-`; `{ x }`, `{}`
 *  and JSON-like braces don't match. */
const PLACEHOLDER_RE = /\{([A-Za-z0-9_-]+)\}/g;

export type RenderedTemplate = { ok: true; body: string } | { ok: false; error: string };

export interface RenderOptions {
  /** Appended after a blank line; blank means none. */
  cardRules?: string;
  /** Placeholders that may be empty or absent; they render as "". */
  optional?: readonly string[];
  /** Overrides DEFAULT_TEMPLATE_LIMIT. */
  limit?: number;
}

/** The distinct placeholder names in a template, in order of first use. */
export function templatePlaceholders(template: string): string[] {
  const names: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const name = m[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Renders `template` with `vars`. Refuses (returns an error, never
 * throws) when the template is blank, when a required placeholder is
 * missing or whitespace-only, or when the rendered body exceeds the
 * limit before `cardRules`. A value's own braces are left as text, not
 * expanded again.
 */
export function renderCardTemplate(template: string, vars: Record<string, string | undefined>, opts: RenderOptions = {}): RenderedTemplate {
  if (template.trim() === "") return { ok: false, error: "template is empty" };
  const optional = new Set(opts.optional ?? []);
  const limit = opts.limit ?? DEFAULT_TEMPLATE_LIMIT;

  for (const name of templatePlaceholders(template)) {
    const value = vars[name];
    if (optional.has(name)) continue;
    if (value === undefined || value.trim() === "") return { ok: false, error: `template placeholder "{${name}}" is empty` };
  }

  const rendered = template.replace(PLACEHOLDER_RE, (_, name: string) => vars[name] ?? "");
  if (rendered.length > limit) {
    return { ok: false, error: `rendered template is ${rendered.length} characters; at most ${limit} before cardRules` };
  }

  const rules = opts.cardRules?.trim() ?? "";
  return { ok: true, body: rules === "" ? rendered : `${rendered.trimEnd()}\n\n${rules}` };
}

/**
 * Renders the project's template of `kind` with its `cardRules`. A
 * project without that template is an error: a card body is never
 * made up when the project didn't say how.
 */
export function renderCardTemplateFor(
  project: Pick<Project, "cardRules" | "cardTemplates">,
  kind: CardTemplateKind,
  vars: Record<string, string | undefined>,
  opts: Omit<RenderOptions, "cardRules"> = {},
): RenderedTemplate {
  const template = project.cardTemplates?.[kind];
  if (template === undefined) return { ok: false, error: `project has no "${kind}" card template` };
  return renderCardTemplate(template, vars, { ...opts, cardRules: project.cardRules });
}

/** Why one `cardRules` value is refused, or undefined when acceptable. */
export function cardRulesError(value: unknown): string | undefined {
  if (typeof value !== "string") return "cardRules must be a string of markdown, or null to clear it";
  if (value.length > MAX_CARD_RULES_CHARS) return `cardRules is ${value.length} characters; at most ${MAX_CARD_RULES_CHARS}`;
  return undefined;
}

/** Why one `cardTemplates` map is refused, or undefined when acceptable:
 *  an object keyed by CardTemplateKind, each a non-blank string within
 *  DEFAULT_TEMPLATE_LIMIT (a template that can't render empty can't
 *  render at all). */
export function cardTemplatesError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `cardTemplates must be an object keyed by kind (${CARD_TEMPLATE_KINDS.join(", ")}), or null to clear it`;
  }
  for (const [kind, template] of Object.entries(value as Record<string, unknown>)) {
    if (!(CARD_TEMPLATE_KINDS as readonly string[]).includes(kind)) return `unknown card template kind "${kind}"; expected any of: ${CARD_TEMPLATE_KINDS.join(", ")}`;
    if (typeof template !== "string" || template.trim() === "") return `cardTemplates.${kind} must be a non-empty string of markdown`;
    if (template.length > DEFAULT_TEMPLATE_LIMIT) return `cardTemplates.${kind} is ${template.length} characters; at most ${DEFAULT_TEMPLATE_LIMIT}`;
  }
  return undefined;
}
