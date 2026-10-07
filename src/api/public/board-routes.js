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
// By feature switch. `editor` marks the pipeline editor's two routes
// (card B2, §4.2), which mount the editor bundle into `page`.
//
// A `:name` segment matches any one non-empty segment and comes back as
// `params.name` (only `pipelines/edit/:id` uses one).
var BOARD_ROUTES = {
  board: { page: "boardPage", nav: "board", boardView: "lanes" },
  "board/features": { page: "boardPage", nav: "board", boardView: "features" },
  pipelines: { page: "pipelinesPage", nav: "pipelines" },
  "pipelines/new": { page: "pipelineEditorPage", nav: "pipelines", editor: "new" },
  "pipelines/edit/:id": { page: "pipelineEditorPage", nav: "pipelines", editor: "edit" },
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
// `#/pipelines/edit` with no id means a new pipeline.
var BOARD_ROUTE_REDIRECTS = {
  new: { to: "board", openNew: "task" },
  "pipelines/edit": { to: "pipelines/new" },
};

// "pipelines/edit/abc" against "pipelines/edit/:id" -> { id: "abc" };
// null when the segments don't line up or one doesn't decode.
function matchRoutePattern(pattern, path) {
  var want = pattern.split("/");
  var got = path.split("/");
  if (want.length !== got.length) return null;
  var params = {};
  for (var i = 0; i < want.length; i++) {
    if (want[i].charAt(0) === ":") {
      if (!got[i]) return null;
      try {
        params[want[i].slice(1)] = decodeURIComponent(got[i]);
      } catch (e) {
        return null;
      }
    } else if (want[i] !== got[i]) {
      return null;
    }
  }
  return params;
}

// "#/setup/harnesses", "#setup/harnesses/" and "/setup/harnesses" all
// mean the same route. An empty hash is the board (`known: true`, so
// the caller leaves a bare /board URL alone). A redirect resolves to its
// target with `redirected: true` and its `openNew` tab, if it has one. A
// route with `:name` segments also returns `params`. Anything else
// falls back to the board with `known: false`, so the caller can rewrite
// the URL instead of leaving a dead hash in the address bar.
function parseBoardRoute(hash) {
  var path = String(hash || "").replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return { route: "board", known: true };
  // Pattern keys only match through matchRoutePattern below, so a typed
  // "#/pipelines/edit/:id" is a pipeline id ":id", not a param-less route.
  if (path.indexOf(":") === -1 && Object.prototype.hasOwnProperty.call(BOARD_ROUTES, path)) return { route: path, known: true };
  if (Object.prototype.hasOwnProperty.call(BOARD_ROUTE_REDIRECTS, path)) {
    var r = BOARD_ROUTE_REDIRECTS[path];
    var out = { route: r.to, known: true, redirected: true };
    if (r.openNew) out.openNew = r.openNew;
    return out;
  }
  for (var key in BOARD_ROUTES) {
    if (!Object.prototype.hasOwnProperty.call(BOARD_ROUTES, key) || key.indexOf(":") === -1) continue;
    var params = matchRoutePattern(key, path);
    if (params) return { route: key, known: true, params: params };
  }
  return { route: "board", known: false };
}

// boardRouteHash("pipelines/edit/:id", { id: "a b" }) -> "#/pipelines/edit/a%20b".
function boardRouteHash(route, params) {
  return "#/" + String(route).split("/").map(function (seg) {
    if (seg.charAt(0) !== ":") return seg;
    var value = params && params[seg.slice(1)];
    return encodeURIComponent(value == null ? "" : String(value));
  }).join("/");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    BOARD_ROUTES: BOARD_ROUTES,
    BOARD_ROUTE_REDIRECTS: BOARD_ROUTE_REDIRECTS,
    parseBoardRoute: parseBoardRoute,
    boardRouteHash: boardRouteHash,
  };
}
