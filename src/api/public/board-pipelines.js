// Pure: what the Pipelines page (docs/SDD-ui-cleanup.md §3.4, card A4)
// shows for each saved pipeline. No DOM, no side effects — same house
// style as board-lanes.js, and directly `import`-able from bun test the
// same way (see the module.exports guard at the bottom). board.html's
// glue fetches GET /pipelines and calls pipelineRows(pipelines, tasks)
// with the board's own task list, so the last run costs no extra
// request and updates on the same SSE refetch as the board.

// A run's root card: tagged with the pipeline, with no parent. Step
// cards carry the same pipelineId but always have parentTaskId (the
// root), the same filter GET /pipelines/:id/runs uses (src/api/server.ts).
function isPipelineRunRoot(t) {
  return !!t && typeof t.pipelineId === "string" && t.pipelineId !== "" && !t.parentTaskId;
}

// pipelineId -> its most recent run's root card. A TaskCard has no
// creation timestamp; GET /tasks is in creation order (ORDER BY rowid,
// src/services/board.ts), so the later root in the list is the newer run.
// No prototype, so an id like "__proto__" is just a key.
function lastRunsByPipeline(tasks) {
  var out = Object.create(null);
  (tasks || []).forEach(function (t) {
    if (isPipelineRunRoot(t)) out[t.pipelineId] = t;
  });
  return out;
}

function pipelineStepCount(p) {
  var steps = p && p.graph && p.graph.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

function formatStepCount(n) {
  return n + (n === 1 ? " step" : " steps");
}

// One row per pipeline, in GET /pipelines order (creation order).
// lastRun is null when the pipeline has never run (in `tasks`).
function pipelineRows(pipelines, tasks) {
  var last = lastRunsByPipeline(tasks);
  return (pipelines || []).map(function (p) {
    return {
      pipeline: p,
      stepCount: pipelineStepCount(p),
      lastRun: Object.prototype.hasOwnProperty.call(last, p.id) ? last[p.id] : null,
    };
  });
}

// Whether the Run dialog needs a repo for this pipeline: true when any
// step's agent is not readonly-tier or has write/bash in toolAccess, the
// same rule as stepsNeedingRepo (src/core/pipeline-runner.ts), which
// POST /pipelines/:id/run enforces. A step whose agent isn't in `agents`
// doesn't count (the server agrees: that step fails on its own). With
// no agents loaded yet it answers true, so the field never disappears
// for a pipeline that turns out to need it (docs/SDD-ai-news-podcast.md
// §3.4).
function pipelineNeedsRepo(p, agents) {
  if (!agents || !agents.length) return true;
  var byId = Object.create(null);
  agents.forEach(function (a) { byId[a.id] = a; });
  var steps = (p && p.graph && p.graph.steps) || [];
  return steps.some(function (s) {
    var a = byId[s.agentId];
    if (!a) return false;
    var access = a.toolAccess || [];
    return a.tier !== "readonly" || access.indexOf("write") !== -1 || access.indexOf("bash") !== -1;
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    pipelineNeedsRepo: pipelineNeedsRepo,
    isPipelineRunRoot: isPipelineRunRoot,
    lastRunsByPipeline: lastRunsByPipeline,
    pipelineStepCount: pipelineStepCount,
    formatStepCount: formatStepCount,
    pipelineRows: pipelineRows,
  };
}
