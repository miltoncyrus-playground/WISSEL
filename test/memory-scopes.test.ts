// Lesson scopes (docs/SDD-coordinator.md §4.15): each topic in
// memory/lessons.md may carry `[scope: wissel|project|path:<glob>]` in
// its heading. Unscoped lessons keep working exactly as before.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendCardRule,
  briefLessonsFor,
  CARD_RULE_PROPOSAL_PREFIX,
  formatMemoryLessons,
  globMatches,
  parseMemoryLessons,
  promptMemory,
  proposedCardRule,
  proposeProjectRules,
  wisselIssueSuggestions,
} from "../src/services/memory.ts";
import { SqliteOwnerTaskStore } from "../src/services/owner-tasks.ts";
import { renderCardTemplate } from "../src/services/card-templates.ts";

const LESSONS = [
  "# Lessons",
  "",
  "## Old habit",
  "Unscoped lessons still work.",
  "",
  "Detail about the old habit.",
  "",
  "## Sandbox TMPDIR fills up [scope: wissel]",
  "The sandbox disk runs out when TMPDIR is on the small partition.",
  "",
  "Seen three times in September.",
  "",
  "## Never force-push [scope: project]",
  "Always open a new commit instead of rewriting history.",
  "",
  "## Only one project needs this [scope: project:wissel-app]",
  "Run the schema check before touching migrations.",
  "",
  "## Server routes [scope: path:src/api/**]",
  "Routes live in one big switch; add new ones near their siblings.",
  "",
  "See src/api/server.ts.",
].join("\n");

test("parseMemoryLessons reads scopes from headings and leaves unscoped topics without one", () => {
  const parsed = parseMemoryLessons(LESSONS);
  expect(parsed.lede).toBe("# Lessons");
  expect(parsed.lessons.map((l) => [l.title, l.scope])).toEqual([
    ["Old habit", undefined],
    ["Sandbox TMPDIR fills up", { kind: "wissel" }],
    ["Never force-push", { kind: "project" }],
    ["Only one project needs this", { kind: "project", project: "wissel-app" }],
    ["Server routes", { kind: "path", glob: "src/api/**" }],
  ]);
  expect(parsed.lessons[0]).toMatchObject({ eli5: "Unscoped lessons still work.", detail: "Detail about the old habit." });
  expect(parsed.lessons[2]!.detail).toBe("");
});

test("an unknown scope tag is kept as part of the title, not guessed", () => {
  const parsed = parseMemoryLessons("## Thing [scope: galaxy]\nBody.");
  expect(parsed.lessons[0]).toEqual({ title: "Thing [scope: galaxy]", eli5: "Body.", detail: "" });
});

test("formatMemoryLessons round-trips scopes and a file with no headings parses as lede only", () => {
  expect(formatMemoryLessons(parseMemoryLessons(LESSONS))).toBe(LESSONS);
  const flat = "- Existing lesson: check node_modules first.";
  expect(parseMemoryLessons(flat)).toEqual({ lede: flat, lessons: [] });
  expect(formatMemoryLessons(parseMemoryLessons(flat))).toBe(flat);
});

test("promptMemory keeps only unscoped lessons, and returns a file without scopes verbatim", () => {
  const prompt = promptMemory(LESSONS)!;
  expect(prompt).toContain("## Old habit");
  expect(prompt).not.toContain("Sandbox TMPDIR");
  expect(prompt).not.toContain("force-push");
  expect(prompt).not.toContain("Server routes");
  const flat = "- Existing lesson: check node_modules first.\n";
  expect(promptMemory(flat)).toBe(flat);
  expect(promptMemory("## Only scoped [scope: wissel]\nGone.")).toBeUndefined();
  expect(promptMemory(undefined)).toBeUndefined();
});

test("wisselIssueSuggestions turns wissel-scoped lessons into issue text", () => {
  expect(wisselIssueSuggestions(LESSONS)).toEqual([
    { title: "Sandbox TMPDIR fills up", body: "The sandbox disk runs out when TMPDIR is on the small partition.\n\nSeen three times in September." },
  ]);
  expect(wisselIssueSuggestions(undefined)).toEqual([]);
});

test("globMatches: * stays within a segment, ** crosses segments", () => {
  expect(globMatches("src/api/**", "src/api/server.ts")).toBe(true);
  expect(globMatches("src/api/**", "src/api/public/board.html")).toBe(true);
  expect(globMatches("src/api/**", "src/core/types.ts")).toBe(false);
  expect(globMatches("src/*.ts", "src/a.ts")).toBe(true);
  expect(globMatches("src/*.ts", "src/x/a.ts")).toBe(false);
  expect(globMatches("**/*.test.ts", "test/deep/a.test.ts")).toBe(true);
  expect(globMatches("src/a.ts", "./src/a.ts")).toBe(true);
});

test("briefLessonsFor adds path-scoped lessons only when a planned file matches, and the renderer appends them", () => {
  expect(briefLessonsFor(LESSONS, ["src/core/types.ts"])).toBeUndefined();
  const block = briefLessonsFor(LESSONS, ["src/api/server.ts"])!;
  expect(block).toContain("Server routes");
  expect(block).toContain("Routes live in one big switch");
  expect(block).not.toContain("Old habit");
  expect(block).not.toContain("force-push");
  expect(briefLessonsFor(undefined, ["src/api/server.ts"])).toBeUndefined();

  const r = renderCardTemplate("Do {key}", { key: "B1" }, { cardRules: "Rule.", lessons: block });
  expect(r).toEqual({ ok: true, body: `Do B1\n\nRule.\n\n${block}` });
  // Lessons don't count against the template limit.
  expect(renderCardTemplate("Do {key}", { key: "B1" }, { limit: 5, lessons: block }).ok).toBe(true);
});

test("proposeProjectRules opens one owner task per project-scoped lesson, once, and Done yields the rule to apply", async () => {
  const store = new SqliteOwnerTaskStore(new Database(":memory:"));
  const created = await proposeProjectRules(LESSONS, store);
  expect(created.map((t) => t.title)).toEqual([`${CARD_RULE_PROPOSAL_PREFIX}Never force-push`, `${CARD_RULE_PROPOSAL_PREFIX}Only one project needs this`]);
  expect(created[0]!.why).toContain("Always open a new commit");
  expect(created[1]!.why).toContain("wissel-app");
  expect(created[0]!.blocks).toEqual([]);
  // A second run (even after a dismissal) proposes nothing new.
  await store.setStatus(created[0]!.id, "dismissed");
  expect(await proposeProjectRules(LESSONS, store)).toEqual([]);
  expect((await store.list()).length).toBe(2);

  const done = await store.setStatus(created[1]!.id, "done");
  expect(proposedCardRule(done, LESSONS)).toEqual({ rule: "Run the schema check before touching migrations.", project: "wissel-app" });
  expect(proposedCardRule(await store.get(created[0]!.id), LESSONS)).toBeUndefined();
  expect(proposedCardRule({ ...done, title: "Buy a domain" }, LESSONS)).toBeUndefined();

  expect(appendCardRule(undefined, "Rule A.")).toBe("Rule A.");
  expect(appendCardRule("Rule A.", "Rule B.")).toBe("Rule A.\n\nRule B.");
  expect(appendCardRule("Rule A.\n\nRule B.", "Rule B.")).toBe("Rule A.\n\nRule B.");
});
