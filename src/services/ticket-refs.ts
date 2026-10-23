/**
 * Finds a ticket key (`ABC-123`) in a card title, a branch name or a
 * commit subject, using the patterns a project sets (`ticketPatterns`,
 * `referencePatterns`). Pure string work: no git, no network, no LLM.
 *
 * A pattern is a regular expression source, matched anywhere in the
 * text. With none set the default is any `PROJ-123`-shaped key.
 */

export const DEFAULT_TICKET_PATTERN = "\\b[A-Z][A-Z0-9]+-\\d+\\b";
export const MAX_REF_PATTERNS = 5;
export const MAX_REF_PATTERN_LENGTH = 80;

/** Why one pattern is refused, or undefined when it's acceptable: a
 *  bounded-length regular expression that compiles and has no nested
 *  quantifier (`(a+)+`), the shape that backtracks without end. */
export function patternError(source: string): string | undefined {
  if (source === "") return "patterns must be non-empty";
  if (source.length > MAX_REF_PATTERN_LENGTH) return `"${source.slice(0, 20)}…" is over ${MAX_REF_PATTERN_LENGTH} characters`;
  if (/\([^)]*[+*}][^)]*\)[+*{]/.test(source)) return `"${source}" repeats a repeated group, which can run for ever; simplify it`;
  try {
    new RegExp(source);
  } catch {
    return `"${source}" is not a valid regular expression`;
  }
  return undefined;
}

function compile(patterns: readonly string[] | undefined, fallback: readonly string[]): RegExp[] {
  const sources = patterns && patterns.length > 0 ? patterns : fallback;
  const out: RegExp[] = [];
  for (const source of sources) {
    if (patternError(source)) continue;
    out.push(new RegExp(source));
  }
  return out;
}

/** The first match of any pattern in `text`, in pattern order, or
 *  undefined. A bad pattern is skipped, never thrown on. */
export function firstMatch(text: string, patterns: readonly string[] | undefined, fallback: readonly string[] = []): string | undefined {
  for (const re of compile(patterns, fallback)) {
    const m = re.exec(text);
    if (m && m[0] !== "") return m[0];
  }
  return undefined;
}

/** The ticket key in `text`, or undefined. */
export function extractTicketKey(text: string | undefined, ticketPatterns?: readonly string[]): string | undefined {
  return text ? firstMatch(text, ticketPatterns, [DEFAULT_TICKET_PATTERN]) : undefined;
}

/** The first ticket key across `texts`, tried in order (title, then
 *  branch, then the rest). Empty and missing entries are skipped. */
export function ticketKeyOf(texts: readonly (string | undefined)[], ticketPatterns?: readonly string[]): string | undefined {
  for (const text of texts) {
    const key = extractTicketKey(text, ticketPatterns);
    if (key) return key;
  }
  return undefined;
}

/** Every distinct non-ticket reference (`DEC-019`, `I-03-15d`) across
 *  `texts`, in order found. Empty unless the project set patterns. */
export function referencesOf(texts: readonly (string | undefined)[], referencePatterns?: readonly string[]): string[] {
  if (!referencePatterns || referencePatterns.length === 0) return [];
  const found: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const re of compile(referencePatterns, [])) {
      const m = re.exec(text);
      if (m && m[0] !== "" && !found.includes(m[0])) found.push(m[0]);
    }
  }
  return found;
}
