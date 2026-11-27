import { describe, expect, test } from "bun:test";
import {
  assertNoInternalVocabulary,
  DEFAULT_UI_MODE,
  findInternalVocabulary,
  FORBIDDEN_IN_USER_MODE,
  label,
  UI_MODE_STORAGE_KEY,
  uiMode,
  USER_VOCABULARY,
  visibleText,
} from "../src/core/user-vocabulary.ts";

function storage(values: Record<string, string>) {
  return { getItem: (k: string) => values[k] ?? null };
}

describe("label", () => {
  test.each(Object.entries(USER_VOCABULARY))("%s resolves in both modes", (term, entry) => {
    expect(label(term, "operator")).toBe(entry.operator);
    expect(label(term, "user")).toBe(entry.user);
    expect(entry.user).not.toBe(entry.operator);
  });

  test("operator mode returns the internal term itself for every plain key", () => {
    for (const [term, entry] of Object.entries(USER_VOCABULARY)) {
      if (!term.includes(":")) expect(entry.operator as string).toBe(term);
    }
  });

  test("both tier values are covered", () => {
    expect(label("tier:readonly", "user")).toBe("reads only");
    expect(label("tier:write", "user")).toBe("can change code");
    expect(label("tier:write", "operator")).toBe("write");
  });

  test("the terms the card names are all present", () => {
    for (const t of ["card", "task", "lane", "tier", "harness", "worktree", "pushback", "escalated", "no-match", "routed to", "merge gate", "grant"]) {
      expect(USER_VOCABULARY).toHaveProperty([t]);
    }
  });

  test("an unknown term passes through in both modes", () => {
    expect(label("frobnicator", "operator")).toBe("frobnicator");
    expect(label("frobnicator", "user")).toBe("frobnicator");
    expect(label("toString", "user")).toBe("toString");
  });

  test("no user-mode string is itself internal vocabulary", () => {
    for (const entry of Object.values(USER_VOCABULARY)) expect(findInternalVocabulary(entry.user)).toEqual([]);
  });
});

describe("assertNoInternalVocabulary", () => {
  const operatorFixture = `<div class="card"><h3>Fix login</h3><p>Runs in its worktree on harness <b>claude</b></p></div>`;
  const userFixture = `<div class="card"><h3>Fix login</h3><p>Runs in ${label("worktree", "user")} on ${label("harness", "user")} <b>claude</b></p></div>`;

  test("fails on a fixture containing worktree", () => {
    expect(() => assertNoInternalVocabulary(operatorFixture)).toThrow(/worktree/);
    expect(findInternalVocabulary(operatorFixture)).toEqual(["harness", "worktree"]);
  });

  test("passes on its user-mode equivalent", () => {
    expect(() => assertNoInternalVocabulary(userFixture)).not.toThrow();
  });

  test("checks visible attributes but not class names, ids, scripts or styles", () => {
    expect(findInternalVocabulary(`<button title="Retry the task">Go</button>`)).toEqual(["task"]);
    expect(findInternalVocabulary(`<input placeholder="Pick a harness">`)).toEqual(["harness"]);
    expect(findInternalVocabulary(`<div id="lane-ready" class="card tier"><script>const task = 1</script><style>.lane{}</style><!-- worktree --></div>`)).toEqual([]);
  });

  test("matches whole words, plurals, any case, and multi-word terms across whitespace", () => {
    expect(findInternalVocabulary("Two Lanes")).toEqual(["lane"]);
    expect(findInternalVocabulary("HARNESSES")).toEqual(["harness"]);
    expect(findInternalVocabulary("the merge\n gate failed")).toEqual(["merge gate"]);
    expect(findInternalVocabulary("discard the planet, cardinal grants")).toEqual(["grant"]);
    expect(findInternalVocabulary("status: no-match")).toEqual(["no-match"]);
  });

  test("decodes entities before matching", () => {
    expect(findInternalVocabulary("routed&nbsp;to")).toEqual(["routed to"]);
    expect(visibleText("a &amp; b")).toContain("a & b");
  });

  test("the forbidden list covers every internal term in the table", () => {
    for (const [term, entry] of Object.entries(USER_VOCABULARY)) {
      if (term.startsWith("tier:")) continue; // "write"/"readonly" are ordinary words
      expect(findInternalVocabulary(entry.operator).length).toBeGreaterThan(0);
    }
    expect(FORBIDDEN_IN_USER_MODE.length).toBeGreaterThan(0);
  });
});

describe("uiMode", () => {
  test("defaults to operator with no parameter and no stored value", () => {
    expect(DEFAULT_UI_MODE).toBe("operator");
    expect(uiMode()).toBe("operator");
    expect(uiMode(new Request("http://localhost:8787/"), storage({}))).toBe("operator");
  });

  test("the query parameter wins over the stored value", () => {
    expect(uiMode("http://x/?mode=user", storage({ [UI_MODE_STORAGE_KEY]: "operator" }))).toBe("user");
    expect(uiMode(new URL("http://x/?mode=operator"), storage({ [UI_MODE_STORAGE_KEY]: "user" }))).toBe("operator");
    expect(uiMode(new Request("http://x/board?mode=user"))).toBe("user");
  });

  test("the stored value is used when there is no parameter", () => {
    expect(uiMode("http://x/", storage({ [UI_MODE_STORAGE_KEY]: "user" }))).toBe("user");
    expect(uiMode(null, storage({ [UI_MODE_STORAGE_KEY]: "user" }))).toBe("user");
  });

  test("values that are not a mode are ignored", () => {
    expect(uiMode("http://x/?mode=admin", storage({ [UI_MODE_STORAGE_KEY]: "root" }))).toBe("operator");
    expect(uiMode("http://x/?mode=admin", storage({ [UI_MODE_STORAGE_KEY]: "user" }))).toBe("user");
  });

  test("storage that throws falls back to operator", () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); } };
    expect(uiMode("http://x/", broken)).toBe("operator");
  });
});
