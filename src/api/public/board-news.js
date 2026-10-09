// Pure: the "AI news podcast" result in the run drawer
// (docs/SDD-ai-news-podcast.md §3.5, §3.6). No DOM, same house style as
// board-runs.js, and directly `import`-able from bun test the same way
// (see the module.exports guard at the bottom). board.html only turns
// what newsView returns into elements and drives the browser's
// speechSynthesis through createNewsReader.
//
// task_results doesn't store a step's parsed pipelineHandoff (see
// eval/ai-news-podcast.eval.ts), so the drawer reads each step's raw
// `summary` from GET /tasks/:id/result and parses the handoff back out
// here. parseHandoffData mirrors parsePipelineHandoff
// (src/executors/parse-pipeline-handoff.ts); test/board-news.test.ts
// holds the two to the same answers.

var NEWS_FLAG_NOT_FROM_GATHER = "source not from the gather step";
var NEWS_FLAG_UNCHECKED = "source not checked: the gather step's output is unavailable";
var NEWS_FLAG_NOT_A_LINK = "source is not a web link";
var NEWS_FLAG_MISSING = "no source given";

var NEWS_HANDOFF_BLOCK = /```pipeline-handoff\s*\n([\s\S]*?)```/g;

function newsIsRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// A step's handoff `data` from its raw final message, or null when the
// message has no valid ```pipeline-handoff block or that block carries
// no `data`. Last block wins, like parsePipelineHandoff.
function parseHandoffData(text) {
  if (typeof text !== "string") return null;
  var body = null;
  var m;
  NEWS_HANDOFF_BLOCK.lastIndex = 0;
  while ((m = NEWS_HANDOFF_BLOCK.exec(text)) !== null) body = m[1].trim();
  if (body === null) return null;
  var parsed;
  try { parsed = JSON.parse(body); } catch (e) { return null; }
  if (!newsIsRecord(parsed)) return null;
  if (parsed.next !== undefined && (typeof parsed.next !== "string" || parsed.next.length === 0)) return null;
  if (parsed.note !== undefined && typeof parsed.note !== "string") return null;
  if (parsed.data !== undefined && !newsIsRecord(parsed.data)) return null;
  return parsed.data === undefined ? null : parsed.data;
}

// Every URL the gather step handed off, across all its stories; null
// when there is no gather `stories` list to check against. Exact string
// match, same as eval/ai-news-checks.ts's gatherSourceSet.
function gatherUrlSet(gatherData) {
  if (!newsIsRecord(gatherData) || !Array.isArray(gatherData.stories)) return null;
  var urls = new Set();
  gatherData.stories.forEach(function (story) {
    if (!newsIsRecord(story) || !Array.isArray(story.sources)) return;
    story.sources.forEach(function (url) { if (typeof url === "string") urls.add(url); });
  });
  return urls;
}

// Script text to paragraphs, one utterance each (Chrome cuts long
// single utterances off). Paragraphs are separated by a blank line, per
// the scriptwriter's contract; a script with none falls back to single
// line breaks. Whitespace inside a paragraph collapses to one space.
function splitScript(script) {
  if (typeof script !== "string") return [];
  var text = script.replace(/\r\n?/g, "\n").trim();
  if (text === "") return [];
  var parts = text.split(/\n[ \t]*\n/);
  if (parts.length === 1) parts = text.split("\n");
  return parts
    .map(function (p) { return p.replace(/\s+/g, " ").trim(); })
    .filter(function (p) { return p !== ""; });
}

function newsWordCount(paragraphs) {
  return paragraphs.reduce(function (n, p) { return n + p.split(" ").length; }, 0);
}

// Only http(s) URLs become links: a model-written `javascript:` source
// must never land in an href.
function newsHref(source) {
  return /^https?:\/\/[^\s]+$/i.test(source) ? source : null;
}

function newsRaw(reason, finalSummary) {
  return { kind: "raw", reason: reason, raw: typeof finalSummary === "string" ? finalSummary : "" };
}

// What the drawer shows for a run's last step:
//   { kind: "none" }  not a news result; the drawer adds nothing.
//   { kind: "raw", reason, raw }  a news result that can't be shaped;
//     the drawer shows the step's raw output and why.
//   { kind: "news", rows, paragraphs, wordCount, flaggedCount, gatherChecked }
// `finalSummary` / `gatherSummary` are the last and first steps' raw
// result summaries (undefined when they have none). `expected` is true
// when the last step is the podcast scriptwriter, so its missing data is
// an error to show rather than "some other pipeline". Never throws.
function newsView(finalSummary, gatherSummary, expected) {
  var data = parseHandoffData(finalSummary);
  var looksLikeNews = !!data && ("quickRead" in data || "script" in data);
  if (!looksLikeNews) {
    if (!expected) return { kind: "none" };
    return newsRaw(typeof finalSummary === "string" && finalSummary.trim() !== ""
      ? "The last step's output has no valid pipeline-handoff data with quickRead and script."
      : "The last step has no output.", finalSummary);
  }
  if (!Array.isArray(data.quickRead)) return newsRaw("quickRead is missing or not a list.", finalSummary);
  var paragraphs = splitScript(data.script);
  if (paragraphs.length === 0) return newsRaw("script is missing or empty.", finalSummary);

  var urls = gatherUrlSet(parseHandoffData(gatherSummary));
  var rows = [];
  for (var i = 0; i < data.quickRead.length; i++) {
    var item = data.quickRead[i];
    if (!newsIsRecord(item) || typeof item.headline !== "string" || item.headline.trim() === "") {
      return newsRaw("quickRead entry " + (i + 1) + " has no headline.", finalSummary);
    }
    if (item.oneLine !== undefined && typeof item.oneLine !== "string") {
      return newsRaw("quickRead entry " + (i + 1) + " has a oneLine that isn't text.", finalSummary);
    }
    var source = typeof item.source === "string" ? item.source.trim() : "";
    var href = source ? newsHref(source) : null;
    var flag = null;
    if (!source) flag = NEWS_FLAG_MISSING;
    else if (!href) flag = NEWS_FLAG_NOT_A_LINK;
    else if (!urls) flag = NEWS_FLAG_UNCHECKED;
    else if (!urls.has(source)) flag = NEWS_FLAG_NOT_FROM_GATHER;
    rows.push({ headline: item.headline.trim(), oneLine: (item.oneLine || "").trim(), source: source, href: href, flag: flag });
  }
  return {
    kind: "news",
    rows: rows,
    paragraphs: paragraphs,
    wordCount: newsWordCount(paragraphs),
    flaggedCount: rows.filter(function (r) { return r.flag !== null; }).length,
    gatherChecked: !!urls,
  };
}

// True when the browser can read aloud. Some browsers (and a page with
// speechSynthesis removed) have neither; the drawer hides the buttons.
function hasSpeech(win) {
  return !!win && !!win.speechSynthesis && typeof win.speechSynthesis.speak === "function"
    && typeof win.SpeechSynthesisUtterance === "function";
}

// An English voice from speechSynthesis.getVoices(): the browser's
// default if it's English, then en-US, then en-GB, then any English one,
// an on-device voice first at each step (Chrome's network voices stop
// mid-utterance after about 15 seconds); null when there's none (the
// utterance's lang then picks one).
function pickVoice(voices) {
  var en = (voices || []).filter(function (v) { return v && typeof v.lang === "string" && /^en([-_]|$)/i.test(v.lang); });
  var norm = function (v) { return v.lang.replace("_", "-").toLowerCase(); };
  var tiers = [
    function (v) { return v.default; },
    function (v) { return norm(v) === "en-us"; },
    function (v) { return norm(v) === "en-gb"; },
    function () { return true; },
  ];
  for (var i = 0; i < tiers.length; i++) {
    var tier = en.filter(tiers[i]);
    var local = tier.filter(function (v) { return v.localService; })[0];
    if (tier.length) return local || tier[0];
  }
  return null;
}

// Read aloud / Pause / Stop over a speechSynthesis-shaped `synth` and an
// utterance constructor (the browser's, or fakes in tests). One
// utterance per paragraph, all queued at once. `onChange(state, index)`
// fires with "idle" | "speaking" | "paused" and the paragraph being
// read (-1 when none). A generation counter drops events from utterances
// a Stop or a new Read aloud already cancelled (Chrome fires their
// onerror/onend after cancel()).
function createNewsReader(synth, Utterance, onChange) {
  var state = "idle";
  var current = -1;
  var gen = 0;
  function set(next, index) {
    state = next;
    current = index;
    if (onChange) onChange(state, current);
  }
  return {
    state: function () { return state; },
    current: function () { return current; },
    play: function (paragraphs) {
      if (state === "paused") { synth.resume(); set("speaking", current); return; }
      if (state === "speaking" || !paragraphs || paragraphs.length === 0) return;
      // Clear another read (or another tab's) only when there is one:
      // some Chrome builds drop the first utterance spoken right after
      // a cancel().
      if (synth.speaking || synth.pending) synth.cancel();
      var mine = ++gen;
      var voice = pickVoice(typeof synth.getVoices === "function" ? synth.getVoices() : []);
      set("speaking", 0);
      paragraphs.forEach(function (text, i) {
        var u = new Utterance(text);
        if (voice) u.voice = voice;
        u.lang = voice ? voice.lang : "en-US";
        u.onstart = function () { if (mine === gen && state !== "idle") set(state, i); };
        u.onend = function () { if (mine === gen && i === paragraphs.length - 1) set("idle", -1); };
        u.onerror = function () { if (mine === gen) { gen++; synth.cancel(); set("idle", -1); } };
        synth.speak(u);
      });
      // A pause left over from an earlier read holds the whole queue in Chrome.
      if (synth.paused) synth.resume();
    },
    pause: function () {
      if (state !== "speaking") return;
      synth.pause();
      set("paused", current);
    },
    stop: function () {
      gen++;
      if (state !== "idle") synth.cancel();
      if (state !== "idle" || current !== -1) set("idle", -1);
    },
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    NEWS_FLAG_NOT_FROM_GATHER: NEWS_FLAG_NOT_FROM_GATHER,
    NEWS_FLAG_UNCHECKED: NEWS_FLAG_UNCHECKED,
    NEWS_FLAG_NOT_A_LINK: NEWS_FLAG_NOT_A_LINK,
    NEWS_FLAG_MISSING: NEWS_FLAG_MISSING,
    parseHandoffData: parseHandoffData,
    gatherUrlSet: gatherUrlSet,
    splitScript: splitScript,
    newsView: newsView,
    hasSpeech: hasSpeech,
    pickVoice: pickVoice,
    createNewsReader: createNewsReader,
  };
}
