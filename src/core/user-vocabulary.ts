// What a term is called in user mode — the single source of truth
// (docs/SDD-board-ui-for-teams.md §3 and §4.2).
//
// Rename in user mode only. The API, the database, operator mode and
// every log line keep their current names; nothing here is ever written
// anywhere. Operator mode gets back exactly the internal term, so routing
// a string through `label()` changes nothing for anyone in operator mode.
//
// Dependency-free on purpose: the board's plain scripts and the app both
// need to load it.

export type UiMode = "operator" | "user";

/** The localStorage key the client keeps a chosen mode under. */
export const UI_MODE_STORAGE_KEY = "wissel.uiMode";

/** Until permissions exist (docs/SDD-identity-and-permissions.md §3.3)
 *  nobody is put into user mode without asking for it. */
export const DEFAULT_UI_MODE: UiMode = "operator";

interface Entry {
  /** What operator mode says — the internal term as it is written today. */
  operator: string;
  /** What user mode says instead. */
  user: string;
}

/** §4.2's table, keyed by internal term. Tier values are keyed
 *  `tier:<AgentTier>` because the bare value ("write") is not a term on
 *  its own; their operator string is the value as the board shows it. */
export const USER_VOCABULARY = {
  card: { operator: "card", user: "piece of work" },
  cards: { operator: "cards", user: "work" },
  task: { operator: "task", user: "piece of work" },
  tasks: { operator: "tasks", user: "work" },
  lane: { operator: "lane", user: "stage" },
  lanes: { operator: "lanes", user: "stages" },
  tier: { operator: "tier", user: "what it may change" },
  "tier:readonly": { operator: "readonly", user: "reads only" },
  "tier:write": { operator: "write", user: "can change code" },
  harness: { operator: "harness", user: "account" },
  harnesses: { operator: "harnesses", user: "accounts" },
  worktree: { operator: "worktree", user: "its own copy of the repository" },
  pushback: { operator: "pushback", user: "review round" },
  escalated: { operator: "escalated", user: "needs you" },
  "no-match": { operator: "no-match", user: "nothing here can do this" },
  "pending-review": { operator: "pending-review", user: "waiting for a reviewer" },
  "routed to": { operator: "routed to", user: "doing it" },
  "merge gate": { operator: "merge gate", user: "the project's checks" },
  grant: { operator: "grant", user: "extra permission" },
  extraAllowedTools: { operator: "extraAllowedTools", user: "extra permission" },
} as const satisfies Record<string, Entry>;

export type VocabularyTerm = keyof typeof USER_VOCABULARY;

/** The string a person sees for `term` in `mode`. An unknown term comes
 *  back unchanged in either mode, so a caller can never lose text. */
export function label(term: string, mode: UiMode): string {
  const entry = Object.prototype.hasOwnProperty.call(USER_VOCABULARY, term) ? USER_VOCABULARY[term as VocabularyTerm] : undefined;
  if (!entry) return term;
  return mode === "user" ? entry.user : entry.operator;
}

/** Internal words a user-mode render must not show. Matched as whole
 *  words, case-insensitively, with a plural `s`/`es` allowed. */
export const FORBIDDEN_IN_USER_MODE: readonly string[] = [
  "card",
  "task",
  "lane",
  "tier",
  "harness",
  "worktree",
  "pushback",
  "escalated",
  "no-match",
  "pending-review",
  "routed to",
  "merge gate",
  "grant",
  "extraAllowedTools",
];

function isUiMode(v: unknown): v is UiMode {
  return v === "operator" || v === "user";
}

/** The mode a request renders in. Interim, until the mode follows a
 *  person's permissions: the `mode` query parameter, else the value the
 *  client stored under `wissel.uiMode`, else operator. A value that is
 *  neither mode is ignored rather than trusted. */
export function uiMode(
  request?: Request | URL | string | null,
  storage?: Pick<Storage, "getItem"> | null,
): UiMode {
  if (request) {
    try {
      const href = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      const fromQuery = new URL(href, "http://localhost").searchParams.get("mode");
      if (isUiMode(fromQuery)) return fromQuery;
    } catch {
      // An unparseable URL falls through to the stored value.
    }
  }
  if (storage) {
    try {
      const stored = storage.getItem(UI_MODE_STORAGE_KEY);
      if (isUiMode(stored)) return stored;
    } catch {
      // Storage can throw (private window, blocked site data).
    }
  }
  return DEFAULT_UI_MODE;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** The text a person can read in `html`: element text plus the
 *  attributes a browser shows (title, alt, placeholder, aria-label,
 *  button values). Scripts, styles, comments, class names and ids are
 *  not visible, so they are not checked. */
export function visibleText(html: string): string {
  const shown: string[] = [];
  for (const m of html.matchAll(/\b(?:title|alt|placeholder|aria-label|value)\s*=\s*("([^"]*)"|'([^']*)')/gi)) shown.push(m[2] ?? m[3] ?? "");
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  shown.push(body);
  return shown.join(" ").replace(/&(#?\w+);/g, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}

function forbiddenPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // Word boundaries that treat "-" as part of a word, so "no-match" does
  // not hit inside "no-matches-here" and "card" does not hit "discard".
  return new RegExp(`(?<![\\w-])${escaped}(?:s|es)?(?![\\w-])`, "i");
}

/** Every forbidden word that `html` shows a person, in table order. */
export function findInternalVocabulary(html: string): string[] {
  const text = visibleText(html);
  return FORBIDDEN_IN_USER_MODE.filter((w) => forbiddenPattern(w).test(text));
}

/** Throws, naming each word, if a user-mode render shows internal
 *  vocabulary. For tests: `assertNoInternalVocabulary(render("user"))`. */
export function assertNoInternalVocabulary(html: string): void {
  const hits = findInternalVocabulary(html);
  if (hits.length) throw new Error(`user-mode render shows internal vocabulary: ${hits.join(", ")}`);
}
