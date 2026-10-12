// Pure: what the board shows and sends for schedules and a card's start
// time (docs/SDD-schedules.md §3.7, §4). No DOM, no fetch, no reading the
// clock or the browser's zone: board.html's glue passes `now` and the
// zone in (Intl.DateTimeFormat().resolvedOptions().timeZone), so every
// function here is the same input, same output, and `import`-able from
// bun test the same way as board-pipelines.js (see the module.exports
// guard at the bottom).
//
// The server stays the judge of a cadence: buildCron only turns the
// picker into the 5 cron fields, and GET /schedules/preview says whether
// that cron and zone are valid (5-minute minimum gap included).

// Day-of-week numbers as cron counts them: Sunday = 0. The picker's
// weekly checkboxes are in this order, Monday first.
var SCHEDULE_DAYS = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

// The picker's modes. "custom" is the Advanced: cron field on its own,
// for any cron the four modes can't say.
var SCHEDULE_MODES = [
  { mode: "daily", label: "Every day" },
  { mode: "weekdays", label: "Weekdays (Mon to Fri)" },
  { mode: "weekly", label: "Weekly on chosen days" },
  { mode: "hours", label: "Every N hours" },
  { mode: "custom", label: "Advanced: cron" },
];

var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

// "06:00" -> { hour: 6, minute: 0 }; anything else -> null.
function parseTime(time) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!m) return null;
  var hour = Number(m[1]);
  var minute = Number(m[2]);
  return hour <= 23 && minute <= 59 ? { hour: hour, minute: minute } : null;
}

// --- Picker <-> cron ------------------------------------------------------

// picker: { mode, time: "HH:MM", days: [0-6], everyHours: N }.
// -> { ok: true, cron } or { ok: false, error } in words for the form.
// "hours" uses only the time's minutes ("every 2 hours at :30").
function buildCron(picker) {
  var p = picker || {};
  var t = parseTime(p.time);
  if (!t) return { ok: false, error: "Pick a time (HH:MM)." };
  if (p.mode === "daily") return { ok: true, cron: t.minute + " " + t.hour + " * * *" };
  if (p.mode === "weekdays") return { ok: true, cron: t.minute + " " + t.hour + " * * 1-5" };
  if (p.mode === "weekly") {
    var days = normalizeDays(p.days);
    if (!days.length) return { ok: false, error: "Pick at least one day." };
    return { ok: true, cron: t.minute + " " + t.hour + " * * " + days.join(",") };
  }
  if (p.mode === "hours") {
    var n = Number(p.everyHours);
    if (!Number.isInteger(n) || n < 1 || n > 23) return { ok: false, error: "Every N hours needs a whole number from 1 to 23." };
    return { ok: true, cron: t.minute + (n === 1 ? " *" : " */" + n) + " * * *" };
  }
  return { ok: false, error: "Pick how often it runs." };
}

// Unique, sorted 0-6, Sunday as 0 (cron's 7 is Sunday too).
function normalizeDays(days) {
  var seen = Object.create(null);
  var out = [];
  (days || []).forEach(function (d) {
    var n = Number(d);
    if (!Number.isInteger(n) || n < 0 || n > 7) return;
    n = n % 7;
    if (!seen[n]) { seen[n] = true; out.push(n); }
  });
  return out.sort(function (a, b) { return a - b; });
}

function cronInt(field, max) {
  if (!/^\d{1,2}$/.test(field)) return null;
  var n = Number(field);
  return n <= max ? n : null;
}

// A day-of-week field ("1-5", "MON,WED", "0,6") as sorted 0-6, or null
// for anything with steps or out-of-range parts.
function cronDays(field) {
  var out = [];
  var one = function (s) {
    var abbr = DAY_ABBR.indexOf(s.toUpperCase());
    if (abbr >= 0) return abbr;
    return cronInt(s, 7);
  };
  var parts = field.split(",");
  for (var i = 0; i < parts.length; i++) {
    var range = parts[i].split("-");
    if (range.length === 1) {
      var d = one(range[0]);
      if (d === null) return null;
      out.push(d);
    } else if (range.length === 2) {
      var a = one(range[0]);
      var b = one(range[1]);
      if (a === null || b === null || a > b) return null;
      for (var x = a; x <= b; x++) out.push(x);
    } else {
      return null;
    }
  }
  return normalizeDays(out);
}

// The inverse of buildCron: a cron the picker can show, as a picker, or
// null when only Advanced: cron can (then the editor opens on "custom").
function parseCron(cron) {
  var f = String(cron || "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  var minute = cronInt(f[0], 59);
  if (minute === null || f[2] !== "*" || f[3] !== "*") return null;
  var hourStep = f[1] === "*" ? 1 : (/^(?:\*|0)\/(\d{1,2})$/.exec(f[1]) || [])[1];
  if (hourStep !== undefined) {
    var n = Number(hourStep);
    if (f[4] !== "*" || n < 1 || n > 23) return null;
    return { mode: "hours", time: "00:" + pad2(minute), days: [], everyHours: n };
  }
  var hour = cronInt(f[1], 23);
  if (hour === null) return null;
  var time = pad2(hour) + ":" + pad2(minute);
  if (f[4] === "*") return { mode: "daily", time: time, days: [], everyHours: 1 };
  var days = cronDays(f[4]);
  if (!days || !days.length) return null;
  if (days.length === 7) return { mode: "daily", time: time, days: [], everyHours: 1 };
  if (days.join(",") === "1,2,3,4,5") return { mode: "weekdays", time: time, days: [], everyHours: 1 };
  return { mode: "weekly", time: time, days: days, everyHours: 1 };
}

// --- Time in a zone -------------------------------------------------------

var partFormatters = Object.create(null);

// The wall clock in `timeZone` at `ms`: { year, month (1-12), day, hour,
// minute, second, weekday ("Tue") }. Throws RangeError on a bad zone.
function zonedParts(ms, timeZone) {
  var f = partFormatters[timeZone];
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partFormatters[timeZone] = f;
  }
  var out = {};
  f.formatToParts(new Date(ms)).forEach(function (p) {
    if (p.type === "weekday") out.weekday = p.value;
    else if (p.type !== "literal") out[p.type] = Number(p.value);
  });
  return out;
}

// How far `timeZone`'s wall clock is ahead of UTC at `ms`, in ms.
function zoneOffsetMs(ms, timeZone) {
  var p = zonedParts(ms, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// A datetime-local value ("2026-10-12T23:00", the browser zone's wall
// clock) -> ISO UTC ("2026-10-12T21:00:00.000Z" for Europe/Madrid in
// summer). null when it isn't a real date and time. A wall time that a
// spring-forward gap skips lands an hour later, like the browser's own.
function localDateTimeToIso(value, timeZone) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || "").trim());
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), s = Number(m[6] || 0);
  var wall = Date.UTC(y, mo - 1, d, h, mi, s);
  var check = new Date(wall);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  try {
    var guess = wall - zoneOffsetMs(wall, timeZone);
    return new Date(wall - zoneOffsetMs(guess, timeZone)).toISOString();
  } catch (e) {
    return null;
  }
}

// ISO UTC -> the datetime-local value for `timeZone` ("2026-10-12T23:00"),
// so the drawer's Start at field shows a card's current start time.
// "" when the ISO doesn't parse.
function isoToLocalDateTime(iso, timeZone) {
  var ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  var p = zonedParts(ms, timeZone);
  return p.year + "-" + pad2(p.month) + "-" + pad2(p.day) + "T" + pad2(p.hour) + ":" + pad2(p.minute);
}

// "today 06:00", "Tue 13 Oct 06:00", or "Tue 13 Oct 2027 06:00" once
// the year differs from `now`'s, all on `timeZone`'s wall clock. "" when
// the ISO doesn't parse.
function formatWhen(iso, now, timeZone) {
  var ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  var p = zonedParts(ms, timeZone);
  var n = zonedParts(now.getTime(), timeZone);
  var hhmm = pad2(p.hour) + ":" + pad2(p.minute);
  if (p.year === n.year && p.month === n.month && p.day === n.day) return "today " + hhmm;
  return p.weekday + " " + p.day + " " + MONTHS[p.month - 1] + (p.year === n.year ? "" : " " + p.year) + " " + hhmm;
}

// --- Start at (TaskCard.notBefore) -----------------------------------------

// Same rule as the server's notBeforeRefusal (src/services/board-actions.ts):
// a start time only means something on a card sweep() hasn't picked up
// yet. Once it's routed or running, the chip has said what it had to.
function canHaveStartTime(task) {
  if (!task || task.archivedAt || (task.pipelineId !== undefined && task.pipelineId !== null)) return false;
  if (task.status !== "inbox" && task.status !== "ready") return false;
  return !task.routedTo;
}

// The card's chip: "Starts 23:00" today, "Starts Tue 13 Oct 23:00"
// otherwise; null when the card has no start time or is past it.
function startsChipText(task, now, timeZone) {
  if (!task || !task.notBefore || !canHaveStartTime(task)) return null;
  var when = formatWhen(task.notBefore, now, timeZone);
  if (!when) return null;
  return "Starts " + when.replace(/^today /, "");
}

// --- Schedules panel --------------------------------------------------------

var OUTCOME_LABELS = {
  started: "started",
  "skipped-overlap": "skipped: the last run was still going",
  "skipped-stale": "skipped: too late to catch up",
  error: "error",
};

function scheduleTarget(s, pipelinesById) {
  if (s.kind === "task") return "Task: " + ((s.taskTemplate && s.taskTemplate.title) || "(untitled)");
  var p = pipelinesById && s.pipelineId ? pipelinesById[s.pipelineId] : null;
  return "Pipeline: " + (p ? p.name : s.pipelineId || "(none)");
}

// One row per schedule, in GET /schedules order. `pipelines` may be null
// (not loaded yet): the row then names the pipeline by id.
function scheduleRows(schedules, pipelines, now, timeZone) {
  var byId = Object.create(null);
  (pipelines || []).forEach(function (p) { byId[p.id] = p; });
  return (schedules || []).map(function (s) {
    var next = !s.enabled ? "Paused" : s.nextRunAt ? formatWhen(s.nextRunAt, now, timeZone) : "not scheduled";
    var last = null;
    if (s.lastRunAt) {
      var outcome = OUTCOME_LABELS[s.lastOutcome] || s.lastOutcome || "";
      if (s.lastOutcome === "error" && s.lastError) outcome += ": " + s.lastError;
      last = { when: formatWhen(s.lastRunAt, now, timeZone), outcome: outcome, runId: s.lastRunId || null, runStatus: s.lastRunStatus || null };
    }
    return {
      schedule: s,
      target: scheduleTarget(s, byId),
      cadence: s.cadence || s.cron,
      timezone: s.timezone,
      next: next,
      last: last,
      enabled: !!s.enabled,
    };
  });
}

// pipelineId -> its enabled schedule that fires soonest, for the
// Pipelines page's "Next run" line. No prototype, same as
// lastRunsByPipeline (board-pipelines.js).
function nextRunsByPipeline(schedules) {
  var out = Object.create(null);
  (schedules || []).forEach(function (s) {
    if (s.kind !== "pipeline" || !s.pipelineId || !s.enabled || !s.nextRunAt) return;
    var cur = out[s.pipelineId];
    if (!cur || Date.parse(s.nextRunAt) < Date.parse(cur.nextRunAt)) out[s.pipelineId] = s;
  });
  return out;
}

// The editor's preview: the first `count` runs on the browser's clock,
// or the server's reason it's invalid.
function previewView(preview, now, timeZone, count) {
  var p = preview || {};
  if (!p.valid) return { valid: false, error: p.error || "invalid schedule", cadence: p.cadence || "", lines: [] };
  return {
    valid: true,
    error: null,
    cadence: p.cadence || "",
    lines: (p.next || []).slice(0, count === undefined ? 3 : count).map(function (iso) { return formatWhen(iso, now, timeZone); }),
  };
}

function defaultScheduleName(targetName, cadence) {
  return cadence ? targetName + ", " + cadence : targetName;
}

// The editor's fields -> the POST /schedules (mode "create") or PATCH
// /schedules/:id (mode "edit") body. draft: { kind, name, pipelineId,
// input, repo, title, body, template (the task schedule's stored
// taskTemplate, kept for its labels/harness/model), cron, timezone,
// catchUpHours (the field's text) }. A task schedule's repo lives in its
// template (which the runner reads first), so an edit clears the
// schedule-level repo rather than leave two to disagree.
// -> { ok: true, body } or { ok: false, error }.
function scheduleBody(draft, mode) {
  var d = draft || {};
  var name = String(d.name || "").trim();
  if (!name) return { ok: false, error: "Name is required." };
  var cron = String(d.cron || "").trim();
  if (!cron) return { ok: false, error: "A cadence is required." };
  var body = { name: name, cron: cron, timezone: String(d.timezone || "").trim() };
  if (!body.timezone) delete body.timezone;
  var catchUp = String(d.catchUpHours === undefined || d.catchUpHours === null ? "" : d.catchUpHours).trim();
  if (catchUp !== "") {
    var hours = Number(catchUp);
    if (!Number.isFinite(hours) || hours < 0) return { ok: false, error: "Catch up must be a number of hours, 0 or more." };
    body.catchUpHours = hours;
  }
  var repo = String(d.repo || "").trim();
  if (d.kind === "task") {
    var title = String(d.title || "").trim();
    if (!title) return { ok: false, error: "The task needs a title." };
    var t = d.template || {};
    var template = { title: title, body: String(d.body || "").trim(), labels: (t.labels || []).slice() };
    if (repo) template.repo = repo;
    if (t.harnessOverride) template.harnessOverride = t.harnessOverride;
    if (t.model) template.model = t.model;
    body.taskTemplate = template;
    if (mode === "edit") body.repo = null;
    else body.kind = "task";
    return { ok: true, body: body };
  }
  var input = String(d.input || "").trim();
  if (mode === "edit") {
    body.input = input || null;
    body.repo = repo || null;
  } else {
    body.kind = "pipeline";
    body.pipelineId = d.pipelineId;
    if (input) body.input = input;
    if (repo) body.repo = repo;
  }
  return { ok: true, body: body };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCHEDULE_DAYS: SCHEDULE_DAYS,
    SCHEDULE_MODES: SCHEDULE_MODES,
    buildCron: buildCron,
    parseCron: parseCron,
    localDateTimeToIso: localDateTimeToIso,
    isoToLocalDateTime: isoToLocalDateTime,
    formatWhen: formatWhen,
    canHaveStartTime: canHaveStartTime,
    startsChipText: startsChipText,
    scheduleRows: scheduleRows,
    nextRunsByPipeline: nextRunsByPipeline,
    previewView: previewView,
    defaultScheduleName: defaultScheduleName,
    scheduleBody: scheduleBody,
  };
}
