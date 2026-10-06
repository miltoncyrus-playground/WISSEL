// Pure: the board shell's hash routes (docs/SDD-ui-cleanup.md §3.1). No
// DOM, no side effects — same house style as render-merge-health.js, and
// directly `import`-able from bun test the same way (see the
// module.exports guard at the bottom). board.html's own glue is just:
//   var parsed = parseBoardRoute(location.hash);
//   var def = BOARD_ROUTES[parsed.route];
// then show the section whose id is def.page and mark the sidebar link
// whose data-route is def.nav as aria-current.
//
// `page` is the id of the <section data-page> to show. `nav` is the
// sidebar link to highlight. `boardView` picks the Board page's Lanes /
// By feature switch.
var BOARD_ROUTES = {
  board: { page: "boardPage", nav: "board", boardView: "lanes" },
  "board/features": { page: "boardPage", nav: "board", boardView: "features" },
  archive: { page: "archivePanel", nav: "archive" },
  "setup/agents": { page: "agentsPage", nav: "setup/agents" },
  "setup/harnesses": { page: "harnessPanel", nav: "setup/harnesses" },
  "setup/mcp": { page: "mcpPanel", nav: "setup/mcp" },
  "setup/projects": { page: "projectsPanel", nav: "setup/projects" },
  "setup/memory": { page: "memoryPanel", nav: "setup/memory" },
  "setup/settings": { page: "settingsPage", nav: "setup/settings" },
};

// Old URLs that are no longer pages. `#/new` was the New task view until
// card A3 (§3.3) turned it into the "+ New" drawer: it now lands on `to`
// with the drawer open on the `openNew` tab, and the caller rewrites the
// address bar to `to` so a reload doesn't reopen the drawer.
var BOARD_ROUTE_REDIRECTS = {
  new: { to: "board", openNew: "task" },
};

// "#/setup/harnesses", "#setup/harnesses/" and "/setup/harnesses" all
// mean the same route. An empty hash is the board (`known: true`, so
// the caller leaves a bare /board URL alone). A redirect resolves to its
// target with `redirected: true` and its `openNew` tab. Anything else
// falls back to the board with `known: false`, so the caller can rewrite
// the URL instead of leaving a dead hash in the address bar.
function parseBoardRoute(hash) {
  var path = String(hash || "").replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return { route: "board", known: true };
  if (Object.prototype.hasOwnProperty.call(BOARD_ROUTES, path)) return { route: path, known: true };
  if (Object.prototype.hasOwnProperty.call(BOARD_ROUTE_REDIRECTS, path)) {
    var r = BOARD_ROUTE_REDIRECTS[path];
    return { route: r.to, known: true, redirected: true, openNew: r.openNew };
  }
  return { route: "board", known: false };
}

function boardRouteHash(route) {
  return "#/" + route;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    BOARD_ROUTES: BOARD_ROUTES,
    BOARD_ROUTE_REDIRECTS: BOARD_ROUTE_REDIRECTS,
    parseBoardRoute: parseBoardRoute,
    boardRouteHash: boardRouteHash,
  };
}
