import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NewOwnerTask, OwnerTask, OwnerTaskStore } from "./owner-tasks.ts";

/**
 * Global, single-file memory — one repo-root file shared across every
 * repo wissel touches, not per-repo (see docs/SDD-memory-curator.md
 * §8.1). A plain relative path, same "repo-root config file" convention
 * `agents/manifest.yaml`/`harnesses.yaml` already use.
 */
export const DEFAULT_MEMORY_PATH = "memory/lessons.md";

/**
 * Reads the current curated memory file, if one exists yet. Undefined
 * (never an error) when nothing has been curated so far — the same "no
 * file yet is a valid starting state" contract setHarnessEnabled/
 * HarnessPool.autoload() already hold for their own optional files.
 */
export async function readMemoryLessons(path: string = DEFAULT_MEMORY_PATH): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Replaces the memory file wholesale — never appended to. memory-curator
 * is handed the current file's own contents as part of its input (see
 * gatherSessionLessons) specifically so it can dedup/consolidate against
 * what's already there; writing its summary back verbatim here is what
 * applies that compaction. See finishResult's
 * `outputs.includes("memory-entries")` hook, the only caller.
 */
export async function writeMemoryLessons(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// ---- Lesson scopes (docs/SDD-coordinator.md §4.15) -------------------
//
// A topic heading may end in `[scope: wissel]`, `[scope: project]`,
// `[scope: project:<name>]` or `[scope: path:<glob>]`. A heading without
// a tag is an unscoped lesson and behaves exactly as before: it is the
// only kind the prompt injection (WISSEL_MEMORY_INJECTION) still carries.
// The topic shape itself (heading, ELI5 paragraph, blank line, detail)
// is the one parseMemoryTopics in src/api/public/board.html parses.

export type LessonScope = { kind: "wissel" } | { kind: "project"; project?: string } | { kind: "path"; glob: string };

export interface MemoryLesson {
  title: string;
  scope?: LessonScope;
  eli5: string;
  detail: string;
}

export interface MemoryLessons {
  /** Everything before the first topic heading, verbatim. */
  lede: string;
  lessons: MemoryLesson[];
}

const SCOPE_TAG_RE = /\s*\[scope:\s*([^\]]+?)\s*\]$/i;
const HEADING_RE = /(?:^|\n)## ([^\n]+)(?:\n|$)/g;

/** `wissel`, `project`, `project:<name>` or `path:<glob>`; anything else is undefined. */
export function parseLessonScope(raw: string): LessonScope | undefined {
  const s = raw.trim();
  if (s === "wissel") return { kind: "wissel" };
  if (s === "project") return { kind: "project" };
  if (s.startsWith("project:") && s.length > 8) return { kind: "project", project: s.slice(8).trim() };
  if (s.startsWith("path:") && s.length > 5) return { kind: "path", glob: s.slice(5).trim() };
  return undefined;
}

export function formatLessonScope(scope: LessonScope): string {
  if (scope.kind === "wissel") return "wissel";
  if (scope.kind === "project") return scope.project ? `project:${scope.project}` : "project";
  return `path:${scope.glob}`;
}

/** Splits the file into its lede and topics; a file with no `## ` heading is all lede. */
export function parseMemoryLessons(content: string): MemoryLessons {
  const starts: { heading: string; index: number; bodyStart: number }[] = [];
  for (const m of content.matchAll(HEADING_RE)) {
    starts.push({ heading: m[1]!.trim(), index: m.index! + (m[0].startsWith("\n") ? 1 : 0), bodyStart: m.index! + m[0].length });
  }
  if (starts.length === 0) return { lede: content, lessons: [] };
  const lede = content.slice(0, starts[0]!.index).trim();
  const lessons = starts.map((s, i) => {
    const body = content.slice(s.bodyStart, i + 1 < starts.length ? starts[i + 1]!.index : content.length).trim();
    const brk = body.search(/\n\s*\n/);
    const tag = s.heading.match(SCOPE_TAG_RE);
    const scope = tag ? parseLessonScope(tag[1]!) : undefined;
    return {
      title: scope ? s.heading.slice(0, tag!.index).trim() : s.heading,
      ...(scope ? { scope } : {}),
      eli5: brk === -1 ? body : body.slice(0, brk).trim(),
      detail: brk === -1 ? "" : body.slice(brk).trim(),
    };
  });
  return { lede, lessons };
}

/** The inverse of parseMemoryLessons, scopes written back into headings. */
export function formatMemoryLessons(m: MemoryLessons): string {
  const parts = m.lede.trim() ? [m.lede.trim()] : [];
  for (const l of m.lessons) {
    const heading = `## ${l.title}${l.scope ? ` [scope: ${formatLessonScope(l.scope)}]` : ""}`;
    parts.push(`${heading}\n${l.eli5}${l.detail ? `\n\n${l.detail}` : ""}`);
  }
  return parts.join("\n\n");
}

/**
 * What the prompt injection carries: the unscoped lessons. A file with
 * no scoped lesson at all is returned byte for byte (the pre-§4.15
 * behaviour); a file whose lessons are all scoped contributes nothing.
 */
export function promptMemory(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const parsed = parseMemoryLessons(content);
  if (parsed.lessons.every((l) => !l.scope)) return content;
  const unscoped = parsed.lessons.filter((l) => !l.scope);
  return unscoped.length === 0 ? undefined : formatMemoryLessons({ lede: parsed.lede, lessons: unscoped });
}

/** readMemoryLessons filtered through promptMemory; what runClaude/runCodex inject. */
export async function readPromptMemory(path: string = DEFAULT_MEMORY_PATH): Promise<string | undefined> {
  return promptMemory(await readMemoryLessons(path));
}

/** `wissel`-scoped lessons as suggested Wissel issue text (never a prompt line). */
export function wisselIssueSuggestions(content: string | undefined): { title: string; body: string }[] {
  if (!content) return [];
  return parseMemoryLessons(content)
    .lessons.filter((l) => l.scope?.kind === "wissel")
    .map((l) => ({ title: l.title, body: l.detail ? `${l.eli5}\n\n${l.detail}` : l.eli5 }));
}

/** `*` and `?` stay within one path segment; `**` crosses segments. Paths may start with `./`. */
export function globMatches(glob: string, path: string): boolean {
  const re = glob
    .replace(/^\.\//, "")
    .replace(/\*\*\/|\*\*|\*|\?|[^*?]+/g, (t) => (t === "**/" ? "(?:.*/)?" : t === "**" ? ".*" : t === "*" ? "[^/]*" : t === "?" ? "[^/]" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&")));
  return new RegExp(`^${re}$`).test(path.replace(/^(\.\/|\/)+/, ""));
}

/**
 * The brief block for a card whose planned `files` match a `path:`
 * lesson's glob; undefined when none does. Appended after cardRules by
 * renderCardTemplate's `lessons` option.
 */
export function briefLessonsFor(content: string | undefined, files: string[]): string | undefined {
  if (!content || files.length === 0) return undefined;
  const hits = parseMemoryLessons(content).lessons.filter((l) => l.scope?.kind === "path" && files.some((f) => globMatches((l.scope as { glob: string }).glob, f)));
  if (hits.length === 0) return undefined;
  return ["Lessons for the files this card touches (memory/lessons.md):", ...hits.map((l) => `- **${l.title}**: ${l.eli5.replace(/\s*\n\s*/g, " ")}`)].join("\n");
}

/** Owner-task title prefix that marks a `project` lesson proposal. */
export const CARD_RULE_PROPOSAL_PREFIX = "Add card rule: ";

function cardRuleProposal(l: MemoryLesson): NewOwnerTask {
  const project = l.scope?.kind === "project" ? l.scope.project : undefined;
  const target = project ? `project ${project}` : "every project";
  return {
    title: `${CARD_RULE_PROPOSAL_PREFIX}${l.title}`,
    why: `Proposed card rule from memory/lessons.md for ${target}:\n\n${l.eli5}`,
    steps: [`Done appends the rule to the cardRules of ${target}`, "Dismiss drops it; the lesson stays in memory/lessons.md"],
    blocks: [],
  };
}

/**
 * Opens one owner task per `project` lesson not yet proposed (by title,
 * whatever its status, so a dismissed proposal is not raised again).
 * Returns the tasks it created. Nothing is applied here: cardRules
 * change only when the owner marks the task Done (proposedCardRule).
 */
export async function proposeProjectRules(content: string | undefined, store: OwnerTaskStore): Promise<OwnerTask[]> {
  if (!content) return [];
  const seen = new Set((await store.list()).map((t) => t.title));
  const created: OwnerTask[] = [];
  for (const l of parseMemoryLessons(content).lessons) {
    if (l.scope?.kind !== "project" || seen.has(`${CARD_RULE_PROPOSAL_PREFIX}${l.title}`)) continue;
    created.push(await store.create(cardRuleProposal(l)));
  }
  return created;
}

/** For a Done proposal task, the rule to append and the project it names (undefined: every project). */
export function proposedCardRule(task: OwnerTask | undefined, content: string | undefined): { rule: string; project?: string } | undefined {
  if (!task || !content || task.status !== "done" || !task.title.startsWith(CARD_RULE_PROPOSAL_PREFIX)) return undefined;
  const title = task.title.slice(CARD_RULE_PROPOSAL_PREFIX.length);
  const l = parseMemoryLessons(content).lessons.find((x) => x.title === title && x.scope?.kind === "project");
  if (!l) return undefined;
  const project = (l.scope as { project?: string }).project;
  return project ? { rule: l.eli5, project } : { rule: l.eli5 };
}

/** cardRules with `rule` appended once; unchanged when already present. */
export function appendCardRule(cardRules: string | undefined, rule: string): string {
  const rules = cardRules?.trim() ?? "";
  if (rules.includes(rule.trim())) return rules;
  return rules === "" ? rule.trim() : `${rules}\n\n${rule.trim()}`;
}
