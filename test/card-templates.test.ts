// cardRules and cardTemplates on projects (docs/SDD-coordinator.md §3.2,
// §4.16): validation through the settings body, storage, and the pure
// renderer that refuses an empty required placeholder.

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CARD_TEMPLATE_KINDS,
  DEFAULT_TEMPLATE_LIMIT,
  MAX_CARD_RULES_CHARS,
  renderCardTemplate,
  renderCardTemplateFor,
  templatePlaceholders,
} from "../src/services/card-templates.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";

const FIX_ROUND = "# Fix round {round} for {key}\n\nTicket: {ticket}\n\nFiles:\n{files}\n\n## Review\n\n{review}\n";

// ---------- renderer ----------

test("renderCardTemplate substitutes every placeholder and appends cardRules after a blank line", () => {
  const r = renderCardTemplate(FIX_ROUND, { round: "2", key: "A4", ticket: "ABC-12", files: "- src/a.ts", review: "HIGH: off by one" }, { cardRules: "Never force-push." });
  expect(r).toEqual({
    ok: true,
    body: "# Fix round 2 for A4\n\nTicket: ABC-12\n\nFiles:\n- src/a.ts\n\n## Review\n\nHIGH: off by one\n\nNever force-push.",
  });
});

test("renderCardTemplate without cardRules returns the rendered template alone", () => {
  const r = renderCardTemplate("Do {key}", { key: "B1" });
  expect(r).toEqual({ ok: true, body: "Do B1" });
  // Empty rules are the same as none.
  expect(renderCardTemplate("Do {key}", { key: "B1" }, { cardRules: "  " })).toEqual({ ok: true, body: "Do B1" });
});

test("renderCardTemplate refuses an empty or missing required placeholder: the pilot's empty fix brief", () => {
  const vars = { round: "1", key: "A4", ticket: "ABC-12", files: "- src/a.ts" };
  const missing = renderCardTemplate(FIX_ROUND, vars);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error).toBe('template placeholder "{review}" is empty');
  for (const empty of ["", "   ", "\n\t"]) {
    const r = renderCardTemplate(FIX_ROUND, { ...vars, review: empty });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"{review}" is empty');
  }
  // Several empty: the first in template order is named.
  const two = renderCardTemplate(FIX_ROUND, { round: "1", key: "", ticket: "", files: "x", review: "y" });
  if (two.ok) throw new Error("accepted");
  expect(two.error).toContain("{key}");
});

test("renderCardTemplate: a placeholder listed as optional may be empty and renders as nothing", () => {
  const r = renderCardTemplate("{key}: {ticket}", { key: "A4", ticket: "" }, { optional: ["ticket"] });
  expect(r).toEqual({ ok: true, body: "A4: " });
  const r2 = renderCardTemplate("{key}: {ticket}", { key: "A4" }, { optional: ["ticket"] });
  expect(r2).toEqual({ ok: true, body: "A4: " });
  // Optional doesn't excuse a different placeholder.
  const r3 = renderCardTemplate("{key}: {ticket}", { ticket: "T" }, { optional: ["ticket"] });
  expect(r3.ok).toBe(false);
});

test("renderCardTemplate: a value's own braces are not re-expanded, and unused vars are ignored", () => {
  const r = renderCardTemplate("{review}", { review: "see {files} in {key}", files: "x", key: "y" });
  expect(r).toEqual({ ok: true, body: "see {files} in {key}" });
  // Repeated placeholders are all substituted.
  expect(renderCardTemplate("{key} {key}", { key: "A" })).toEqual({ ok: true, body: "A A" });
  // Non-placeholder braces (a code block, JSON) are left alone.
  expect(renderCardTemplate('{"a": 1} {key} { not one }', { key: "A" })).toEqual({ ok: true, body: '{"a": 1} A { not one }' });
});

test("renderCardTemplate enforces the size limit before cardRules, with a default of 2,500", () => {
  expect(DEFAULT_TEMPLATE_LIMIT).toBe(2500);
  const fits = renderCardTemplate("{review}", { review: "x".repeat(2500) }, { cardRules: "y".repeat(1000) });
  expect(fits.ok).toBe(true);
  if (fits.ok) expect(fits.body.length).toBe(2500 + 2 + 1000);
  const over = renderCardTemplate("{review}", { review: "x".repeat(2501) });
  expect(over.ok).toBe(false);
  if (!over.ok) expect(over.error).toBe("rendered template is 2501 characters; at most 2500 before cardRules");
  const custom = renderCardTemplate("{review}", { review: "x".repeat(11) }, { limit: 10 });
  expect(custom.ok).toBe(false);
  expect(renderCardTemplate("{review}", { review: "x".repeat(10) }, { limit: 10 }).ok).toBe(true);
});

test("renderCardTemplate refuses a blank template", () => {
  const r = renderCardTemplate("  \n", { key: "A" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain("template is empty");
});

test("templatePlaceholders lists each placeholder once, in order", () => {
  expect(templatePlaceholders(FIX_ROUND)).toEqual(["round", "key", "ticket", "files", "review"]);
  expect(templatePlaceholders("{a} {a} {b-c} {d_e} {1}")).toEqual(["a", "b-c", "d_e", "1"]);
  expect(templatePlaceholders("none { x } {}")).toEqual([]);
});

test("renderCardTemplateFor picks the project's template of that kind and its cardRules; no template is an error", () => {
  const project = { cardRules: "Rule.", cardTemplates: { "fix-round": FIX_ROUND } };
  const ok = renderCardTemplateFor(project, "fix-round", { round: "1", key: "A4", ticket: "T-1", files: "f", review: "r" });
  expect(ok).toEqual({ ok: true, body: "# Fix round 1 for A4\n\nTicket: T-1\n\nFiles:\nf\n\n## Review\n\nr\n\nRule." });
  const none = renderCardTemplateFor(project, "coder", { key: "A4" });
  expect(none.ok).toBe(false);
  if (!none.ok) expect(none.error).toBe('project has no "coder" card template');
  const bare = renderCardTemplateFor({}, "review", {});
  expect(bare.ok).toBe(false);
});

// ---------- settings validation ----------

test("validateProjectSettings accepts cardRules and a partial cardTemplates map; null and empty clear", () => {
  const body = { cardRules: "Never force-push.\n", cardTemplates: { "fix-round": FIX_ROUND, coder: "Build {key}: {ticket}" } };
  expect(validateProjectSettings(body)).toEqual({ ok: true, patch: { cardRules: "Never force-push.", cardTemplates: body.cardTemplates } });
  expect(validateProjectSettings({ cardRules: null, cardTemplates: null })).toEqual({ ok: true, patch: { cardRules: null, cardTemplates: null } });
  expect(validateProjectSettings({ cardRules: "  ", cardTemplates: {} })).toEqual({ ok: true, patch: { cardRules: null, cardTemplates: null } });
  expect(CARD_TEMPLATE_KINDS).toEqual(["coder", "review", "fix-round", "split-only", "merge-forward"]);
});

test("validateProjectSettings refuses bad cardRules and cardTemplates with a message naming the field", () => {
  const err = (body: unknown) => {
    const r = validateProjectSettings(body);
    if (r.ok) throw new Error(`accepted ${JSON.stringify(body)}`);
    return r.error;
  };
  expect(err({ cardRules: 1 })).toContain("cardRules must be a string");
  expect(err({ cardRules: "x".repeat(MAX_CARD_RULES_CHARS + 1) })).toContain(`at most ${MAX_CARD_RULES_CHARS}`);
  expect(validateProjectSettings({ cardRules: "x".repeat(MAX_CARD_RULES_CHARS) }).ok).toBe(true);
  expect(err({ cardTemplates: [] })).toContain("cardTemplates must be an object");
  expect(err({ cardTemplates: "x" })).toContain("cardTemplates must be an object");
  expect(err({ cardTemplates: { planner: "x" } })).toContain('unknown card template kind "planner"');
  expect(err({ cardTemplates: { coder: 1 } })).toContain("cardTemplates.coder must be a non-empty string");
  expect(err({ cardTemplates: { coder: "" } })).toContain("cardTemplates.coder must be a non-empty string");
  expect(err({ cardTemplates: { coder: "x".repeat(DEFAULT_TEMPLATE_LIMIT + 1) } })).toContain(`cardTemplates.coder is ${DEFAULT_TEMPLATE_LIMIT + 1} characters; at most ${DEFAULT_TEMPLATE_LIMIT}`);
  expect(validateProjectSettings({ cardTemplates: { coder: "x".repeat(DEFAULT_TEMPLATE_LIMIT) } }).ok).toBe(true);
});

// ---------- store ----------

test("cardRules and cardTemplates round-trip through the store and clear with null", async () => {
  const db = new Database(":memory:");
  db.run(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, source TEXT NOT NULL, sourceUrl TEXT, createdAt TEXT NOT NULL, eli5 TEXT, eli5UpdatedAt TEXT, mergeGate TEXT, mergeGateTimeoutMs INTEGER)",
  );
  db.run("INSERT INTO projects VALUES ('p', 'acme', '/r/acme', 'local', NULL, '2026-01-01', NULL, NULL, NULL, NULL)");
  const store = new SqliteProjectStore(db);
  const [before] = await store.list();
  expect("cardRules" in before!).toBe(false);
  expect("cardTemplates" in before!).toBe(false);

  const templates = { "fix-round": FIX_ROUND, "merge-forward": "Merge {key} forward" };
  const set = await store.setSettings("p", { cardRules: "Rule.", cardTemplates: templates });
  expect(set.cardRules).toBe("Rule.");
  expect(set.cardTemplates).toEqual(templates);
  const [listed] = await store.list();
  expect(listed!.cardTemplates).toEqual(templates);
  expect(await store.settingsFor("/r/acme")).toEqual({ cardRules: "Rule.", cardTemplates: templates });

  // Reopening keeps them; the columns exist once.
  expect((await new SqliteProjectStore(db).list())[0]!.cardRules).toBe("Rule.");

  await store.setSettings("p", { cardRules: null, cardTemplates: null });
  expect((await store.list())[0]).toEqual(before!);
});
