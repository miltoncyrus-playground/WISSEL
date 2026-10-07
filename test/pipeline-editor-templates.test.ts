import { expect, test } from "bun:test";
import { aiNewsPodcastDraft, blankDraft, builtInTemplates, draftFromPipeline, templateChoices } from "../pipeline-editor/src/templates.ts";
import { colorModeFor } from "../pipeline-editor/src/theme.ts";
import type { PipelineDef } from "../pipeline-editor/src/types.ts";

// docs/SDD-ui-cleanup.md §4.2 (card B2): "New pipeline" offers "start
// blank" or "start from" any saved pipeline, and the editor follows the
// board's theme. Both are pure modules of the editor bundle, so they run
// in the gate here (pipeline-editor/test/ runs under vitest, which isn't
// part of `bun test test/`).

function def(overrides: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: "src-id",
    name: "Review-Handoff Loop",
    description: "implement, review, retry",
    graph: {
      steps: [
        { id: "impl-1", name: "Implementer", agentId: "implementer", transition: "all" },
        { id: "rev-1", name: "Reviewer", agentId: "reviewer", transition: "choose", joinMode: "all" },
        { id: "approved", name: "Approved", agentId: "quick-answer", transition: "all" },
      ],
      edges: [
        { id: "e1", from: "impl-1", to: "rev-1" },
        { id: "e2", from: "rev-1", to: "approved", label: "approve" },
      ],
    },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

test("start blank: no name, no steps, no edges", () => {
  expect(blankDraft()).toEqual({ name: "", description: "", graph: { steps: [], edges: [] } });
  // A fresh object each time, so one draft's edits never leak into the next.
  expect(blankDraft().graph.steps).not.toBe(blankDraft().graph.steps);
});

test("start from: the source's graph unchanged, named as a copy, with no id of its own", () => {
  const source = def();
  const draft = draftFromPipeline(source);
  expect(draft.name).toBe("Review-Handoff Loop (copy)");
  expect(draft.description).toBe("implement, review, retry");
  // Step and edge ids, agents, transitions, join modes and labels all
  // carry over: a "choose" step's next can name a step id, so the copy
  // must route exactly like the original.
  expect(draft.graph).toEqual(source.graph);
  expect(Object.keys(draft).sort()).toEqual(["description", "graph", "name"]);
});

test("start from: editing the draft never touches the saved pipeline it came from", () => {
  const source = def();
  const before = structuredClone(source);
  const draft = draftFromPipeline(source);
  draft.graph.steps[0]!.name = "Renamed";
  draft.graph.steps[1]!.joinMode = "any";
  draft.graph.steps.push({ id: "x", name: "Extra", agentId: "triager", transition: "choose" });
  draft.graph.edges[1]!.label = "changed";
  draft.graph.edges.pop();
  expect(source).toEqual(before);
});

test("the start-from list is every saved pipeline, sorted by name, without reordering the input", () => {
  const list = [def({ id: "b", name: "Full Task Lifecycle" }), def({ id: "c", name: "zeta" }), def({ id: "a", name: "Alpha" })];
  expect(templateChoices(list).map((p) => p.id)).toEqual(["a", "b", "c"]);
  expect(list.map((p) => p.id)).toEqual(["b", "c", "a"]);
  expect(templateChoices([])).toEqual([]);
});

test("built-in templates: the AI news podcast, as a fresh copy every time", () => {
  const [first, ...rest] = builtInTemplates();
  expect(rest).toEqual([]);
  expect(first).toEqual(aiNewsPodcastDraft());
  expect(first!.name).toBe("AI news podcast");
  expect(Object.keys(first!).sort()).toEqual(["description", "graph", "name"]);
  first!.graph.steps[0]!.name = "Changed";
  expect(builtInTemplates()[0]!.graph.steps[0]!.name).toBe("Gather news");
});

test("the editor's colour mode follows the board: an explicit Light/Dark wins, Auto follows the OS", () => {
  expect(colorModeFor("light", true)).toBe("light");
  expect(colorModeFor("dark", false)).toBe("dark");
  expect(colorModeFor(undefined, true)).toBe("dark");
  expect(colorModeFor(undefined, false)).toBe("light");
  // Anything the board doesn't write is Auto.
  expect(colorModeFor("", true)).toBe("dark");
  expect(colorModeFor("sepia", false)).toBe("light");
});
