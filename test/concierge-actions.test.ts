import { describe, expect, test } from "bun:test";
import {
  MAX_ACTIONS,
  droppedNote,
  parseConciergeOutput,
  proseOf,
  resolveTaskId,
  validateActions,
  type ActionContext,
} from "../src/services/concierge-actions.ts";

// docs/SDD-wissel-app.md §3.4: the concierge proposes, code decides.

const TASK_A = "aaaaaaaa-1111-4111-8111-111111111111";
const TASK_B = "bbbbbbbb-2222-4222-8222-222222222222";
const TASK_B2 = "bbbbbbbb-3333-4333-8333-333333333333";

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return {
    projects: [{ name: "wissel", path: "/home/m/code/wissel" }],
    pipelines: [
      { id: "p-ai", name: "AI news podcast" },
      { id: "p-review", name: "Implement and review" },
    ],
    knownLabels: ["code", "context", "docs", "question"],
    taskIds: [TASK_A, TASK_B, TASK_B2],
    repoRequiredBy: (labels) => (labels.includes("code") ? "implementer" : undefined),
    pipelineNeedsRepo: (id) => id === "p-review",
    ...over,
  };
}

const block = (json: string) => "Sure.\n\n```wissel-actions\n" + json + "\n```";

describe("parseConciergeOutput", () => {
  test("reads reply and actions from the last block", () => {
    const raw = block('{"reply": "example", "actions": []}') + "\n" + block('{"reply": " Done. ", "actions": [{"type": "show_task", "id": "x"}]}');
    expect(parseConciergeOutput(raw)).toEqual({ reply: "Done.", actions: [{ type: "show_task", id: "x" }] });
  });

  test("actions may be left out", () => {
    expect(parseConciergeOutput(block('{"reply": "Nothing to do."}'))).toEqual({ reply: "Nothing to do.", actions: [] });
  });

  test("null for no block, bad JSON, empty reply, or actions that aren't a list", () => {
    expect(parseConciergeOutput("I made the card.")).toBeNull();
    expect(parseConciergeOutput(block('{"reply": "x", }'))).toBeNull();
    expect(parseConciergeOutput(block('{"reply": "  "}'))).toBeNull();
    expect(parseConciergeOutput(block('{"reply": "x", "actions": {"type": "show_task"}}'))).toBeNull();
    expect(parseConciergeOutput(block("[1, 2]"))).toBeNull();
    expect(parseConciergeOutput("```json\n{\"reply\": \"x\"}\n```")).toBeNull();
  });

  test("proseOf drops every fenced block, closed or not", () => {
    expect(proseOf('Hello.\n```wissel-actions\n{"reply": broken\n```\nBye.')).toBe("Hello.\n\nBye.");
    expect(proseOf("Text\n```wissel-actions\n{unclosed")).toBe("Text");
  });
});

describe("resolveTaskId", () => {
  test("full id, or a unique prefix of 8 or more", () => {
    expect(resolveTaskId(TASK_A, [TASK_A, TASK_B])).toBe(TASK_A);
    expect(resolveTaskId("AAAAAAAA", [TASK_A, TASK_B])).toBe(TASK_A);
    expect(resolveTaskId("aaaa", [TASK_A])).toBeUndefined();
    expect(resolveTaskId("bbbbbbbb", [TASK_B, TASK_B2])).toBeUndefined();
    expect(resolveTaskId("bbbbbbbb-3", [TASK_B, TASK_B2])).toBe(TASK_B2);
    expect(resolveTaskId("cccccccc", [TASK_A])).toBeUndefined();
  });
});

describe("validateActions", () => {
  test("a good card is kept, labels de-duplicated, repo given by name stored as its path", () => {
    const out = validateActions(
      [{ type: "create_task", title: " Check the README ", body: "Read it.", labels: ["docs", "docs", "context"], repo: "wissel" }],
      ctx(),
    );
    expect(out.dropped).toEqual([]);
    expect(out.valid).toEqual([{ type: "create_task", title: "Check the README", body: "Read it.", labels: ["docs", "context"], repo: "/home/m/code/wissel" }]);
  });

  test("a card with no repo is fine when it doesn't route to a file/bash agent; body defaults to empty", () => {
    const out = validateActions([{ type: "create_task", title: "What is MCP?", labels: ["question"] }], ctx());
    expect(out.valid).toEqual([{ type: "create_task", title: "What is MCP?", body: "", labels: ["question"] }]);
  });

  test("invalid cards are dropped with a reason", () => {
    const cases: [unknown, RegExp][] = [
      [{ type: "create_task", title: "", labels: ["docs"] }, /needs a title/],
      [{ type: "create_task", title: "x".repeat(201), labels: ["docs"] }, /longer than 200/],
      [{ type: "create_task", title: "T", body: 3, labels: ["docs"] }, /body must be text/],
      [{ type: "create_task", title: "T", labels: [] }, /at least one label/],
      [{ type: "create_task", title: "T", labels: ["docs", "deploy-now"] }, /unknown label "deploy-now"/],
      [{ type: "create_task", title: "T", labels: ["docs"], repo: "/etc" }, /not a registered project/],
      [{ type: "create_task", title: "T", labels: ["docs"], repo: 7 }, /repo must be a project path/],
      [{ type: "create_task", title: "Fix it", labels: ["code"] }, /implementer, which needs a repo/],
    ];
    for (const [action, reason] of cases) {
      const out = validateActions([action], ctx());
      expect(out.valid).toEqual([]);
      expect(out.dropped).toHaveLength(1);
      expect(out.dropped[0]!.reason).toMatch(reason);
      expect(out.dropped[0]!.disallowed).toBe(false);
    }
  });

  test("a code card with a registered repo is kept", () => {
    const out = validateActions([{ type: "create_task", title: "Fix it", labels: ["code"], repo: "/home/m/code/wissel" }], ctx());
    expect(out.valid).toHaveLength(1);
  });

  test("run_pipeline by exact name (any case) or id; unknown and repo-needing pipelines are dropped", () => {
    expect(validateActions([{ type: "run_pipeline", name: "ai NEWS podcast" }], ctx()).valid).toEqual([{ type: "run_pipeline", pipelineId: "p-ai", name: "AI news podcast" }]);
    expect(validateActions([{ type: "run_pipeline", name: "p-ai", input: " focus on robotics " }], ctx()).valid).toEqual([
      { type: "run_pipeline", pipelineId: "p-ai", name: "AI news podcast", input: "focus on robotics" },
    ]);
    expect(validateActions([{ type: "run_pipeline", name: "World news" }], ctx()).dropped[0]!.reason).toMatch(/no pipeline called "World news"/);
    expect(validateActions([{ type: "run_pipeline", name: "Implement and review" }], ctx()).dropped[0]!.reason).toMatch(/needs a repo/);
    expect(validateActions([{ type: "run_pipeline", name: "AI news podcast", input: 4 }], ctx()).dropped[0]!.reason).toMatch(/input must be text/);
  });

  test("show_task resolves an id8 to the full id", () => {
    expect(validateActions([{ type: "show_task", id: "aaaaaaaa" }], ctx()).valid).toEqual([{ type: "show_task", id: TASK_A }]);
    expect(validateActions([{ type: "show_task", id: "bbbbbbbb" }], ctx()).dropped[0]!.reason).toMatch(/no single card/);
  });

  test("types outside the list (not the endpoint names) and junk are disallowed, by name", () => {
    const out = validateActions(
      [{ type: "merge", id: TASK_A }, { type: "delete", id: TASK_A }, { type: "archive" }, { type: "disable_harness", id: "claude" }, "merge it", null, { id: TASK_A }],
      ctx(),
    );
    expect(out.valid).toEqual([]);
    expect(out.dropped.map((d) => d.type)).toEqual(["merge", "delete", "archive", "disable_harness", "unknown", "unknown", "unknown"]);
    expect(out.dropped.every((d) => d.disallowed)).toBe(true);
  });

  test(`at most ${MAX_ACTIONS} actions; the rest are dropped, and a repeat is dropped`, () => {
    const card = (n: number) => ({ type: "create_task", title: `Card ${n}`, labels: ["docs"] });
    const out = validateActions([card(1), card(1), card(2), { type: "merge" }, card(3), card(4), { type: "show_task", id: TASK_A }], ctx());
    expect(out.valid.map((a) => (a.type === "create_task" ? a.title : a.type))).toEqual(["Card 1", "Card 2", "Card 3"]);
    expect(out.dropped.map((d) => d.reason)).toEqual([
      "the same action twice",
      "not something Ask can do; use the board",
      `over the limit of ${MAX_ACTIONS} actions per message`,
      `over the limit of ${MAX_ACTIONS} actions per message`,
    ]);
  });
});

describe("droppedNote", () => {
  test("empty when nothing was dropped; one plain line per dropped action otherwise", () => {
    expect(droppedNote([])).toBe("");
    expect(
      droppedNote([
        { type: "merge", reason: "not something Ask can do; use the board", disallowed: true },
        { type: "create_task", reason: 'unknown label "x"', disallowed: false },
      ]),
    ).toBe('I left out:\n- merge: not something Ask can do; use the board\n- create a card: unknown label "x"');
  });
});
