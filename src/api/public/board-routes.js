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
// sidebar link to highlight (null: none, e.g. the New task view, which
// is reached from the top bar's "+ New"). `boardView` picks the Board
// page's Lanes / By feature switch.
var BOARD_ROUTES = {
  board: { page: "boardPage", nav: "board", boardView: "lanes" },
  "board/features": { page: "boardPage", nav: "board", boardView: "features" },
  archive: { page: "archivePanel", nav: "archive" },
  new: { page: "newTaskPanel", nav: null },
  "setup/agents": { page: "agentsPage", nav: "setup/agents" },
  "setup/harnesses": { page: "harnessPanel", nav: "setup/harnesses" },
  "setup/mcp": { page: "mcpPanel", nav: "setup/mcp" },
  "setup/projects": { page: "projectsPanel", nav: "setup/projects" },
  "setup/memory": { page: "memoryPanel", nav: "setup/memory" },
  "setup/settings": { page: "settingsPage", nav: "setup/settings" },
};

// "#/setup/harnesses", "#setup/harnesses/" and "/setup/harnesses" all
// mean the same route. An empty hash is the board (`known: true`, so
// the caller leaves a bare /board URL alone). Anything else falls back
// to the board with `known: false`, so the caller can rewrite the URL
// instead of leaving a dead hash in the address bar.
function parseBoardRoute(hash) {
  var path = String(hash || "").replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return { route: "board", known: true };
  if (Object.prototype.hasOwnProperty.call(BOARD_ROUTES, path)) return { route: path, known: true };
  return { route: "board", known: false };
}

function boardRouteHash(route) {
  return "#/" + route;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { BOARD_ROUTES: BOARD_ROUTES, parseBoardRoute: parseBoardRoute, boardRouteHash: boardRouteHash };
}
