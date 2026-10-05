import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

// A syntax error in board.html's inline <script> blocks would otherwise
// only surface by actually opening the page in a browser — this catches
// it at test time instead, same value `bun run typecheck` gives the TS
// side of the codebase.
test("every inline <script> block in board.html is syntactically valid JavaScript", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).filter((body) => body.trim() !== "");
  expect(blocks.length).toBeGreaterThan(0);
  for (const body of blocks) {
    expect(() => new Function(body)).not.toThrow();
  }
});

// docs/SDD-live-task-output.md §3.6/§6 — the live-output modal's markup,
// its dedicated render script tag, and its wiring points must actually
// be present; a regression here would silently drop the feature from
// the served page without any other test catching it.
test("board.html wires up the live output modal — markup, render script, and the card/drawer entry points", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");

  expect(html).toContain('<script src="/render-task-output.js"></script>');
  expect(html).toContain('id="liveOutputPanel"');
  expect(html).toContain('id="loOverlay"');
  expect(html).toContain('id="loRows"');
  expect(html).toContain('id="loClose"');

  expect(html).toContain("function openLiveOutput(");
  expect(html).toContain("function closeLiveOutput(");
  expect(html).toContain("function renderLiveOutputRows(");
  expect(html).toContain("function taskOutputIsLive(");
  expect(html).toContain("function liveOutputButton(");

  // The two data sources §3.4/§3.6 call for: SSE while in flight,
  // snapshot fetch once finished.
  expect(html).toContain("/output/stream");
  expect(html).toContain('fetch("/tasks/" + taskId + "/output")');

  // Card-level entry points (kanban + swimlane) and the drawer action.
  expect(html.match(/liveOutputButton\(t\)/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain('drawerAction(taskOutputIsLive(task) ? "Live output" : "View output"');
});

// docs/SDD-crash-recovery.md §3.2/§4 — the dangling-merge warning
// banner's markup, its render script tag, and its wiring points must
// actually be present, hidden by default (no in-progress merge detected
// until the first fetch resolves), and driven by a real `/merge-health`
// fetch — not a theoretical feature that looks wired but never runs.
test("board.html wires up the merge-health banner — markup, render script, and the fetch wiring", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");

  expect(html).toContain('<script src="/render-merge-health.js"></script>');
  expect(html).toContain('id="mergeHealthBanner"');
  // Hidden by default in markup — the banner only becomes visible once
  // formatMergeHealthBanner (render-merge-health.js) decides there's
  // something to show; it never starts visible before any fetch runs.
  expect(html).toMatch(/<div class="merge-health-banner" id="mergeHealthBanner" hidden><\/div>/);

  expect(html).toContain("function renderMergeHealthBanner(");
  expect(html).toContain("formatMergeHealthBanner(mergeHealth)");

  // Wired into both the initial page load and the SSE-driven refetch —
  // a dangling merge appearing/resolving after page load must still
  // reach the banner, not just at first load.
  expect(html.match(/fetch\("\/merge-health"\)/g)?.length).toBe(2);
  expect(html).toContain("renderMergeHealthBanner();");
});

// Real defect found investigating board.spec.ts's non-deterministic
// failures: every SSE message triggers an unguarded refetchTasks(), so
// a burst of task mutations (several tests in the e2e suite fire these)
// can let a slower, earlier-started call's response land after a
// faster, later one's and clobber already-applied state with stale
// data — with no further SSE event left to correct it. refetchTasks()
// also had no error handling, so a single rejected fetch silently
// froze the board on stale data forever. Checked as a substring of the
// function itself (not just present somewhere in the file) so this
// can't pass by coincidentally matching unrelated code elsewhere.
test("refetchTasks discards out-of-order responses and surfaces a failed fetch instead of silently freezing the board", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const start = html.indexOf("function refetchTasks()");
  const end = html.indexOf("function renderProjectSwitcher(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = html.slice(start, end);

  // Out-of-order guard: compares against the latest *applied* response,
  // never against a still-pending request's own counter — see
  // loadDrawerResult's own comment for why that alternative starves
  // under sustained traffic instead of just discarding stale data.
  expect(body).toContain("if (seq < appliedRefetchSeq) return;");
  expect(body).toContain("appliedRefetchSeq = seq;");

  // A rejected fetch must be visible, not an unhandled rejection.
  expect(body).toMatch(/\.catch\(function \(err\) \{/);
});

// Real defect found investigating board.spec.ts's non-deterministic
// failures: e2e/board.spec.ts used to open a task's drawer via
// getByText(task.title, { exact: true }).click() on #kanbanBody, which
// breaks the moment a pushback/retry/approve lineage produces a second
// card sharing byte-identical full title text (e.g. an auto-spawned
// "Review: <title>" card) — Playwright's strict mode then throws on
// multiple matching elements instead of picking "the" card. A stable
// per-task attribute is the only locator that can disambiguate that
// case, so buildKanbanCard must stamp one on every card it builds.
test("buildKanbanCard stamps a stable data-task-id attribute on every kanban card", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const start = html.indexOf("function buildKanbanCard(");
  const end = html.indexOf("function renderKanban(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = html.slice(start, end);

  expect(body).toContain("card.dataset.taskId = t.id;");
});

// Real defect found investigating board.spec.ts's non-deterministic
// failures: #mcpAddForm's submit handler already does its own
// required-field checks and renders them into #mcpAddError, but
// #mcpAddId/#mcpAddLabel also carry the native HTML `required`
// attribute. Without `novalidate` on the form, Chromium's own
// constraint validation intercepts the submit click before that
// handler ever runs whenever a required field is blank, so
// #mcpAddError never appears — e2e/board.spec.ts's "blank required
// field" test failed deterministically on every run for exactly this
// reason, confirmed by reading the submit handler against the form's
// own markup.
test("the MCP add-server form opts out of native constraint validation so its own inline error can render", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toMatch(/<form id="mcpAddForm" novalidate>/);
});
