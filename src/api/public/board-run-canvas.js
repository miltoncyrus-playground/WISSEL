// Pure: a pipeline run drawn as its graph, each step coloured by its
// live status (docs/SDD-ui-cleanup.md §4.3, card B3). No DOM, no side
// effects — same house style as board-runs.js, and directly
// `import`-able from bun test the same way (see the module.exports
// guard at the bottom). board.html's renderRunCanvas only turns the
// model this returns into elements.
//
// A saved pipeline stores no node positions (the editor's own layout is
// a grid fallback, pipeline-editor/src/graph.ts), so the canvas lays the
// graph out itself: left to right, one column per longest-path layer
// from the entry steps, steps in definition order within a column.
// Edges that loop back (a reviewer sending work back to an earlier
// step) are found by a DFS from the entry steps and drawn as arcs under
// the nodes instead of bending the layering.

// board-lanes.js and board-runs.js load before this file on the board,
// so their functions are globals there. bun test has no such globals
// and requires them instead.
var BOARD_RUN_CANVAS_DEPS = typeof latestStepCards === "function"
  ? {
    latestStepCards: latestStepCards,
    stepDisplayName: stepDisplayName,
    taskDisplayStatus: taskDisplayStatus,
    RUN_STEP_PENDING: RUN_STEP_PENDING,
  }
  : (function () {
    var lanes = require("./board-lanes.js");
    var runs = require("./board-runs.js");
    return {
      latestStepCards: runs.latestStepCards,
      stepDisplayName: runs.stepDisplayName,
      taskDisplayStatus: lanes.taskDisplayStatus,
      RUN_STEP_PENDING: runs.RUN_STEP_PENDING,
    };
  })();

// Geometry, in CSS pixels. board.html sizes the node elements from
// these same numbers, so the edges land on the node borders.
var RUN_CANVAS_GEOMETRY = {
  nodeWidth: 184,
  nodeHeight: 64,
  columnGap: 72,
  rowGap: 28,
  pad: 24,
  // How far below the lowest node a looping-back edge dips.
  backEdgeDrop: 36,
};

function canvasGraph(def) {
  var g = def && def.graph;
  return {
    steps: g && Array.isArray(g.steps) ? g.steps : [],
    edges: g && Array.isArray(g.edges) ? g.edges : [],
  };
}

// Each step id's layer (0 = an entry step), and the ids of the edges
// that loop back. An edge naming a step the graph doesn't have is
// ignored. With no entry step at all (every step has an incoming edge,
// so the whole graph is one cycle), the DFS starts from the first step.
function canvasLayers(steps, edges) {
  var ids = Object.create(null);
  steps.forEach(function (s) { ids[s.id] = true; });
  var valid = edges.filter(function (e) { return e && ids[e.from] && ids[e.to]; });

  var out = Object.create(null);
  var indeg = Object.create(null);
  steps.forEach(function (s) { out[s.id] = []; indeg[s.id] = 0; });
  valid.forEach(function (e) { out[e.from].push(e); indeg[e.to]++; });

  // Iterative DFS (white/grey/black) so a long pipeline can't blow the
  // stack. An edge into a grey step closes a cycle: a back edge.
  var back = Object.create(null);
  var color = Object.create(null);
  function dfs(start) {
    var stack = [{ id: start, i: 0 }];
    color[start] = 1;
    while (stack.length) {
      var top = stack[stack.length - 1];
      var next = out[top.id][top.i++];
      if (!next) { color[top.id] = 2; stack.pop(); continue; }
      if (color[next.to] === 1) back[next.id] = true;
      else if (!color[next.to]) { color[next.to] = 1; stack.push({ id: next.to, i: 0 }); }
    }
  }
  steps.forEach(function (s) { if (indeg[s.id] === 0 && !color[s.id]) dfs(s.id); });
  steps.forEach(function (s) { if (!color[s.id]) dfs(s.id); });

  // Longest path over the forward edges, in topological order (Kahn).
  var forward = valid.filter(function (e) { return !back[e.id]; });
  var fwdIn = Object.create(null);
  var fwdOut = Object.create(null);
  steps.forEach(function (s) { fwdIn[s.id] = 0; fwdOut[s.id] = []; });
  forward.forEach(function (e) { fwdIn[e.to]++; fwdOut[e.from].push(e.to); });
  var layer = Object.create(null);
  var queue = steps.filter(function (s) { return fwdIn[s.id] === 0; }).map(function (s) { return s.id; });
  queue.forEach(function (id) { layer[id] = 0; });
  for (var q = 0; q < queue.length; q++) {
    var id = queue[q];
    fwdOut[id].forEach(function (to) {
      layer[to] = Math.max(layer[to] || 0, layer[id] + 1);
      if (--fwdIn[to] === 0) queue.push(to);
    });
  }
  return { layer: layer, back: back, edges: valid };
}

// Cubic path from the right edge of `a` to the left edge of `b`, and the
// curve's midpoint for the edge label: with the control points mirrored
// like this, B(0.5) is the plain midpoint of the two ends.
function forwardEdgePath(a, b, G) {
  var x1 = a.x + G.nodeWidth, y1 = a.y + G.nodeHeight / 2;
  var x2 = b.x, y2 = b.y + G.nodeHeight / 2;
  var dx = Math.max(24, (x2 - x1) / 2);
  return {
    d: "M" + x1 + "," + y1 + " C" + (x1 + dx) + "," + y1 + " " + (x2 - dx) + "," + y2 + " " + x2 + "," + y2,
    mid: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
  };
}

// From the bottom of `a` back to the bottom of `b`, dipping below every
// node (`floor`). A step looping to itself gets a small loop on its
// right edge instead.
function backEdgePath(a, b, floor, G) {
  if (a === b) {
    var rx = a.x + G.nodeWidth, ty = a.y + G.nodeHeight * 0.3, by = a.y + G.nodeHeight * 0.7;
    return {
      d: "M" + rx + "," + ty + " C" + (rx + 36) + "," + (ty - 14) + " " + (rx + 36) + "," + (by + 14) + " " + rx + "," + by,
      mid: { x: rx + 27, y: a.y + G.nodeHeight / 2 },
    };
  }
  var x1 = a.x + G.nodeWidth / 2, y1 = a.y + G.nodeHeight;
  var x2 = b.x + G.nodeWidth / 2, y2 = b.y + G.nodeHeight;
  return {
    d: "M" + x1 + "," + y1 + " C" + x1 + "," + floor + " " + x2 + "," + floor + " " + x2 + "," + y2,
    // B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8.
    mid: { x: (x1 + x2) / 2, y: (y1 + y2 + 6 * floor) / 8 },
  };
}

// Everything the canvas draws for one run: a node per definition step
// (status from that step's latest card, or "pending" if the run hasn't
// reached it), plus a node per step card whose step the definition no
// longer has (edited or deleted since the run), in a last column of its
// own so nothing the run did goes missing. Without a definition at all,
// every node is one of those and there are no edges.
//
// Node: { id, name, agentId, status, taskId, taskStatus, attempt,
//   inDefinition, layer, x, y }. `status` is the display status
//   (taskDisplayStatus: a reviewer's running card is "reviewing");
//   `taskStatus` is the card's own status, exactly as GET /tasks has it.
// Edge: { id, from, to, label, back, reached, path, labelAt }.
//   `reached`: the run has a card for both ends. `path` is an SVG path
//   `d`; `labelAt` is the curve's midpoint.
function runCanvasModel(root, steps, def) {
  var G = RUN_CANVAS_GEOMETRY;
  var deps = BOARD_RUN_CANVAS_DEPS;
  var graph = canvasGraph(def);
  var latest = Object.create(null);
  deps.latestStepCards(steps).forEach(function (s) { latest[s.key] = s; });

  var lay = canvasLayers(graph.steps, graph.edges);
  var defIds = Object.create(null);
  var nodes = graph.steps.map(function (s) {
    defIds[s.id] = true;
    var seen = latest[s.id];
    return {
      id: s.id,
      name: s.name || s.id,
      agentId: s.agentId || (seen && seen.card.routedTo) || null,
      status: seen ? deps.taskDisplayStatus(seen.card) : deps.RUN_STEP_PENDING,
      taskId: seen ? seen.card.id : null,
      taskStatus: seen ? seen.card.status : null,
      attempt: seen ? seen.attempt : 0,
      inDefinition: true,
      layer: lay.layer[s.id] || 0,
    };
  });
  var maxLayer = nodes.reduce(function (m, n) { return Math.max(m, n.layer); }, -1);
  deps.latestStepCards(steps).forEach(function (s) {
    if (defIds[s.key]) return;
    nodes.push({
      id: s.key,
      name: deps.stepDisplayName(s.card, root, def),
      agentId: s.card.routedTo || null,
      status: deps.taskDisplayStatus(s.card),
      taskId: s.card.id,
      taskStatus: s.card.status,
      attempt: s.attempt,
      inDefinition: false,
      layer: maxLayer + 1,
    });
  });

  // Rows within a column, in node order; shorter columns are centred
  // against the tallest one.
  var columns = [];
  nodes.forEach(function (n) {
    if (!columns[n.layer]) columns[n.layer] = [];
    columns[n.layer].push(n);
  });
  var tallest = columns.reduce(function (m, c) { return Math.max(m, c ? c.length : 0); }, 0);
  var rowStep = G.nodeHeight + G.rowGap;
  columns.forEach(function (col, layer) {
    if (!col) return;
    var offset = (tallest - col.length) * rowStep / 2;
    col.forEach(function (n, row) {
      n.x = G.pad + layer * (G.nodeWidth + G.columnGap);
      n.y = G.pad + offset + row * rowStep;
    });
  });

  var byId = Object.create(null);
  nodes.forEach(function (n) { byId[n.id] = n; });
  var bottom = nodes.reduce(function (m, n) { return Math.max(m, n.y + G.nodeHeight); }, 0);
  var floor = bottom + G.backEdgeDrop;
  var edges = lay.edges.map(function (e) {
    var a = byId[e.from], b = byId[e.to];
    var back = !!lay.back[e.id];
    var geo = back ? backEdgePath(a, b, floor, G) : forwardEdgePath(a, b, G);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label || "",
      back: back,
      reached: !!(a.taskId && b.taskId),
      path: geo.d,
      labelAt: geo.mid,
    };
  });
  var loopsUnder = edges.some(function (e) { return e.back && e.from !== e.to; });
  var right = nodes.reduce(function (m, n) { return Math.max(m, n.x + G.nodeWidth); }, 0);
  return {
    nodes: nodes,
    edges: edges,
    width: nodes.length ? right + G.pad + 40 : 0,
    height: nodes.length ? (loopsUnder ? floor : bottom) + G.pad : 0,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RUN_CANVAS_GEOMETRY: RUN_CANVAS_GEOMETRY,
    canvasLayers: canvasLayers,
    runCanvasModel: runCanvasModel,
  };
}
