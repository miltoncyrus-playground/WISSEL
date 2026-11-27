import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { appendCardRules, CARD_RULES_HEADING, MAX_RENDERED_TEMPLATE_CHARS, placeholders, renderCardTemplate, templateError } from "../src/core/card-templates.ts";

// docs/SDD-coordinator.md §4.16, phase 1 card 2: card templates and rules
// on projects; render, and refuse a card whose required placeholders are
// empty. The pilot's empty fix brief is the case to stop.

const FIX = "Fix round {round} for {key}.\n\nThe review said:\n{review}\n\nNotes: {notes?}";

describe("rendering", () => {
  test("placeholders: required and optional, required anywhere wins, escapes are not placeholders", () => {
    expect(placeholders(FIX)).toEqual([
      { name: "round", optional: false },
      { name: "key", optional: false },
      { name: "review", optional: false },
      { name: "notes", optional: true },
    ]);
    expect(placeholders("{a?} {a}")).toEqual([{ name: "a", optional: false }]);
    expect(placeholders("{{literal}}")).toEqual([]);
  });

  test("renders values, drops a blank optional one, keeps literal braces", () => {
    const r = renderCardTemplate(FIX + " {{x}}", { round: 2, key: "A4", review: "Handle the empty input." });
    expect(r).toEqual({ ok: true, body: "Fix round 2 for A4.\n\nThe review said:\nHandle the empty input.\n\nNotes:  {x}" });
  });

  test("the pilot's empty fix brief is refused, naming every empty placeholder", () => {
    const r = renderCardTemplate(FIX, { round: 2, key: "A4", review: "   " }, "fix-round");
    expect(r).toEqual({ ok: false, missing: ["review"], error: "the fix-round template needs {review}, and it is empty; nothing was started" });
    const none = renderCardTemplate(FIX, {}, "fix-round");
    expect(!none.ok && none.missing).toEqual(["round", "key", "review"]);
  });

  test("a rendered brief over the limit is refused, before rules are counted", () => {
    const r = renderCardTemplate("{review}", { review: "x".repeat(MAX_RENDERED_TEMPLATE_CHARS + 1) }, "review");
    expect(!r.ok && r.error).toContain(`at most ${MAX_RENDERED_TEMPLATE_CHARS}`);
    expect(renderCardTemplate("{review}", { review: "x".repeat(MAX_RENDERED_TEMPLATE_CHARS) }).ok).toBe(true);
  });

  test("templateError: a stray brace is refused, escapes and placeholders are fine", () => {
    expect(templateError("Do {ticket")).toContain("not a placeholder");
    expect(templateError("{Ticket}")).toContain("not a placeholder");
    expect(templateError("{{json}} {ticket} {notes?}")).toBeUndefined();
  });

  test("appendCardRules adds the rules once, under a heading, and nothing when there are none", () => {
    const once = appendCardRules("Do the thing.", "Stage explicit paths.");
    expect(once).toBe(`Do the thing.\n\n---\n${CARD_RULES_HEADING}\nStage explicit paths.`);
    expect(appendCardRules(once, "Stage explicit paths.")).toBe(once);
    expect(appendCardRules("Do the thing.", "  ")).toBe("Do the thing.");
    expect(appendCardRules("", "Rule.")).toBe(`---\n${CARD_RULES_HEADING}\nRule.`);
  });
});

describe("project settings", () => {
  test("cardRules and cardTemplates are stored; blanks clear; unknown kinds and stray braces are refused", () => {
    expect(validateProjectSettings({ cardRules: "Never force-push.", cardTemplates: { "fix-round": FIX } })).toEqual({ ok: true, patch: { cardRules: "Never force-push.", cardTemplates: { "fix-round": FIX } } });
    expect(validateProjectSettings({ cardRules: " ", cardTemplates: { coder: "" } })).toEqual({ ok: true, patch: { cardRules: null, cardTemplates: null } });
    expect(validateProjectSettings({ cardTemplates: { planner: "x" } })).toMatchObject({ ok: false, error: expect.stringContaining('unknown card template kind "planner"') });
    expect(validateProjectSettings({ cardTemplates: { coder: "Do {ticket" } })).toMatchObject({ ok: false, error: expect.stringContaining("cardTemplates.coder") });
    expect(validateProjectSettings({ cardRules: 5 }).ok).toBe(false);
  });
});

describe("POST /tasks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-card-templates-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function makeApp() {
    const board = new SqliteBoard();
    const app = createApp(board, await Registry.load(), undefined, { harnesses: HarnessPool.from([]) });
    const repo = join(dir, "acme");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const project = (await (await app(new Request("http://x/projects/local", { method: "POST", body: JSON.stringify({ path: repo }) }))).json()) as { id: string };
    const settings = await app(
      new Request(`http://x/projects/${project.id}/settings`, {
        method: "POST",
        body: JSON.stringify({ cardRules: "Stage explicit paths.", cardTemplates: { "fix-round": FIX, coder: "Build {ticket}: {body}" } }),
      }),
    );
    expect(settings.status).toBe(200);
    const newCard = (body: Record<string, unknown>) =>
      app(new Request("http://x/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "t", body: "", labels: ["intake"], repo, ...body }) }));
    return { board, repo, newCard };
  }

  test("a template is rendered from fields and the card's own key and body, then the rules are appended", async () => {
    const { newCard } = await makeApp();
    const res = await newCard({ template: "coder", key: "A4", body: "add retries", fields: { ticket: "ABC-12" } });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { body: string }).body).toBe(`Build ABC-12: add retries\n\n---\n${CARD_RULES_HEADING}\nStage explicit paths.`);
  });

  test("an empty required placeholder refuses the card, and nothing is created", async () => {
    const { board, newCard } = await makeApp();
    const res = await newCard({ template: "fix-round", key: "A4", fields: { round: 2, review: "" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("the fix-round template needs {review}, and it is empty; nothing was started");
    expect(await board.list()).toHaveLength(0);
  });

  test("a card without a template still gets the project's rules; an unknown or missing template is refused", async () => {
    const { newCard } = await makeApp();
    const plain = (await (await newCard({ body: "Do it." })).json()) as { body: string };
    expect(plain.body).toBe(`Do it.\n\n---\n${CARD_RULES_HEADING}\nStage explicit paths.`);
    expect((await newCard({ template: "planner" })).status).toBe(400);
    const missing = await newCard({ template: "review", fields: {} });
    expect(((await missing.json()) as { error: string }).error).toContain('no "review" template');
    expect((await newCard({ fields: { a: "b" } })).status).toBe(400);
  });

  test("a card in a repo with no project is untouched", async () => {
    const { newCard } = await makeApp();
    const res = await newCard({ repo: join(dir, "elsewhere"), body: "Do it." });
    expect(((await res.json()) as { body: string }).body).toBe("Do it.");
  });
});
