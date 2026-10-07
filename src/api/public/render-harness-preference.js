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

// ---- The board's account line (top bar, Board page only). Input is
// one GET /status/accounts row ({ id, label, tool, activeCount,
// maxConcurrent?, defaultModel?, running: [{ taskId, title, agentId,
// model }] }); the server already dropped disabled harnesses and
// resolved every model, so nothing here decides what runs where.

// Labels past this length get cut to the part after the dash.
var ACCOUNT_LABEL_MAX = 20;

// "Claude — milton.cyrus@gmail.com" -> "Claude (gmail)": a long label is
// cut to the part after its dash, and an email there to its provider.
// Short labels ("codex", "Claude — personal") are kept whole.
function shortAccountLabel(label) {
  label = label || "";
  if (label.length <= ACCOUNT_LABEL_MAX) return label;
  var m = /^(.*?)\s+[—–-]\s+(.+)$/.exec(label);
  if (!m) return label;
  var email = /^[^@\s]+@([^.\s]+)\./.exec(m[2]);
  return email ? m[1] + " (" + email[1] + ")" : m[2];
}

// "claude-opus-5-5" -> "opus-5-5", "claude-haiku-4-5-20251001" ->
// "haiku-4-5". Other tools' model ids pass through unchanged.
function shortModelName(model) {
  return String(model).replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

// Distinct models in first-seen order, "×N" when more than one task uses
// it: "opus-5-5 ×2, sonnet-5-5". A null model (agent unknown to the
// registry) reads "unknown model" rather than vanishing.
function summarizeRunningModels(running) {
  var order = [];
  var counts = {};
  (running || []).forEach(function (r) {
    var name = r.model ? shortModelName(r.model) : "unknown model";
    if (!(name in counts)) { counts[name] = 0; order.push(name); }
    counts[name]++;
  });
  return order.map(function (name) { return counts[name] > 1 ? name + " ×" + counts[name] : name; }).join(", ");
}

// Everything one chip shows. `text` is the whole visible line (short
// label · tool · load · models) so a test can compare the DOM against
// it; `title` is the hover text: full label, then one line per running
// task (title · agent · model).
function describeAccountChip(row) {
  var running = row.running || [];
  var busy = running.length > 0 || (row.activeCount || 0) > 0;
  var load = formatHarnessCapacity(row) || (running.length > 0 ? running.length + " running" : "idle");
  var models = running.length > 0
    ? summarizeRunningModels(running)
    : row.defaultModel ? shortModelName(row.defaultModel) : "agent defaults";
  var label = shortAccountLabel(row.label || row.id);
  var titleLines = [(row.label || row.id) + " (" + row.tool + ")", load + " · " + (running.length > 0 ? "running:" : "idle, next run uses " + (row.defaultModel || "each agent's own model"))];
  running.forEach(function (r) {
    titleLines.push("• " + r.title + " · " + (r.agentId || "unknown agent") + " · " + (r.model || "unknown model"));
  });
  return {
    id: row.id,
    label: label,
    tool: row.tool,
    load: load,
    models: models,
    busy: busy,
    text: label + " · " + row.tool + " · " + load + " · " + models,
    title: titleLines.join("\n"),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    formatHarnessCapacity: formatHarnessCapacity,
    harnessPreferenceState: harnessPreferenceState,
    describeAgentHarnesses: describeAgentHarnesses,
    shortAccountLabel: shortAccountLabel,
    shortModelName: shortModelName,
    summarizeRunningModels: summarizeRunningModels,
    describeAccountChip: describeAccountChip,
  };
}
