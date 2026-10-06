/**
 * Hand-maintained map from source file paths to the e2e spec file(s)
 * that actually exercise them, plus the pure (no git, no filesystem, no
 * Playwright) resolution logic that turns a list of changed paths into
 * a list of affected specs.
 *
 * This is deliberately NOT an automatic/clever dependency inference —
 * every rule below is a specific claim this author verified by reading
 * the actual spec files and source (grep citations in each rule's
 * description). An explicit map that's wrong in an *obvious* way is
 * easier to fix than a heuristic that's wrong in a subtle one.
 *
 * Safety invariant: a path that matches no rule below resolves to the
 * FULL suite, never to nothing. See resolveAffectedSpecs's fallback.
 *
 * THIS MAP (AND THE SCRIPT THAT USES IT, scripts/e2e-affected.ts) IS A
 * SPEED TOOL FOR FAST ITERATION. IT IS NOT A SHIPPING GATE. A scoped
 * pass only proves the spec(s) it ran are green — it never proves
 * nothing else broke. Always run the full suite (`bun run test:e2e`)
 * before merging/shipping.
 */

/** "ALL" means "run every spec" — used both for files that are
 *  genuinely broad/shared (documented, intentional) and as the
 *  fallback for any path this map doesn't recognize at all. */
export type SpecList = string[] | "ALL";

export interface FileRule {
  /** Human-readable justification, shown in the CLI's output so the
   *  "why" is visible, not just the "what". */
  description: string;
  match: (path: string) => boolean;
  resolve: (path: string, changedLines: string[] | undefined) => SpecList;
}

/** Only board.html's theme toggle (CSS tokens, #themeToggle markup, and
 *  the applyTheme/restore-on-load JS) uses the word "theme" — verified
 *  live via `grep -n "theme\|Theme" src/api/public/board.html`: every
 *  one of the ~17 hits is in the :root[data-theme] CSS blocks, the
 *  #themeToggle markup, or the applyTheme/restoreTheme JS functions.
 *  Nothing else in the file's ~3900 lines happens to contain the
 *  substring, so matching on it is safe, not just convenient. */
const THEME_MARKER = /theme/i;

/** board.html is one monolithic page. Verified (grep) it contains the
 *  markup/JS for: the theme toggle, the new-task form (#ntTitle etc.),
 *  the projects panel (#projLocalForm etc.), the live-output panel
 *  (#liveOutputPanel, calls renderTaskOutputRows), and the
 *  `/pipelines/edit` nav link that pipeline-editor.spec.ts asserts on.
 *  So any change to the file that isn't provably confined to the theme
 *  section (see THEME_MARKER) conservatively triggers every spec that
 *  touches board.html at all. */
const BOARD_HTML_DEFAULT_SPECS: string[] = [
  "theme.spec.ts",
  "board.spec.ts",
  "new-task.spec.ts",
  "projects.spec.ts",
  "live-task-output.spec.ts",
  "pipeline-editor.spec.ts",
];

function resolveBoardHtml(changedLines: string[] | undefined): SpecList {
  // No hunk content available (e.g. a rename, or a diff this script
  // couldn't read) — can't prove the change is theme-only, so fall
  // back to the documented default rather than guess narrow.
  if (!changedLines || changedLines.length === 0) return BOARD_HTML_DEFAULT_SPECS;
  const everyLineIsThemeRelated = changedLines.every((line) => THEME_MARKER.test(line));
  return everyLineIsThemeRelated ? ["theme.spec.ts"] : BOARD_HTML_DEFAULT_SPECS;
}

export const FILE_RULES: FileRule[] = [
  {
    description: "A spec file changing should always re-run itself.",
    match: (p) => /^e2e\/[^/]+\.spec\.ts$/.test(p),
    resolve: (p) => [p.slice("e2e/".length)],
  },
  {
    description:
      "pipeline-editor/ is its own isolated Vite app (pipeline-editor/src/**) — only pipeline-editor.spec.ts drives it, over the real /pipelines/* API (covered separately by the server.ts rule below).",
    match: (p) => p === "pipeline-editor" || p.startsWith("pipeline-editor/"),
    resolve: () => ["pipeline-editor.spec.ts"],
  },
  {
    description:
      "render-task-output.js/.d.ts is only loaded by board.html's live-output panel — verified (grep) renderTaskOutputRows is called nowhere else in board.html, and no other spec references #liveOutputPanel.",
    match: (p) => p === "src/api/public/render-task-output.js" || p === "src/api/public/render-task-output.d.ts",
    resolve: () => ["live-task-output.spec.ts"],
  },
  {
    description:
      "render-harness-preference.js/.d.ts is only used by board.html's fleet rows (fleetHarnessesEl) and Manage harnesses panel — verified (grep) only board.spec.ts asserts on #agentsBox .fleet-harnesses and #harnessPanel.",
    match: (p) => p === "src/api/public/render-harness-preference.js" || p === "src/api/public/render-harness-preference.d.ts",
    resolve: () => ["board.spec.ts"],
  },
  {
    description:
      "board-routes.js/.d.ts decides which board.html page shows for a URL hash, so every spec that opens /board and navigates it depends on it — the same set as a non-theme board.html change.",
    match: (p) => p === "src/api/public/board-routes.js" || p === "src/api/public/board-routes.d.ts",
    resolve: () => BOARD_HTML_DEFAULT_SPECS,
  },
  {
    description:
      "board.html is shared by nearly every spec (see BOARD_HTML_DEFAULT_SPECS's own comment) — defaults to that broad set, UNLESS every changed line matches the theme-only marker, which is verified to appear nowhere else in the file.",
    match: (p) => p === "src/api/public/board.html",
    resolve: (_p, changedLines) => resolveBoardHtml(changedLines),
  },
  {
    description:
      "server.ts is the single shared HTTP router every spec's webServer hits for every request — the definition of broad/shared, so it conservatively triggers the full suite rather than trying to map individual route blocks to specs.",
    match: (p) => p === "src/api/server.ts",
    resolve: () => "ALL",
  },
  {
    description: "playwright.config.ts controls env/fixtures/browser resolution for every spec's webServer boot.",
    match: (p) => p === "playwright.config.ts",
    resolve: () => "ALL",
  },
  {
    description:
      "e2e/fixtures/* is copied into place before every single spec's webServer boots (see playwright.config.ts's webServer.command), so every spec depends on it.",
    match: (p) => p === "e2e/fixtures" || p.startsWith("e2e/fixtures/"),
    resolve: () => "ALL",
  },
];

export interface ChangedFileInput {
  path: string;
  /** Added/removed line content (no leading +/- marker) from the diff
   *  hunk, when available. Only consulted by rules that need sub-file
   *  resolution (currently just board.html's). */
  changedLines?: string[];
}

export interface FileResolution {
  path: string;
  specs: SpecList;
  reason: string;
}

export interface ResolveResult {
  /** The affected spec filenames, filtered to allSpecs's order. Equals
   *  allSpecs itself when fullSuite is true. */
  specs: string[];
  /** True when at least one changed path resolved to "ALL" — either an
   *  explicit broad/shared rule, or an unrecognized path falling back. */
  fullSuite: boolean;
  files: FileResolution[];
}

/**
 * Pure resolution: no git, no filesystem, no Playwright. Given the
 * changed files (and, for rules that need it, their changed line
 * content) plus the full list of real spec filenames, returns exactly
 * which specs are affected.
 */
export function resolveAffectedSpecs(changed: ChangedFileInput[], allSpecs: string[]): ResolveResult {
  if (changed.length === 0) return { specs: [], fullSuite: false, files: [] };

  const files: FileResolution[] = [];
  const matchedSpecs = new Set<string>();
  let fullSuite = false;

  for (const { path, changedLines } of changed) {
    const rule = FILE_RULES.find((r) => r.match(path));
    if (!rule) {
      files.push({
        path,
        specs: "ALL",
        reason: "No rule in scripts/e2e-affected-map.ts recognizes this path — conservatively running the full suite.",
      });
      fullSuite = true;
      continue;
    }

    const resolved = rule.resolve(path, changedLines);
    files.push({ path, specs: resolved, reason: rule.description });
    if (resolved === "ALL") {
      fullSuite = true;
    } else {
      for (const spec of resolved) matchedSpecs.add(spec);
    }
  }

  const specs = fullSuite ? [...allSpecs] : allSpecs.filter((s) => matchedSpecs.has(s));
  return { specs, fullSuite, files };
}
