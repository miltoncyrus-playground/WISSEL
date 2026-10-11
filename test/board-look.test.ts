import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastRatio } from "../app/src/tokens";

// The board's news-site look (docs/SDD-ui-cleanup.md §3.1, reference:
// docs/mockups/techcrunch-board/). Gate test: the colour tokens in
// src/api/public/board.html stay readable in both themes, the two dark
// blocks stay in sync, and the nav is a header, not a sidebar.

const html = readFileSync(join(import.meta.dir, "../src/api/public/board.html"), "utf8");

/** Custom properties declared in the first block that follows `marker`. */
function tokens(marker: string): Record<string, string> {
  const start = html.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const open = html.indexOf("{", start);
  const close = html.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of html.slice(open, close).matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = tokens("  :root {\n    color-scheme: light;");
const darkMedia = tokens('@media (prefers-color-scheme: dark) {\n    :root:not([data-theme="light"])');
const darkExplicit = tokens(':root[data-theme="dark"] {');

// Text colours the board draws on --page and --surface.
const TEXT = ["ink-1", "ink-2", "ink-muted", "accent", "critical", "no-match", "skill", "sig-done", "sig-running"];
const GROUNDS = ["page", "surface"];

describe("board colour tokens", () => {
  test("light and both dark blocks define the same token names", () => {
    expect(Object.keys(darkExplicit).sort()).toEqual(Object.keys(darkMedia).sort());
    for (const name of Object.keys(darkExplicit)) expect(Object.keys(light), name).toContain(name);
  });

  test("the OS-preference dark block and the explicit dark block have identical values", () => {
    expect(darkMedia).toEqual(darkExplicit);
  });

  test.each([
    ["light", light],
    ["dark", { ...light, ...darkExplicit }],
  ] as const)("%s: text tokens read at 4.5:1 on the page and the surface", (_theme, t) => {
    for (const fg of TEXT) for (const bg of GROUNDS) expect(contrastRatio(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  test.each([
    ["light", light],
    ["dark", { ...light, ...darkExplicit }],
  ] as const)("%s: button text (--on-accent) reads on the accent fill", (_theme, t) => {
    expect(contrastRatio(t["on-accent"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
  });

  test("the page colours are the spec's: white and near-black grounds", () => {
    expect(light.page).toBe("#ffffff");
    expect(darkExplicit.page).toBe("#0d110e");
    expect(light.accent).toBe("#1a7e4c");
  });

  test("no button or card hard-codes white text on the accent (it would fail in dark)", () => {
    expect(html).not.toMatch(/background: var\(--accent\)[^;}]*;[^}]*color: #fff/);
  });
});

describe("board shell", () => {
  test("the nav keeps its id and classes but is laid out as a header row", () => {
    expect(html).toContain('<nav class="sidebar" id="sidebar" aria-label="Main">');
    const rule = html.slice(html.indexOf("  .sidebar {"), html.indexOf("}", html.indexOf("  .sidebar {")));
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("flex-direction: row");
    expect(html).not.toContain("grid-template-columns: 200px minmax(0, 1fr)");
  });

  test("Figtree is loaded from the same Google Fonts link as the mono face", () => {
    expect(html).toMatch(/fonts\.googleapis\.com\/css2\?family=Figtree[^"]*family=IBM\+Plex\+Mono/);
  });
});
