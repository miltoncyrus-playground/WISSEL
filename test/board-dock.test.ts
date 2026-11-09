import { expect, test } from "bun:test";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// docs/SDD-coordinator-dock.md R4 and §5: the dock's resize handle as
// markup, and the constraints on board.html's inline script. The
// behaviour itself (drag, keys, the saved width) is Playwright's, in
// e2e/coordinator-window.spec.ts.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");
const html = await readFile(BOARD_HTML_PATH, "utf8");

/** The dock's markup: from the aside's opening tag to its close. */
function dockMarkup(): string {
  const start = html.indexOf('<aside class="drawer coord-dock" id="coordDock"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</aside>", start);
  return html.slice(start, end);
}

/** The inline script block that wires the dock (the comment names it). */
function dockScript(): string {
  const start = html.indexOf("// Coordinator window dock (docs/SDD-coordinator.md §4.14).");
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</script>", start);
  return html.slice(start, end);
}

test("the handle is a vertical separator on the dock with the 320-560 range (R4)", () => {
  const aside = dockMarkup();
  const handle = aside.match(/<div class="coord-resize"[^>]*>/)?.[0] ?? "";
  expect(handle).toContain('id="coordResize"');
  expect(handle).toContain('role="separator"');
  expect(handle).toContain('aria-orientation="vertical"');
  expect(handle).toContain('aria-label="Resize coordinator window"');
  expect(handle).toContain('aria-valuemin="320"');
  expect(handle).toContain('aria-valuemax="560"');
  expect(handle).toContain('aria-valuenow="380"');
  expect(handle).toContain('tabindex="0"');
});

test("the dock script keeps the width in localStorage, every access inside a try (§5)", () => {
  const script = dockScript();
  expect(script).toContain('"wissel-coord-width"');
  const lines = script.split("\n").filter((l) => l.includes("localStorage") && !l.trim().startsWith("//"));
  expect(lines.length).toBeGreaterThanOrEqual(2); // read and write
  for (const line of lines) expect(line, `unguarded: ${line.trim()}`).toContain("try {");
});

test("the dock's limits and step are the SDD's: 320 to 560 by 16, 380 by default, a 44 px rail", () => {
  const script = dockScript();
  expect(script).toMatch(/MIN_W = 320\b/);
  expect(script).toMatch(/MAX_W = 560\b/);
  expect(script).toMatch(/STEP_W = 16\b/);
  expect(script).toMatch(/DEFAULT_W = 380\b/);
  expect(script).toMatch(/RAIL_W = 44\b/);
});

test("the header has the collapse button and the dock a rail with the label and the count (R5)", () => {
  const aside = dockMarkup();
  const head = aside.slice(aside.indexOf('<div class="drawer-head">'), aside.indexOf("</div>", aside.indexOf('<div class="drawer-head">')));
  const button = head.match(/<button[^>]*id="coordCollapse"[^>]*>/)?.[0] ?? "";
  expect(button, "the collapse button is in the header").not.toBe("");
  expect(button).toContain('aria-expanded="true"');
  expect(button).toContain('aria-label="Collapse coordinator window"');
  const railEl = aside.match(/<button[^>]*id="coordRail"[^>]*>/)?.[0] ?? "";
  expect(railEl).toContain('class="coord-rail"');
  expect(aside).toContain('<span class="coord-rail-label">Coordinator</span>');
  expect(aside).toContain('id="coordRailCount"');
  // The rail's vertical label and 44px width are CSS, not script.
  expect(html).toMatch(/\.coord-rail-label\s*\{[^}]*writing-mode:\s*vertical-rl/);
});

test("the collapsed state is kept in localStorage under its own key, inside a try (R5, §5)", () => {
  const script = dockScript();
  expect(script).toContain('"wissel-coord-collapsed"');
  const lines = script.split("\n").filter((l) => l.includes("COLLAPSED_KEY") && l.includes("localStorage"));
  expect(lines.length).toBeGreaterThanOrEqual(2); // read, write and clear
  for (const line of lines) expect(line, `unguarded: ${line.trim()}`).toContain("try {");
});

test("board.html's inline script parses: node --check on the extracted script passes (§5)", async () => {
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
  expect(blocks.length).toBeGreaterThan(0);
  const dir = await mkdtemp(join(tmpdir(), "wissel-board-script-"));
  try {
    for (const [i, body] of blocks.entries()) {
      const file = join(dir, `inline-${i}.js`);
      await writeFile(file, body);
      const run = Bun.spawnSync(["node", "--check", file], { stderr: "pipe", stdout: "pipe" });
      expect(run.exitCode, `script block ${i}: ${run.stderr.toString()}`).toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
