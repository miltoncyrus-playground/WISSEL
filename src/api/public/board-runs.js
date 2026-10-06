// Pure: one board card per pipeline run (docs/SDD-ui-cleanup.md §4.1,
// card B1). No DOM, no side effects — same house style as board-lanes.js,
// and directly `import`-able from bun test the same way (see the
// module.exports guard at the bottom).
//
// A run is its root card ("Pipeline: <name>", pipelineId set, no
// parent) plus every step card startPipelineRun spawned under it
// (pipelineRunId = the root's id, src/core/pipeline-runner.ts). On the
// board a step never draws as its own card: partitionRunBoard folds it
// into its root, and the root carries the run's progress instead.

// board-lanes.js and board-pipelines.js load before this file on the
// board, so their functions are globals there. bun test has no such
// globals and requires them instead.
var BOARD_RUNS_DEPS = typeof partitionBoard === "function"
  ? {
    NEEDS_YOU: NEEDS_YOU,
    partitionBoard: partitionBoard,
    taskPlacement: taskPlacement,
    taskDisplayStatus: taskDisplayStatus,
    needsYouReason: needsYouReason,
    isPipelineRunRoot: isPipelineRunRoot,
  }
  : (function () {
    var lanes = require("./board-lanes.js");
    var pipes = require("./board-pipelines.js");
    return {
      NEEDS_YOU: lanes.NEEDS_YOU,
      partitionBoard: lanes.partitionBoard,
      taskPlacement: lanes.taskPlacement,
      taskDisplayStatus: lanes.taskDisplayStatus,
      needsYouReason: lanes.needsYouReason,
      isPipelineRunRoot: pipes.isPipelineRunRoot,
    };
  })();

// Status of a step the definition has but the run hasn't reached yet.
// Not a TaskCard status; only the step bar uses it.
var RUN_STEP_PENDING = "pending";

function isPipelineStep(t) {
  return !!t && typeof t.pipelineRunId === "string" && t.pipelineRunId !== "";
}

// byId over every task, and runId -> its step cards in `tasks` order
// (GET /tasks is creation order, so that's the order the steps ran in).
// Built from the unfiltered board: with a project selected, a later
// step's repo is the previous step's worktree (handlePipelineStepResult),
// so it would be missing from the project-scoped list.
function indexRuns(tasks) {
  var byId = Object.create(null);
  var steps = Object.create(null);
  (tasks || []).forEach(function (t) { byId[t.id] = t; });
  (tasks || []).forEach(function (t) {
    if (!isPipelineStep(t)) return;
    if (!steps[t.pipelineRunId]) steps[t.pipelineRunId] = [];
    steps[t.pipelineRunId].push(t);
  });
  return { byId: byId, steps: steps };
}

function runStepsOf(index, runId) {
  return (index && index.steps[runId]) || [];
}

// The run a step belongs to, or null when its root isn't on the board
// (deleted). Such an orphan keeps its own card so it stays reachable.
function runRootOf(t, index) {
  if (!isPipelineStep(t)) return null;
  var root = index.byId[t.pipelineRunId];
  return root || null;
}

// True when `t` draws as part of its run's card instead of on its own.
// One exception besides orphans: a step unarchived on its own while its
// run stays archived. Unarchive restores exactly that card
// (docs/SDD-task-archiving.md §3.6), so it shows by itself rather than
// vanishing into a run the board doesn't draw.
function foldsIntoRun(t, index) {
  var root = runRootOf(t, index);
  if (!root) return false;
  if (root.archivedAt && !t.archivedAt) return false;
  return true;
}

function defSteps(def) {
  return def && def.graph && Array.isArray(def.graph.steps) ? def.graph.steps : [];
}

// The step's name in its pipeline definition. Without one (definition
// deleted or not loaded yet), the card title minus the "<pipeline
// name>: " prefix runStepAndSuccessors gives it.
function stepDisplayName(step, root, def) {
  var steps = defSteps(def);
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].id === step.pipelineStepId && steps[i].name) return steps[i].name;
  }
  var title = String(step.title || "");
  var rootTitle = root ? String(root.title || "") : "";
  var name = rootTitle.indexOf("Pipeline: ") === 0 ? rootTitle.slice("Pipeline: ".length) : "";
  if (name && title.indexOf(name + ": ") === 0) return title.slice(name.length + 2);
  return title;
}

// Each step id's latest card (a step activated twice, e.g. a retry,
// has two), in the order the steps first ran, with how many cards that
// step has had.
function latestStepCards(steps) {
  var order = [];
  var latest = Object.create(null);
  var attempts = Object.create(null);
  (steps || []).forEach(function (s) {
    var key = s.pipelineStepId || s.id;
    if (!(key in latest)) order.push(key);
    latest[key] = s;
    attempts[key] = (attempts[key] || 0) + 1;
  });
  return order.map(function (key) { return { key: key, card: latest[key], attempt: attempts[key] }; });
}

function stepLabel(name, attempt) {
  return attempt > 1 ? name + " (attempt " + attempt + ")" : name;
}

// What the run's card shows: "n/m steps · now: <step>", and one step-bar
// segment per step. m is the definition's step count (or the number of
// steps seen, if larger or there's no definition); n counts steps whose
// latest card is done. "now" is the latest step that hasn't finished
// (running, waiting on a human, queued); with none, a failed run names
// the first failed step instead. Segments run in execution order, then
// the definition's steps the run hasn't reached, as "pending". A
// "choose" transition can skip steps, so a done run can stay at n < m.
function runProgress(root, steps, def) {
  var seen = latestStepCards(steps);
  var seenIds = Object.create(null);
  seen.forEach(function (s) { seenIds[s.key] = true; });
  var unseen = defSteps(def).filter(function (s) { return !seenIds[s.id]; });
  var total = seen.length + unseen.length;
  var done = seen.filter(function (s) { return s.card.status === "done"; }).length;

  var segments = seen.map(function (s) {
    return {
      taskId: s.card.id,
      name: stepLabel(stepDisplayName(s.card, root, def), s.attempt),
      status: BOARD_RUNS_DEPS.taskDisplayStatus(s.card),
    };
  });
  unseen.forEach(function (s) { segments.push({ taskId: null, name: s.name || s.id, status: RUN_STEP_PENDING }); });

  var current = null;
  for (var i = seen.length - 1; i >= 0; i--) {
    var st = seen[i].card.status;
    if (st !== "done" && st !== "failed") { current = seen[i]; break; }
  }
  var failedAt = null;
  for (var j = 0; j < seen.length; j++) {
    if (seen[j].card.status === "failed") { failedAt = seen[j]; break; }
  }

  var text = done + "/" + total + " steps";
  var currentOut = null;
  var failedOut = null;
  if (current) {
    currentOut = { taskId: current.card.id, name: stepDisplayName(current.card, root, def), attempt: current.attempt };
    text += " · now: " + stepLabel(currentOut.name, current.attempt);
  } else if (failedAt && root && root.status === "failed") {
    failedOut = { taskId: failedAt.card.id, name: stepDisplayName(failedAt.card, root, def), attempt: failedAt.attempt };
    text += " · failed at: " + stepLabel(failedOut.name, failedAt.attempt);
  }
  return { done: done, total: total, current: currentOut, failedAt: failedOut, segments: segments, text: text };
}

// The run's steps a human has to act on: each step's latest card, not
// archived or superseded, that board-lanes.js would put in Needs you
// (failed, escalated, an MCP approval, ...).
function runNeedsYouSteps(steps) {
  return latestStepCards(steps).map(function (s) { return s.card; }).filter(function (c) {
    return !c.archivedAt && !c.supersededBy && BOARD_RUNS_DEPS.taskPlacement(c) === BOARD_RUNS_DEPS.NEEDS_YOU;
  });
}

// Why the run is in Needs you: the first step that needs a human, by
// name, with that step's own reason; "(+N more)" when there are others.
// A run with no such step (a root that failed before any step ran) gets
// the root's own reason.
function runNeedsYouReason(root, steps, def) {
  var needing = runNeedsYouSteps(steps);
  if (!needing.length) return BOARD_RUNS_DEPS.needsYouReason(root);
  var first = needing[0];
  var reason = "step " + stepDisplayName(first, root, def) + ": " + BOARD_RUNS_DEPS.needsYouReason(first);
  if (needing.length > 1) reason += " (+" + (needing.length - 1) + " more)";
  return reason;
}

// partitionBoard (board-lanes.js) over `tasks` with every step folded
// into its run, plus Needs you for a run whose root sits in a lane but
// has a step needing a human: that run shows in both places, its lane
// and Needs you. `allTasks` is the unfiltered board (see indexRuns);
// `tasks` is what the board draws. Needs you keeps `tasks` order.
function partitionRunBoard(tasks, allTasks, opts) {
  var index = indexRuns(allTasks || tasks);
  var visible = (tasks || []).filter(function (t) { return !foldsIntoRun(t, index); });
  var parts = BOARD_RUNS_DEPS.partitionBoard(visible, opts);

  var inLane = Object.create(null);
  Object.keys(parts.lanes).forEach(function (id) {
    parts.lanes[id].forEach(function (t) { inLane[t.id] = true; });
  });
  var inNeedsYou = Object.create(null);
  parts.needsYou.forEach(function (t) { inNeedsYou[t.id] = true; });
  visible.forEach(function (t) {
    if (inLane[t.id] && BOARD_RUNS_DEPS.isPipelineRunRoot(t) && runNeedsYouSteps(runStepsOf(index, t.id)).length) inNeedsYou[t.id] = true;
  });
  parts.needsYou = visible.filter(function (t) { return inNeedsYou[t.id]; });
  parts.index = index;
  return parts;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RUN_STEP_PENDING: RUN_STEP_PENDING,
    isPipelineStep: isPipelineStep,
    indexRuns: indexRuns,
    runStepsOf: runStepsOf,
    runRootOf: runRootOf,
    foldsIntoRun: foldsIntoRun,
    stepDisplayName: stepDisplayName,
    latestStepCards: latestStepCards,
    runProgress: runProgress,
    runNeedsYouSteps: runNeedsYouSteps,
    runNeedsYouReason: runNeedsYouReason,
    partitionRunBoard: partitionRunBoard,
  };
}
