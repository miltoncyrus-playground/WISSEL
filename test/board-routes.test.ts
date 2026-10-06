import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { BOARD_ROUTES, boardRouteHash, parseBoardRoute } from "../src/api/public/board-routes.js";

// docs/SDD-ui-cleanup.md §3.1 (card A1): the board shell's hash routes.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

test("every route the SDD names parses to itself", () => {
  for (const route of [
    "board",
    "board/features",
    "archive",
    "new",
    "setup/agents",
    "setup/harnesses",
    "setup/mcp",
    "setup/projects",
    "setup/memory",
    "setup/settings",
  ]) {
    expect(parseBoardRoute(boardRouteHash(route))).toEqual({ route, known: true });
  }
});

test("an empty hash is the board, and known, so a bare /board URL is left alone", () => {
  for (const hash of ["", "#", "#/", null, undefined]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "board", known: true });
  }
});

test("leading/trailing slashes and a missing slash after # don't change the route", () => {
  expect(parseBoardRoute("#setup/harnesses")).toEqual({ route: "setup/harnesses", known: true });
  expect(parseBoardRoute("#/setup/harnesses/")).toEqual({ route: "setup/harnesses", known: true });
  expect(parseBoardRoute("/setup/harnesses")).toEqual({ route: "setup/harnesses", known: true });
});

test("an unknown hash falls back to the board and says it was unknown", () => {
  for (const hash of ["#/nope", "#/setup", "#/setup/unknown", "#/Board", "#/constructor", "#/__proto__", "#/toString"]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "board", known: false });
  }
});

test("only Board's two views carry a boardView, and both highlight the Board nav item", () => {
  expect(BOARD_ROUTES.board).toMatchObject({ page: "boardPage", nav: "board", boardView: "lanes" });
  expect(BOARD_ROUTES["board/features"]).toMatchObject({ page: "boardPage", nav: "board", boardView: "features" });
  for (const [route, def] of Object.entries(BOARD_ROUTES)) {
    if (route === "board" || route === "board/features") continue;
    expect(def.boardView).toBeUndefined();
  }
});

// The routes table and board.html's markup are edited by hand in two
// files; this is what keeps them from drifting apart.
test("board.html has a [data-page] section for every route's page, and nothing else is a page", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const pageIds = [...html.matchAll(/<section id="([^"]+)"[^>]*\bdata-page\b/g)].map((m) => m[1]);
  // newTaskPanel keeps its class attribute ahead of the id.
  for (const m of html.matchAll(/<section class="[^"]*" id="([^"]+)"[^>]*\bdata-page\b/g)) pageIds.push(m[1]);
  const expected = [...new Set(Object.values(BOARD_ROUTES).map((d) => d.page))];
  expect(pageIds.sort()).toEqual(expected.sort());
});

test("every sidebar link's data-route is a real route (or the external Pipelines link), and every nav target has a link", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>"));
  const links = [...sidebar.matchAll(/<a class="nav-item" href="([^"]+)" data-route="([^"]+)"/g)].map((m) => ({ href: m[1]!, route: m[2]! }));

  for (const { href, route } of links) {
    if (route === "pipelines") {
      // Placeholder until card A4: the editor, outside the shell.
      expect(href).toBe("/pipelines/edit");
      continue;
    }
    expect(Object.prototype.hasOwnProperty.call(BOARD_ROUTES, route)).toBe(true);
    expect(href).toBe(boardRouteHash(route));
  }

  const linked = new Set(links.map((l) => l.route));
  for (const def of Object.values(BOARD_ROUTES)) {
    if (def.nav) expect(linked.has(def.nav)).toBe(true);
  }
  // Work: Board, Pipelines, Archive. Setup: the six pages. In that order.
  expect(links.map((l) => l.route)).toEqual([
    "board",
    "pipelines",
    "archive",
    "setup/agents",
    "setup/harnesses",
    "setup/mcp",
    "setup/projects",
    "setup/memory",
    "setup/settings",
  ]);
});

test("board.html loads board-routes.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-routes.js"></script>');
  expect(tag).toBeGreaterThan(-1);
  expect(tag).toBeLessThan(html.indexOf("function applyRoute("));
});

test("GET /board-routes.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
  const res = await app(new Request("http://localhost/board-routes.js"));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("function parseBoardRoute(");
  expect(body).toContain("var BOARD_ROUTES = {");
});
