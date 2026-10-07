import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { BOARD_ROUTES, BOARD_ROUTE_REDIRECTS, boardRouteHash, parseBoardRoute } from "../src/api/public/board-routes.js";

// docs/SDD-ui-cleanup.md §3.1 (card A1): the board shell's hash routes.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

test("every route the SDD names parses to itself", () => {
  for (const route of [
    "board",
    "board/features",
    "pipelines",
    "pipelines/new",
    "archive",
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

// Card B2 (§4.2): the editor is a page in the shell, under Pipelines.
test("#/pipelines/edit/<id> parses the pipeline id, and round-trips through boardRouteHash", () => {
  const route = "pipelines/edit/:id";
  expect(parseBoardRoute("#/pipelines/edit/abc-123")).toEqual({ route, known: true, params: { id: "abc-123" } });
  expect(parseBoardRoute("#/pipelines/edit/abc-123/")).toEqual({ route, known: true, params: { id: "abc-123" } });
  for (const id of ["abc-123", "a b/c?d#e", "üñí", ":id"]) {
    const hash = boardRouteHash(route, { id });
    expect(hash.startsWith("#/pipelines/edit/")).toBe(true);
    expect(parseBoardRoute(hash)).toEqual({ route, known: true, params: { id } });
  }
  // The server's redirect from the old /pipelines/edit/<id> keeps the
  // segment URL-encoded; it decodes here.
  expect(parseBoardRoute("#/pipelines/edit/a%20b").params).toEqual({ id: "a b" });
});

test("a param route without exactly one valid segment is unknown", () => {
  for (const hash of ["#/pipelines/edit/a/b", "#/pipelines/edit/%E0%A4%A", "#/pipelines/new/x", "#/pipelines/x/abc"]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "board", known: false });
  }
});

test("#/pipelines/edit with no id is a new pipeline", () => {
  for (const hash of ["#/pipelines/edit", "#/pipelines/edit/"]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "pipelines/new", known: true, redirected: true });
  }
});

test("boardRouteHash leaves a route without params alone, and encodes a missing param as empty", () => {
  expect(boardRouteHash("pipelines/new", { id: "x" })).toBe("#/pipelines/new");
  expect(boardRouteHash("pipelines/edit/:id")).toBe("#/pipelines/edit/");
});

test("the editor routes show the editor page and keep Pipelines highlighted", () => {
  expect(BOARD_ROUTES["pipelines/new"]).toEqual({ page: "pipelineEditorPage", nav: "pipelines", editor: "new" });
  expect(BOARD_ROUTES["pipelines/edit/:id"]).toEqual({ page: "pipelineEditorPage", nav: "pipelines", editor: "edit" });
  const withParam = Object.keys(BOARD_ROUTES).filter((r) => r.includes(":"));
  expect(withParam).toEqual(["pipelines/edit/:id", "pipelines/run/:runId"]);
});

// Card B3 (§4.3): a run on its pipeline graph, under Pipelines.
test("#/pipelines/run/<runId> parses the run id, round-trips, and shows the canvas page under Pipelines", () => {
  const route = "pipelines/run/:runId";
  expect(BOARD_ROUTES[route]).toEqual({ page: "runCanvasPage", nav: "pipelines" });
  expect(parseBoardRoute("#/pipelines/run/r-123")).toEqual({ route, known: true, params: { runId: "r-123" } });
  for (const runId of ["r-123", "a b/c?d#e", "üñí", ":runId"]) {
    expect(parseBoardRoute(boardRouteHash(route, { runId }))).toEqual({ route, known: true, params: { runId } });
  }
  for (const hash of ["#/pipelines/run", "#/pipelines/run/", "#/pipelines/run/a/b"]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "board", known: false });
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

// Card A3 (§3.3): the New task view became the "+ New" drawer. Its old
// URL still works: it lands on the board with the drawer on the Task tab.
test("the old #/new URL redirects to the board with the New drawer's Task tab", () => {
  for (const hash of ["#/new", "#new", "#/new/", "/new"]) {
    expect(parseBoardRoute(hash)).toEqual({ route: "board", known: true, redirected: true, openNew: "task" });
  }
  expect(Object.prototype.hasOwnProperty.call(BOARD_ROUTES, "new")).toBe(false);
});

test("every redirect targets a real route, and any drawer tab it opens is real", () => {
  for (const [from, r] of Object.entries(BOARD_ROUTE_REDIRECTS)) {
    expect(Object.prototype.hasOwnProperty.call(BOARD_ROUTES, from)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(BOARD_ROUTES, r.to)).toBe(true);
    if (r.openNew !== undefined) expect(["task", "pipeline"]).toContain(r.openNew);
  }
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
  const pageIds = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"[^>]*\bdata-page\b/g)].map((m) => m[1]);
  const expected = [...new Set(Object.values(BOARD_ROUTES).map((d) => d.page))];
  expect(pageIds.sort()).toEqual(expected.sort());
});

test("every sidebar link's data-route is a real route, and every nav target has a link", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const sidebar = html.slice(html.indexOf('<nav class="sidebar"'), html.indexOf("</nav>"));
  const links = [...sidebar.matchAll(/<a class="nav-item" href="([^"]+)" data-route="([^"]+)"/g)].map((m) => ({ href: m[1]!, route: m[2]! }));

  // Card A4 (§3.4) replaced A1's link out to the editor with a page.
  expect(sidebar).not.toContain('href="/pipelines/edit"');
  for (const { href, route } of links) {
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
