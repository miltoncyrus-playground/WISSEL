// Pure: what the board shows for harness capacity and an agent's
// preferred harness list (docs/SDD-agent-harness-preference.md §3.7).
// Inputs are GET /harnesses rows ({ id, label, enabled, activeCount,
// maxConcurrent? }) and a GET /agents entry ({ harnesses?: string[] }).
// No DOM, no side effects, same house style as render-merge-health.js,
// and `import`-able from bun test through the module.exports guard at
// the bottom. board.html's fleetRow and renderHarnessPanel are the DOM
// glue around these.

function hasMaxConcurrent(h) {
  return h.maxConcurrent !== undefined && h.maxConcurrent !== null;
}

// "1/2 active" when the harness sets maxConcurrent (shown even at 0, so
// the cap itself is visible), "N active" when it doesn't and something
// is running, null when there's nothing worth saying.
function formatHarnessCapacity(h) {
  var active = h.activeCount || 0;
  if (hasMaxConcurrent(h)) return active + "/" + h.maxConcurrent + " active";
  return active > 0 ? active + " active" : null;
}

// Mirrors HarnessPool.underCapacity + the enabled check acquire() uses
// (src/core/harness-pool.ts), so "available" here means the same thing
// as "the next run could land here". `undefined` (the agent lists an id
// GET /harnesses doesn't return) is "unknown"; startup validation should
// make that unreachable, but the board must not hide it if it happens.
function harnessPreferenceState(h) {
  if (!h) return "unknown";
  if (!h.enabled) return "disabled";
  if (hasMaxConcurrent(h) && (h.activeCount || 0) >= h.maxConcurrent) return "full";
  return "available";
}

var HARNESS_STATE_WORD = { available: "enabled", full: "at capacity", disabled: "disabled", unknown: "not configured" };

// { any: true } for an agent with no list (it runs on whichever enabled
// harness is least loaded); otherwise one entry per listed id, in the
// agent's preference order. `text` is the whole line the board renders,
// so a test can compare the DOM against it exactly.
function describeAgentHarnesses(agent, harnesses) {
  var list = (agent && agent.harnesses) || [];
  if (list.length === 0) return { any: true, entries: [], text: "Runs on: any enabled harness" };

  var byId = {};
  (harnesses || []).forEach(function (h) { byId[h.id] = h; });

  var entries = list.map(function (id, i) {
    var h = byId[id];
    var state = harnessPreferenceState(h);
    var bits = [HARNESS_STATE_WORD[state]];
    var capacity = h ? formatHarnessCapacity(h) : null;
    if (capacity) bits.push(capacity);
    var label = h ? h.label || h.id : id;
    return { id: id, state: state, text: i + 1 + ". " + label + " (" + bits.join(" · ") + ")" };
  });
  var text = "Runs on: " + entries.map(function (e) { return e.text; }).join(" → ");
  return { any: false, entries: entries, text: text };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    formatHarnessCapacity: formatHarnessCapacity,
    harnessPreferenceState: harnessPreferenceState,
    describeAgentHarnesses: describeAgentHarnesses,
  };
}
