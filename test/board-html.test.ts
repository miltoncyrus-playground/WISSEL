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
// docs/SDD-memory-injection-toggle.md §3.4/§4 test 7 — the Memory tab's
// description must track GET /memory's `injected` field rather than
// unconditionally claiming lessons reach every agent prompt, since
// injection is off by default (WISSEL_MEMORY_INJECTION).
test("the Memory tab's lede reflects GET /memory's injected field instead of assuming injection is on", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");

  const start = html.indexOf("function memoryLedeText(");
  const end = html.indexOf("function loadMemoryTab(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const memoryLedeText = new Function(`${html.slice(start, end)}\nreturn memoryLedeText;`)() as (injected: boolean) => string;

  expect(memoryLedeText(false)).toMatch(/not currently sent to agent prompts/i);
  expect(memoryLedeText(true)).toMatch(/folded into every agent's prompt/i);

  // loadMemoryTab must actually wire the fetched field through, not just
  // define the helper unused.
  const loadStart = html.indexOf("function loadMemoryTab(");
  const loadEnd = html.indexOf("fetch(\"/memory/history\")", loadStart);
  expect(loadStart).toBeGreaterThan(-1);
  expect(loadEnd).toBeGreaterThan(loadStart);
  const loadBody = html.slice(loadStart, loadEnd);
  expect(loadBody).toContain("ledeEl.textContent = memoryLedeText(!!data.injected);");
});

// docs/SDD-agent-harness-preference.md §3.7 (card 2). Runs board.html's
// real fleetHarnessesEl glue against a minimal stub DOM, fed by the real
// render-harness-preference.js, so the rendered text is proven to be
// exactly describeAgentHarnesses().text and each entry span carries its
// id and state. Also checks the glue is actually called from fleetRow
// and the panel uses formatHarnessCapacity.
test("fleet rows render the agent's harness list in order with live state; the harness panel shows active/max", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toContain('<script src="/render-harness-preference.js"></script>');

  const start = html.indexOf("function fleetHarnessesEl(");
  const end = html.indexOf("function renderFleetBoxes(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  type StubNode = { className?: string; dataset: Record<string, string>; children: StubNode[]; ownText: string; textContent: string; appendChild(c: StubNode): void };
  const makeNode = (text = ""): StubNode => {
    const node: StubNode = {
      dataset: {},
      children: [],
      ownText: text,
      get textContent() {
        return node.ownText + node.children.map((c) => c.textContent).join("");
      },
      set textContent(v: string) {
        node.ownText = v;
        node.children = [];
      },
      appendChild(c) {
        node.children.push(c);
      },
    };
    return node;
  };
  const document = { createElement: () => makeNode(), createTextNode: (t: string) => makeNode(t) };
  const render = await import("../src/api/public/render-harness-preference.js");
  const harnesses = [
    { id: "a", label: "Alpha", enabled: true, activeCount: 2, maxConcurrent: 2 },
    { id: "b", label: "Beta", enabled: true, activeCount: 0 },
  ];
  const fleetHarnessesEl = new Function("document", "describeAgentHarnesses", "harnesses", `${html.slice(start, end)}\nreturn fleetHarnessesEl;`)(
    document,
    render.describeAgentHarnesses,
    harnesses,
  ) as (a: { harnesses?: string[] }) => StubNode;

  const listed = fleetHarnessesEl({ harnesses: ["a", "b"] });
  expect(listed.dataset.harnessMode).toBe("list");
  expect(listed.textContent).toBe(render.describeAgentHarnesses({ harnesses: ["a", "b"] }, harnesses).text);
  expect(listed.textContent).toBe("Runs on: 1. Alpha (at capacity · 2/2 active) → 2. Beta (enabled)");
  const spans = listed.children.filter((c) => c.className);
  expect(spans.map((s) => [s.dataset.harnessId, s.className])).toEqual([
    ["a", "fleet-harness state-full"],
    ["b", "fleet-harness state-available"],
  ]);

  const any = fleetHarnessesEl({});
  expect(any.dataset.harnessMode).toBe("any");
  expect(any.textContent).toBe("Runs on: any enabled harness");

  const fleetRow = html.slice(html.indexOf("function fleetRow("), html.indexOf("function fleetHarnessesEl("));
  expect(fleetRow).toContain("main.appendChild(fleetHarnessesEl(a));");

  const panel = html.slice(html.indexOf("function renderHarnessPanel("), html.indexOf("function renderHarnessPanel(") + 3000);
  expect(panel).toContain("var capacity = formatHarnessCapacity(h);");
  expect(panel).toContain('if (harnessPreferenceState(h) === "full") metaBits.push("at capacity");');
});

test("the MCP add-server form opts out of native constraint validation so its own inline error can render", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toMatch(/<form id="mcpAddForm" novalidate>/);
});
