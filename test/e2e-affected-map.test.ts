import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolveAffectedSpecs } from "../scripts/e2e-affected-map.ts";

// Hardcoded rather than read from disk, so these tests stay pure
// (no filesystem, no git, no Playwright, no browser) per the card's
// own "pure, deterministic, testable without touching Playwright"
// requirement. The cross-check test below guards against this list
// silently drifting from the real e2e/ directory.
const ALL_SPECS = [
  "board.spec.ts",
  "live-task-output.spec.ts",
  "new-task.spec.ts",
  "pipeline-editor.spec.ts",
  "pipelines.spec.ts",
  "projects.spec.ts",
  "theme.spec.ts",
];

describe("ALL_SPECS fixture", () => {
  test("matches the real e2e/*.spec.ts files on disk", () => {
    const real = readdirSync(new URL("../e2e/", import.meta.url))
      .filter((f) => f.endsWith(".spec.ts"))
      .sort();
    expect(real).toEqual(ALL_SPECS);
  });
});

describe("resolveAffectedSpecs", () => {
  test("no changed files resolves to nothing, not the full suite", () => {
    const result = resolveAffectedSpecs([], ALL_SPECS);
    expect(result).toEqual({ specs: [], fullSuite: false, files: [] });
  });

  test("a spec file changing re-runs itself only", () => {
    const result = resolveAffectedSpecs([{ path: "e2e/new-task.spec.ts" }], ALL_SPECS);
    expect(result.specs).toEqual(["new-task.spec.ts"]);
    expect(result.fullSuite).toBe(false);
  });

  test("pipeline-editor/** resolves to pipeline-editor.spec.ts only", () => {
    const result = resolveAffectedSpecs([{ path: "pipeline-editor/src/components/StepNode.tsx" }], ALL_SPECS);
    expect(result.specs).toEqual(["pipeline-editor.spec.ts"]);
    expect(result.fullSuite).toBe(false);
  });

  test("render-task-output.js resolves to live-task-output.spec.ts only", () => {
    const result = resolveAffectedSpecs([{ path: "src/api/public/render-task-output.js" }], ALL_SPECS);
    expect(result.specs).toEqual(["live-task-output.spec.ts"]);
    expect(result.fullSuite).toBe(false);
  });

  test("render-harness-preference.js resolves to board.spec.ts only", () => {
    const result = resolveAffectedSpecs([{ path: "src/api/public/render-harness-preference.js" }], ALL_SPECS);
    expect(result.specs).toEqual(["board.spec.ts"]);
    expect(result.fullSuite).toBe(false);
  });

  test("board-routes.js resolves to every spec that navigates the board, not the full suite", () => {
    const result = resolveAffectedSpecs([{ path: "src/api/public/board-routes.js" }], ALL_SPECS);
    expect(result.specs).toEqual([
      "board.spec.ts",
      "live-task-output.spec.ts",
      "new-task.spec.ts",
      "pipeline-editor.spec.ts",
      "pipelines.spec.ts",
      "projects.spec.ts",
      "theme.spec.ts",
    ]);
    expect(result.fullSuite).toBe(false);
  });

  test("board-new.js (the + New drawer's card search) resolves to new-task.spec.ts only", () => {
    for (const path of ["src/api/public/board-new.js", "src/api/public/board-new.d.ts"]) {
      const result = resolveAffectedSpecs([{ path }], ALL_SPECS);
      expect(result.specs).toEqual(["new-task.spec.ts"]);
      expect(result.fullSuite).toBe(false);
    }
  });

  // Since B1, board-pipelines.js's isPipelineRunRoot also picks the run
  // cards on the board, and board-runs.js draws every board card.
  test("board-pipelines.js and board-runs.js resolve to every spec that opens the board", () => {
    for (const path of [
      "src/api/public/board-pipelines.js",
      "src/api/public/board-pipelines.d.ts",
      "src/api/public/board-runs.js",
      "src/api/public/board-runs.d.ts",
    ]) {
      const result = resolveAffectedSpecs([{ path }], ALL_SPECS);
      expect(result.specs).toEqual([
        "board.spec.ts",
        "live-task-output.spec.ts",
        "new-task.spec.ts",
        "pipeline-editor.spec.ts",
        "pipelines.spec.ts",
        "projects.spec.ts",
        "theme.spec.ts",
      ]);
      expect(result.fullSuite).toBe(false);
    }
  });

  test("board-run-canvas.js (the run canvas page's layout) resolves to pipelines.spec.ts only", () => {
    for (const path of ["src/api/public/board-run-canvas.js", "src/api/public/board-run-canvas.d.ts"]) {
      const result = resolveAffectedSpecs([{ path }], ALL_SPECS);
      expect(result.specs).toEqual(["pipelines.spec.ts"]);
      expect(result.fullSuite).toBe(false);
    }
  });

  test("board.html change where every changed line is theme-related resolves to theme.spec.ts only", () => {
    const result = resolveAffectedSpecs(
      [
        {
          path: "src/api/public/board.html",
          changedLines: [
            '<button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>',
            "    document.documentElement.dataset.theme = theme;",
          ],
        },
      ],
      ALL_SPECS,
    );
    expect(result.specs).toEqual(["theme.spec.ts"]);
    expect(result.fullSuite).toBe(false);
  });

  test("board.html change with even one non-theme line falls back to the broad default, not the narrow theme subset", () => {
    const result = resolveAffectedSpecs(
      [
        {
          path: "src/api/public/board.html",
          changedLines: [
            '<button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>',
            '<div class="kcard">',
          ],
        },
      ],
      ALL_SPECS,
    );
    expect(result.fullSuite).toBe(false);
    expect(new Set(result.specs)).toEqual(new Set(ALL_SPECS));
  });

  test("board.html change with no changed-line content available falls back to the broad default", () => {
    const result = resolveAffectedSpecs([{ path: "src/api/public/board.html" }], ALL_SPECS);
    expect(result.fullSuite).toBe(false);
    expect(new Set(result.specs)).toEqual(new Set(ALL_SPECS));
  });

  test("server.ts is a named broad/shared dependency and triggers the full suite", () => {
    const result = resolveAffectedSpecs([{ path: "src/api/server.ts" }], ALL_SPECS);
    expect(result.fullSuite).toBe(true);
    expect(result.specs).toEqual(ALL_SPECS);
  });

  test("playwright.config.ts triggers the full suite", () => {
    const result = resolveAffectedSpecs([{ path: "playwright.config.ts" }], ALL_SPECS);
    expect(result.fullSuite).toBe(true);
    expect(result.specs).toEqual(ALL_SPECS);
  });

  test("e2e/fixtures/* triggers the full suite", () => {
    const result = resolveAffectedSpecs([{ path: "e2e/fixtures/harnesses.yaml" }], ALL_SPECS);
    expect(result.fullSuite).toBe(true);
    expect(result.specs).toEqual(ALL_SPECS);
  });

  test("an unrecognized/novel path conservatively falls back to the full suite, never to nothing", () => {
    const result = resolveAffectedSpecs([{ path: "src/core/some-brand-new-module.ts" }], ALL_SPECS);
    expect(result.fullSuite).toBe(true);
    expect(result.specs).toEqual(ALL_SPECS);
    expect(result.specs.length).toBeGreaterThan(0);
  });

  test("multiple narrowly-scoped changed files union their specs without pulling in the full suite", () => {
    const result = resolveAffectedSpecs(
      [{ path: "pipeline-editor/src/graph.ts" }, { path: "src/api/public/render-task-output.d.ts" }],
      ALL_SPECS,
    );
    expect(result.fullSuite).toBe(false);
    expect(new Set(result.specs)).toEqual(new Set(["pipeline-editor.spec.ts", "live-task-output.spec.ts"]));
  });

  test("one unrecognized path among otherwise-narrow changes still escalates the whole resolution to the full suite", () => {
    const result = resolveAffectedSpecs(
      [{ path: "pipeline-editor/src/graph.ts" }, { path: "some/totally/unknown/path.ts" }],
      ALL_SPECS,
    );
    expect(result.fullSuite).toBe(true);
    expect(result.specs).toEqual(ALL_SPECS);
  });
});
