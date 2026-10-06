// Pure: where every task card goes on the Board page (docs/SDD-ui-
// cleanup.md §3.2, card A2). No DOM, no side effects — same house style
// as board-routes.js, and directly `import`-able from bun test the same
// way (see the module.exports guard at the bottom). board.html's glue
// just calls partitionBoard(tasks, ...) and draws what comes back.
//
// STATUS_DISPLAY is the one status table: every TaskCard.status value
// (src/core/types.ts) plus "reviewing", the one display-only status (see
// taskDisplayStatus). Each entry names its lane (a BOARD_LANES id, or
// NEEDS_YOU), its label and its colour token. Adding a status means
// adding it to types.ts and here; test/board-lanes.test.ts fails until
// both agree.

var NEEDS_YOU = "needs-you";

// Left to right on the board.
var BOARD_LANES = [
  { id: "queued", label: "Queued" },
  { id: "working", label: "Working" },
  { id: "in-review", label: "In review" },
  { id: "done", label: "Done" },
];

// Colours: a real green for done, blues for queued/in-progress work
// (pending-review joins them: an automated reviewer pass, not a human's
// queue yet), --accent for "a specific process has hands on this right
// now" (dispatched, reviewing), and a shared amber for the statuses
// where a human needs to look. Failed is red.
var STATUS_DISPLAY = {
  inbox: { lane: "queued", label: "Inbox", color: "--sig-inbox" },
  ready: { lane: "queued", label: "Ready", color: "--sig-ready" },
  running: { lane: "working", label: "Running", color: "--sig-running" },
  dispatched: { lane: "working", label: "Dispatched", color: "--accent" },
  reviewing: { lane: "working", label: "Reviewing", color: "--accent" },
  "pending-review": { lane: "in-review", label: "Pending review", color: "--sig-running" },
  done: { lane: "done", label: "Done", color: "--sig-done" },
  review: { lane: NEEDS_YOU, label: "Review", color: "--no-match" },
  escalated: { lane: NEEDS_YOU, label: "Escalated", color: "--no-match" },
  failed: { lane: NEEDS_YOU, label: "Failed", color: "--critical" },
  "no-match": { lane: NEEDS_YOU, label: "No match", color: "--no-match" },
};

// The Done lane's default window.
var DONE_WINDOW_MS = 24 * 60 * 60 * 1000;

// The one place raw TaskCard.status gets reinterpreted for display,
// never for routing/business logic, which always reads t.status. A
// reviewer agent's own task sits at "running" the whole time it works;
// showing it as "reviewing" tells it apart from an implementer at a
// glance.
function taskDisplayStatus(t) {
  if (t.status === "running" && t.routedTo === "reviewer") return "reviewing";
  return t.status;
}

// TaskCard.pendingMcpApproval is never cleared once set; status leaving
// "review" is what resolves it (same gate as the drawer's approval
// panel, renderMcpApprovalSection in board.html).
function hasPendingMcpApproval(t) {
  return !!t.pendingMcpApproval && t.status === "review";
}

// Own keys only, so a status like "constructor" can't match
// Object.prototype.
function statusDef(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_DISPLAY, status) ? STATUS_DISPLAY[status] : undefined;
}

// A BOARD_LANES id or NEEDS_YOU. An unknown status (a value added to
// types.ts but not to STATUS_DISPLAY) goes to Needs you rather than
// vanishing: a human should look at a card the board can't place.
function taskPlacement(t) {
  if (hasPendingMcpApproval(t)) return NEEDS_YOU;
  var def = statusDef(taskDisplayStatus(t));
  return def ? def.lane : NEEDS_YOU;
}

function statusLabel(status) {
  var def = statusDef(status);
  return def ? def.label : String(status);
}

function statusColor(status) {
  var def = statusDef(status);
  return def ? def.color : "--ink-muted";
}

// Why a card is in Needs you, in a few words.
function needsYouReason(t) {
  if (hasPendingMcpApproval(t)) {
    var req = t.pendingMcpApproval;
    return "MCP approval: " + req.server + " · " + req.tool;
  }
  switch (t.status) {
    case "review": return "review";
    case "escalated": {
      // The orchestrator escalates on the reviewer's rejection after
      // pushbackCount reached its limit, so rejections = pushbackCount + 1
      // (resumeAfterReviewVerdict, src/core/orchestrator.ts).
      if (typeof t.pushbackCount !== "number") return "escalated";
      var n = t.pushbackCount + 1;
      return "escalated after " + n + (n === 1 ? " rejection" : " rejections");
    }
    case "failed": return "failed";
    case "no-match": return "no agent matched";
    default: return "status: " + statusLabel(t.status);
  }
}

// When a done card became done: doneAt, stamped by Board.move on every
// move to done. null for a card that predates the field (or a bad
// value); partitionBoard keeps those visible rather than guess.
function doneTime(t) {
  var ms = Date.parse(t.doneAt || "");
  return isNaN(ms) ? null : ms;
}

// `opts.now` (ms), `opts.showAllDone`, `opts.showSuperseded`.
// Archived cards never show (the Archive page has them). Superseded
// cards are history: they never show in Needs you or a lane, and go to
// `superseded` (drawn only when opts.showSuperseded). Done shows only
// the last 24h unless opts.showAllDone; `doneHidden` counts the rest.
// Every list keeps `tasks`' order.
function partitionBoard(tasks, opts) {
  opts = opts || {};
  var now = typeof opts.now === "number" ? opts.now : Date.now();
  var out = { needsYou: [], lanes: {}, superseded: [], doneTotal: 0, doneHidden: 0 };
  BOARD_LANES.forEach(function (l) { out.lanes[l.id] = []; });
  (tasks || []).forEach(function (t) {
    if (t.archivedAt) return;
    if (t.supersededBy) {
      if (opts.showSuperseded) out.superseded.push(t);
      return;
    }
    var place = taskPlacement(t);
    if (place === NEEDS_YOU) { out.needsYou.push(t); return; }
    if (place === "done") {
      out.doneTotal++;
      var at = doneTime(t);
      if (!opts.showAllDone && at !== null && now - at > DONE_WINDOW_MS) { out.doneHidden++; return; }
    }
    out.lanes[place].push(t);
  });
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NEEDS_YOU: NEEDS_YOU,
    BOARD_LANES: BOARD_LANES,
    STATUS_DISPLAY: STATUS_DISPLAY,
    DONE_WINDOW_MS: DONE_WINDOW_MS,
    taskDisplayStatus: taskDisplayStatus,
    hasPendingMcpApproval: hasPendingMcpApproval,
    taskPlacement: taskPlacement,
    statusLabel: statusLabel,
    statusColor: statusColor,
    needsYouReason: needsYouReason,
    doneTime: doneTime,
    partitionBoard: partitionBoard,
  };
}
