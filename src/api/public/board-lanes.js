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
  { id: "next-step", label: "Next step" },
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
  "review-in-progress": { lane: "in-review", label: "Review in progress", color: "--accent" },
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

// A BOARD_LANES id or NEEDS_YOU. The server's TaskCard.needsYou
// (src/services/needs-you.ts) decides first: lane "human" is the Needs
// a human strip, and a finished review card on lane "next-step" (an
// approved merge, a passed review report, a merge waiting on another)
// goes to the Next step lane. A queued card on "next-step" (waiting on a
// stuck dependency) stays queued. Without needsYou (an older server),
// the status table decides. An unknown status (a value added to
// types.ts but not to STATUS_DISPLAY) goes to Needs you rather than
// vanishing: a human should look at a card the board can't place.
function taskPlacement(t) {
  if (hasPendingMcpApproval(t)) return NEEDS_YOU;
  var ny = t.needsYou;
  if (ny && ny.lane === "human") return NEEDS_YOU;
  if (ny && ny.lane === "next-step" && t.status === "review") return "next-step";
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

// Why a card is in Needs you, in a few words (a pipeline run's reason
// strings these together, so they stay short).
function needsYouReason(t) {
  if (hasPendingMcpApproval(t)) {
    var req = t.pendingMcpApproval;
    return "MCP approval: " + req.server + " · " + req.tool;
  }
  switch (t.status) {
    case "review": return "review";
    case "escalated": {
      // The reviewer said the work needs a command the implementer was
      // refused (TaskCard.suggestedGrants): the fix is a grant.
      if (t.suggestedGrants && t.suggestedGrants.length) return "needs a grant";
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

// A single card's Needs a human / Next step line: the server's
// needsYou.line when there is one, else needsYouReason.
function needsYouLine(t) {
  return t.needsYou && t.needsYou.line ? t.needsYou.line : needsYouReason(t);
}

// When a done card became done: doneAt, stamped by Board.move on every
// move to done. null for a card that predates the field (or a bad
// value); partitionBoard keeps those visible rather than guess.
function doneTime(t) {
  var ms = Date.parse(t.doneAt || "");
  return isNaN(ms) ? null : ms;
}

// A reviewer's card (spawnReviewerTask, src/core/orchestrator.ts: its
// parentTaskId is the card it reviews) is the same piece of work as the
// pending-review card it reviews, so the board draws it once: the
// pending-review card in In review, and no reviewer card in Working.
// A reviewer card that failed or finished still shows where it is.
var REVIEWER_OPEN = { inbox: true, ready: true, running: true, dispatched: true };

function isReviewerCard(t) {
  return !!t.parentTaskId && (t.routedTo === "reviewer" || (t.labels || []).indexOf("review") >= 0);
}

// { <pending-review card id>: "queued" | "running" } for every card a
// live reviewer card is reviewing right now. "running" wins when several.
function reviewsInFlight(tasks) {
  var pending = {};
  (tasks || []).forEach(function (t) {
    if (t.status === "pending-review" && !t.archivedAt && !t.supersededBy) pending[t.id] = true;
  });
  var out = {};
  (tasks || []).forEach(function (t) {
    if (t.archivedAt || t.supersededBy || !isReviewerCard(t) || !REVIEWER_OPEN[t.status] || !pending[t.parentTaskId]) return;
    var state = t.status === "running" || t.status === "dispatched" ? "running" : "queued";
    if (out[t.parentTaskId] !== "running") out[t.parentTaskId] = state;
  });
  return out;
}

// Whether `t` is a live reviewer card whose pending-review card stands
// for it on the board (see reviewsInFlight).
function folded(t, inFlight) {
  return isReviewerCard(t) && !!REVIEWER_OPEN[t.status] && Object.prototype.hasOwnProperty.call(inFlight, t.parentTaskId);
}

// The status a card's tag shows on the board: "review-in-progress" for a
// pending-review card while its reviewer runs, else taskDisplayStatus.
function boardDisplayStatus(t, inFlight) {
  if (t.status === "pending-review" && inFlight && inFlight[t.id] === "running") return "review-in-progress";
  return taskDisplayStatus(t);
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
  var inFlight = reviewsInFlight(tasks);
  var out = { needsYou: [], lanes: {}, superseded: [], doneTotal: 0, doneHidden: 0, reviewsInFlight: inFlight };
  BOARD_LANES.forEach(function (l) { out.lanes[l.id] = []; });
  (tasks || []).forEach(function (t) {
    if (t.archivedAt) return;
    if (folded(t, inFlight)) return;
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
    boardDisplayStatus: boardDisplayStatus,
    reviewsInFlight: reviewsInFlight,
    hasPendingMcpApproval: hasPendingMcpApproval,
    taskPlacement: taskPlacement,
    statusLabel: statusLabel,
    statusColor: statusColor,
    needsYouReason: needsYouReason,
    needsYouLine: needsYouLine,
    doneTime: doneTime,
    partitionBoard: partitionBoard,
  };
}
