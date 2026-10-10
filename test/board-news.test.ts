import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";
import { checkAiNewsRun, countWords } from "../eval/ai-news-checks.ts";
import { aiNewsPodcastDraft, wisselRetroPodcastDraft } from "../pipeline-editor/src/templates.ts";
import {
  NEWS_FLAG_MISSING,
  NEWS_FLAG_NOT_A_LINK,
  NEWS_FLAG_NOT_FROM_GATHER,
  NEWS_FLAG_UNCHECKED,
  NEWS_AUDIO_AGENT,
  NEWS_SCRIPT_AGENT,
  createNewsReader,
  gatherUrlSet,
  hasSpeech,
  joinExplained,
  newsAudioView,
  newsStepCards,
  newsView,
  parseHandoffData,
  pickVoice,
  splitScript,
  type NewsView,
} from "../src/api/public/board-news.js";

// docs/SDD-ai-news-podcast.md §3.5, §3.6: the run drawer's Quick read
// and Listen tabs, shaped from the last step's handoff, with every
// source checked against the gather step's URLs.

const FIXTURES = join(import.meta.dir, "fixtures", "ai-news");
const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");
const GATHER = await readFile(join(FIXTURES, "gather-summary.md"), "utf8");
const SCRIPT = await readFile(join(FIXTURES, "script-summary.md"), "utf8");

function handoff(data: unknown, prose = "Done.\n\n"): string {
  return prose + "```pipeline-handoff\n" + JSON.stringify({ data }) + "\n```\n";
}

function scriptData(): { quickRead: Record<string, unknown>[]; script: unknown; wordCount: number } {
  return JSON.parse(JSON.stringify(parsePipelineHandoff(SCRIPT)!.data));
}

function news(view: NewsView): Extract<NewsView, { kind: "news" }> {
  if (view.kind !== "news") throw new Error(`expected a news view, got ${JSON.stringify(view)}`);
  return view;
}

// --- The handoff shape card 1 declared ---------------------------------

test("the podcast scriptwriter's own contract example (agents/manifest.yaml) shapes into a news view", async () => {
  const contract = (await Registry.load()).get("podcast-scriptwriter")!.outputContract!;
  const example = contract.match(/```pipeline-handoff\n[\s\S]*?```/)![0];
  const view = news(newsView(example, undefined, true));
  expect(view.rows).toEqual([{ headline: "...", oneLine: "...", source: "https://...", href: "https://...", flag: NEWS_FLAG_UNCHECKED, explained: null }]);
  expect(view.paragraphs).toEqual(["First paragraph.", "Second paragraph."]);
});

test("the gatherer's own contract example yields its URL set", async () => {
  const contract = (await Registry.load()).get("ai-news-gatherer")!.outputContract!;
  const example = contract.match(/```pipeline-handoff\n[\s\S]*?```/)![0];
  expect([...gatherUrlSet(parseHandoffData(example))!]).toEqual(["https://..."]);
});

// --- Recorded fixture handoffs -----------------------------------------

test("the recorded final handoff shapes into quick-read rows and script paragraphs, every source from the gather step", () => {
  const view = news(newsView(SCRIPT, GATHER, true));
  expect(view.rows).toEqual([
    { headline: "Open coding model catches up", oneLine: "A free-to-download coding model now scores close to the best paid ones.", source: "https://lab.example.com/blog/open-coder-2", href: "https://lab.example.com/blog/open-coder-2", flag: null, explained: null },
    { headline: "Draft rules for AI in hiring", oneLine: "Job seekers may soon have to be told when an AI reads their application.", source: "https://regulator.example.gov/press/ai-hiring-draft", href: "https://regulator.example.gov/press/ai-hiring-draft", flag: null, explained: null },
    { headline: "A faster, cheaper AI chip", oneLine: "A new chip promises to answer AI questions using less power.", source: "https://chips.example.com/news/inference-x1", href: "https://chips.example.com/news/inference-x1", flag: null, explained: null },
  ]);
  expect(view.paragraphs).toHaveLength(5);
  expect(view.paragraphs[0]).toBe("Welcome to this week in AI. Three stories, plain words, about five minutes.");
  expect(view.paragraphs[4]).toBe("That's it for this week. Thanks for listening.");
  // Counted, not the model's own wordCount; same count as the eval's.
  expect(view.wordCount).toBe(countWords(scriptData().script as string));
  expect(view.wordCount).toBe(99);
  expect(view.flaggedCount).toBe(0);
  expect(view.gatherChecked).toBe(true);
});

test("the recorded fixture pair also passes the eval's own sources-from-gather check", () => {
  const checks = checkAiNewsRun({ gather: parsePipelineHandoff(GATHER)!.data, explain: undefined, final: parsePipelineHandoff(SCRIPT)!.data, costUsd: 1, now: new Date("2026-10-07T12:00:00Z") });
  expect(checks.find((c) => c.name === "sources-from-gather")!.pass).toBe(true);
});

// --- §3.6: invented sources are flagged --------------------------------

test("a quickRead source not in the gather step's URLs is flagged; the rest stay normal", () => {
  const data = scriptData();
  data.quickRead[1]!.source = "https://invented.example.net/story";
  const view = news(newsView(handoff(data), GATHER, true));
  expect(view.rows.map((r) => r.flag)).toEqual([null, NEWS_FLAG_NOT_FROM_GATHER, null]);
  expect(view.rows[1]!.href).toBe("https://invented.example.net/story");
  expect(view.flaggedCount).toBe(1);
});

test("the drawer's flag and the eval's sources-from-gather check agree on every mutation", () => {
  const gather = parsePipelineHandoff(GATHER)!.data;
  const mutations: ((d: ReturnType<typeof scriptData>) => void)[] = [
    () => {},
    (d) => { d.quickRead[0]!.source = "https://invented.example.net/x"; },
    (d) => { d.quickRead[2]!.source = "https://chips.example.com/news/inference-x1/"; }, // trailing slash: not the same URL
    (d) => { d.quickRead[0]!.source = "https://arxiv.example.org/abs/2610.01234"; }, // a story's second source is fine
    (d) => { delete d.quickRead[1]!.source; },
  ];
  for (const mutate of mutations) {
    const data = scriptData();
    mutate(data);
    const flagged = news(newsView(handoff(data), GATHER, true)).flaggedCount > 0;
    const evalPass = checkAiNewsRun({ gather, explain: undefined, final: data, costUsd: 1, now: new Date("2026-10-07T12:00:00Z") }).find((c) => c.name === "sources-from-gather")!.pass;
    expect(flagged, JSON.stringify(data.quickRead.map((r) => r.source))).toBe(!evalPass);
  }
});

test("without the gather step's output every source is marked unchecked, never shown as verified", () => {
  for (const gather of [undefined, "", "no handoff here", handoff({ generatedAt: "2026-10-07" })]) {
    const view = news(newsView(SCRIPT, gather, true));
    expect(view.gatherChecked).toBe(false);
    expect(view.rows.map((r) => r.flag)).toEqual([NEWS_FLAG_UNCHECKED, NEWS_FLAG_UNCHECKED, NEWS_FLAG_UNCHECKED]);
  }
});

test("a non-http source is never linked (no javascript: href) and is flagged; a missing one says so", () => {
  const data = scriptData();
  data.quickRead[0]!.source = "javascript:alert(1)";
  data.quickRead[1]!.source = "   ";
  data.quickRead[2]!.source = "chips.example.com/news/inference-x1";
  const view = news(newsView(handoff(data), GATHER, true));
  expect(view.rows.map((r) => [r.href, r.flag])).toEqual([
    [null, NEWS_FLAG_NOT_A_LINK],
    [null, NEWS_FLAG_MISSING],
    [null, NEWS_FLAG_NOT_A_LINK],
  ]);
});

// --- Malformed or missing data: raw output, never a throw ---------------

test("malformed final data returns a raw result carrying the step's output, never throws", () => {
  const cases: [string, unknown][] = [
    ["quickRead not a list", { quickRead: "oops", script: "Hi." }],
    ["quickRead missing", { script: "Hi." }],
    ["script missing", { quickRead: [] }],
    ["script empty", { quickRead: [], script: " \n\n " }],
    ["script not text", { quickRead: [], script: ["a"] }],
    ["entry not an object", { quickRead: [null], script: "Hi." }],
    ["entry without headline", { quickRead: [{ oneLine: "x", source: "https://a.example" }], script: "Hi." }],
    ["oneLine not text", { quickRead: [{ headline: "h", oneLine: 5, source: "https://a.example" }], script: "Hi." }],
  ];
  for (const [name, data] of cases) {
    const summary = handoff(data);
    const view = newsView(summary, GATHER, true);
    expect(view.kind, name).toBe("raw");
    if (view.kind === "raw") {
      expect(view.raw, name).toBe(summary);
      expect(view.reason.length, name).toBeGreaterThan(0);
    }
  }
});

test("missing data: raw for the scriptwriter step, nothing at all for any other pipeline", () => {
  for (const summary of [undefined, null, 42, "", "prose only", "```pipeline-handoff\n{not json\n```", handoff({ stories: [] })]) {
    expect(newsView(summary, GATHER, true).kind, String(summary)).toBe("raw");
    expect(newsView(summary, GATHER, false), String(summary)).toEqual({ kind: "none" });
  }
  // Even an unexpected step that does hand off quickRead + script shows it.
  expect(newsView(SCRIPT, GATHER, false).kind).toBe("news");
  expect(newsView("", GATHER, true)).toMatchObject({ kind: "raw", raw: "", reason: "The script step has no output." });
});

test("an empty quickRead with a script is still a news view (Listen works, Quick read is empty)", () => {
  const view = news(newsView(handoff({ quickRead: [], script: "One.\n\nTwo." }), GATHER, true));
  expect(view.rows).toEqual([]);
  expect(view.paragraphs).toEqual(["One.", "Two."]);
});

// --- Which step cards the drawer reads, and the audio state (§3.7) -------

const DEF_STEPS = aiNewsPodcastDraft().graph.steps;

function card(id: string, pipelineStepId: string, status = "done", routedTo?: string) {
  return { id, pipelineStepId, status, ...(routedTo ? { routedTo } : {}) };
}

test("newsStepCards finds the scriptwriter by its definition agentId when Make audio runs after it", () => {
  const steps = [card("g", "gather"), card("e", "explain"), card("s", "script"), card("a", "audio", "running")];
  const got = newsStepCards(steps, DEF_STEPS)!;
  expect(got.news.id).toBe("s");
  expect(got.expected).toBe(true);
  expect(got.gather!.id).toBe("g");
  expect(got.audio!.id).toBe("a");
  expect(NEWS_SCRIPT_AGENT).toBe("podcast-scriptwriter");
  expect(NEWS_AUDIO_AGENT).toBe("podcast-audio");
});

test("newsStepCards takes each step's latest card (a retried step has several) and falls back to routedTo without a definition", () => {
  const steps = [
    card("g1", "gather", "failed"),
    card("g2", "gather"),
    card("s1", "script", "failed"),
    card("s2", "script"),
    card("a1", "audio", "failed"),
    card("a2", "audio", "running"),
  ];
  const got = newsStepCards(steps, DEF_STEPS)!;
  expect([got.news.id, got.gather!.id, got.audio!.id]).toEqual(["s2", "g2", "a2"]);
  // Definition deleted: the cards' own routedTo still name the agents.
  const routed = [card("g", "x1", "done", "ai-news-gatherer"), card("s", "x2", "done", "podcast-scriptwriter"), card("a", "x3", "done", "podcast-audio")];
  expect(newsStepCards(routed, [])).toMatchObject({ news: { id: "s" }, expected: true, gather: { id: "g" }, audio: { id: "a" } });
});

test("newsStepCards: a three-step run from before Make audio, any other pipeline, and a run with no steps", () => {
  const old = newsStepCards([card("g", "gather"), card("e", "explain"), card("s", "script")], DEF_STEPS)!;
  expect([old.news.id, old.expected, old.gather!.id, old.audio]).toEqual(["s", true, "g", null]);
  // Not a news pipeline: the last card, not expected, as before card 3.
  const other = newsStepCards([card("a", "one", "done", "triager"), card("b", "two", "done", "summarizer")], [])!;
  expect([other.news.id, other.expected, other.gather!.id, other.audio]).toEqual(["b", false, "a", null]);
  // A one-step run: the gather card is the news card itself, so no gather.
  expect(newsStepCards([card("s", "script")], DEF_STEPS)!.gather).toBeNull();
  expect(newsStepCards([], DEF_STEPS)).toBeNull();
  expect(newsStepCards(null, DEF_STEPS)).toBeNull();
});

// --- §3.9: Quick read rows joined to the explained stories --------------

const EXPLAIN = await readFile(join(FIXTURES, "explain-summary.md"), "utf8");

interface ExplainedFixture {
  title: string;
  sources: string[];
  summary?: string;
  detail?: string;
  explanation?: string;
  whyItMatters: string;
  unknowns: string;
}

function explainData(): { stories: ExplainedFixture[] } {
  return JSON.parse(JSON.stringify(parsePipelineHandoff(EXPLAIN)!.data));
}

test("the recorded explain handoff joins every Quick read row to its story by source: detail, why it matters, not known yet", () => {
  const view = news(newsView(SCRIPT, GATHER, true, EXPLAIN));
  const stories = explainData().stories;
  expect(view.rows.map((r) => r.explained)).toEqual(
    stories.map((s) => ({ detail: s.detail!, whyItMatters: s.whyItMatters, unknowns: s.unknowns })),
  );
  // Sources and flags are unchanged by the join.
  expect(view.rows.map((r) => r.flag)).toEqual([null, null, null]);
});

test("the recorded explain handoff passes the eval's explain-shape, facts-retained and depth checks against the recorded gather", () => {
  const checks = checkAiNewsRun({ gather: parsePipelineHandoff(GATHER)!.data, explain: explainData(), final: parsePipelineHandoff(SCRIPT)!.data, costUsd: 1, now: new Date("2026-10-07T12:00:00Z") });
  for (const name of ["explain-shape", "facts-retained", "depth"]) {
    const c = checks.find((x) => x.name === name)!;
    expect(c.pass, `${name}: ${c.detail}`).toBe(true);
  }
});

test("join by source wins over position: the scriptwriter may reorder the quick read", () => {
  const data = scriptData();
  data.quickRead.reverse();
  const rows = news(newsView(handoff(data), GATHER, true, EXPLAIN)).rows;
  expect(rows.map((r) => r.explained!.detail.slice(0, 30))).toEqual([
    "A chipmaker announced a new ac",
    "A national regulator published",
    "A research lab released an ope",
  ]);
  // A story's second source matches too.
  data.quickRead[2]!.source = "https://arxiv.example.org/abs/2610.01234";
  expect(news(newsView(handoff(data), GATHER, true, EXPLAIN)).rows[2]!.explained!.detail).toStartWith("A research lab");
});

test("no source match: by position when the counts match, else no detail", () => {
  const data = scriptData();
  data.quickRead.forEach((r) => { r.source = ""; });
  const byPosition = news(newsView(handoff(data), GATHER, true, EXPLAIN)).rows;
  expect(byPosition.map((r) => r.explained!.detail.slice(0, 12))).toEqual(["A research l", "A national r", "A chipmaker "]);

  // Two explained stories for three rows: unmatched rows get none, a matched row still joins.
  const two = explainData();
  two.stories.splice(1, 1);
  const fewer = scriptData();
  fewer.quickRead[0]!.source = "";
  const rows = news(newsView(handoff(fewer), GATHER, true, handoff(two))).rows;
  expect(rows.map((r) => (r.explained ? r.explained.detail.slice(0, 12) : null))).toEqual([null, null, "A chipmaker "]);
});

test("old runs: an explainer's `explanation` is shown as the detail; missing or broken explain output means no detail, never a throw", () => {
  const old = explainData();
  old.stories.forEach((s) => { s.explanation = `Old: ${String(s.title)}`; delete s.detail; delete s.summary; });
  const rows = news(newsView(SCRIPT, GATHER, true, handoff(old))).rows;
  expect(rows[0]!.explained).toEqual({ detail: "Old: Open model matches frontier scores on coding benchmark", whyItMatters: old.stories[0]!.whyItMatters, unknowns: old.stories[0]!.unknowns });
  // `detail` wins over `explanation`; blank text counts as none.
  expect(joinExplained([{ source: "" }], { stories: [{ detail: " D ", explanation: "E" }] })).toEqual([{ detail: "D", whyItMatters: "", unknowns: "" }]);
  expect(joinExplained([{ source: "" }], { stories: [{ detail: "  ", explanation: "E", whyItMatters: 3 }] })).toEqual([{ detail: "E", whyItMatters: "", unknowns: "" }]);
  expect(joinExplained([{ source: "" }], { stories: [{ whyItMatters: "W" }] })).toEqual([null]);
  for (const bad of [undefined, "", "prose only", handoff({ stories: "no" }), handoff({ stories: [null, 4, "x"] }), "```pipeline-handoff\n{broken\n```"]) {
    expect(news(newsView(SCRIPT, GATHER, true, bad)).rows.map((r) => r.explained), String(bad)).toEqual([null, null, null]);
  }
});

test("retro runs: the analyst's stories with empty sources join by position and show their explanation", () => {
  const analysis = handoff({
    stories: [
      { group: "done", title: "Shipped", date: "2026-10-10", sources: [], explanation: "You shipped it.", whyItMatters: "W1", unknowns: "U1" },
      { group: "ideas", title: "Idea", date: "2026-10-10", sources: [], explanation: "Try this.", whyItMatters: "W2", unknowns: "U2" },
    ],
  });
  const final = handoff({ quickRead: [{ headline: "Shipped", oneLine: "x", source: "" }, { headline: "Idea", oneLine: "y", source: "" }], script: "Hi.\n\nBye." });
  expect(news(newsView(final, undefined, true, analysis)).rows.map((r) => r.explained)).toEqual([
    { detail: "You shipped it.", whyItMatters: "W1", unknowns: "U1" },
    { detail: "Try this.", whyItMatters: "W2", unknowns: "U2" },
  ]);
});

test("newsStepCards: the explain card is the step with an edge into the scriptwriter's step", () => {
  const edges = aiNewsPodcastDraft().graph.edges;
  const steps = [card("g", "gather"), card("e1", "explain", "failed"), card("e2", "explain"), card("s", "script"), card("a", "audio")];
  expect(newsStepCards(steps, DEF_STEPS, edges)!.explain!.id).toBe("e2");
  // The retro pipeline's analyse step feeds the same scriptwriter.
  const retro = wisselRetroPodcastDraft().graph;
  const retroSteps = [card("c", "collect"), card("an", "analyse"), card("s", "script"), card("a", "audio")];
  expect(newsStepCards(retroSteps, retro.steps, retro.edges)!.explain!.id).toBe("an");
  // No edges (definition gone): the card that ran just before the scriptwriter.
  const routed = [card("g", "x1", "done", "ai-news-gatherer"), card("e", "x2", "done", "ai-news-explainer"), card("s", "x3", "done", "podcast-scriptwriter")];
  expect(newsStepCards(routed, [])!.explain!.id).toBe("e");
  // Gather straight into script: no explain card. Not a news pipeline: none either.
  expect(newsStepCards([card("g", "gather"), card("s", "script")], DEF_STEPS, [{ from: "gather", to: "script" }])!.explain).toBeNull();
  expect(newsStepCards([card("a", "one", "done", "triager"), card("b", "two", "done", "summarizer")], [])!.explain).toBeNull();
});

test("newsAudioView maps the audio step's status and the run summary's audio to the Listen tab's state", () => {
  const url = "/pipeline-runs/r1/audio";
  expect(newsAudioView(null, null)).toEqual({ state: "none" });
  expect(newsAudioView(undefined, undefined)).toEqual({ state: "none" });
  for (const s of ["inbox", "ready", "dispatched", "running"]) expect(newsAudioView({ status: s }, null), s).toEqual({ state: "making" });
  for (const s of ["failed", "escalated", "no-match"]) expect(newsAudioView({ status: s }, null), s).toEqual({ state: "failed" });
  // Done but the summary hasn't reported a file (yet, or it's gone).
  expect(newsAudioView({ status: "done" }, null)).toEqual({ state: "none" });
  // The file wins over the card, whatever the card says.
  expect(newsAudioView({ status: "done" }, { url, bytes: 6032 })).toEqual({ state: "ready", url, bytes: 6032 });
  expect(newsAudioView({ status: "running" }, { url, bytes: 6032 })).toEqual({ state: "ready", url, bytes: 6032 });
  expect(newsAudioView(null, { url })).toEqual({ state: "ready", url, bytes: null });
  // Malformed summary audio is ignored, never a broken player.
  for (const bad of [{}, { url: "" }, { url: 7 }, "x", 1]) expect(newsAudioView({ status: "failed" }, bad), JSON.stringify(bad)).toEqual({ state: "failed" });
});

// --- parseHandoffData mirrors parsePipelineHandoff ----------------------

test("parseHandoffData gives the same data as parsePipelineHandoff for every input shape", () => {
  const inputs = [
    GATHER, SCRIPT, "", "no block",
    "```pipeline-handoff\n{\"data\": {\"a\": 1}}\n```",
    "```pipeline-handoff\n{\"data\": {\"a\": 1}}\n```\nlater\n```pipeline-handoff\n{\"data\": {\"a\": 2}}\n```",
    "```pipeline-handoff\n{\"next\": \"\", \"data\": {\"a\": 1}}\n```",
    "```pipeline-handoff\n{\"next\": \"b\", \"data\": {\"a\": 1}}\n```",
    "```pipeline-handoff\n{\"note\": 3, \"data\": {\"a\": 1}}\n```",
    "```pipeline-handoff\n{\"data\": [1]}\n```",
    "```pipeline-handoff\n{\"data\": null}\n```",
    "```pipeline-handoff\n[1, 2]\n```",
    "```pipeline-handoff\n{\"note\": \"only a note\"}\n```",
    "```pipeline-handoff   \n  {\"data\": {\"a\": 1}}  \n```",
    "```pipeline-handoff\n{broken\n```",
  ];
  for (const input of inputs) {
    expect(parseHandoffData(input), input).toEqual(parsePipelineHandoff(input)?.data ?? null);
  }
  // Repeat calls don't share regex state.
  expect(parseHandoffData(SCRIPT)).toEqual(parseHandoffData(SCRIPT));
});

test("gatherUrlSet skips non-string URLs and malformed stories, and is null without a stories list", () => {
  expect([...gatherUrlSet({ stories: [{ sources: ["https://a", 5, null, "https://b"] }, null, { sources: "https://c" }, { sources: ["https://a"] }] })!]).toEqual(["https://a", "https://b"]);
  for (const bad of [null, undefined, "x", [], {}, { stories: "x" }]) expect(gatherUrlSet(bad)).toBeNull();
});

// --- Script paragraphs: one utterance each ------------------------------

test("splitScript: blank lines separate paragraphs; CRLF, extra blank lines and inner whitespace are normalised", () => {
  expect(splitScript("A one.\n\nB two.")).toEqual(["A one.", "B two."]);
  expect(splitScript("A one.\r\n\r\n\r\nB  two\nstill B.\n \t\nC.")).toEqual(["A one.", "B two still B.", "C."]);
  expect(splitScript("  only one paragraph  ")).toEqual(["only one paragraph"]);
  // No blank lines at all: fall back to single line breaks.
  expect(splitScript("Line one.\nLine two.\n")).toEqual(["Line one.", "Line two."]);
  for (const bad of [undefined, null, 3, "", "   \n\n  "]) expect(splitScript(bad)).toEqual([]);
});

// --- Speech --------------------------------------------------------------

test("hasSpeech needs both speechSynthesis.speak and SpeechSynthesisUtterance", () => {
  const synth = { speak() {} };
  class U {}
  expect(hasSpeech({ speechSynthesis: synth, SpeechSynthesisUtterance: U })).toBe(true);
  expect(hasSpeech({ speechSynthesis: synth })).toBe(false);
  expect(hasSpeech({ speechSynthesis: undefined, SpeechSynthesisUtterance: U })).toBe(false);
  expect(hasSpeech({ speechSynthesis: {}, SpeechSynthesisUtterance: U })).toBe(false);
  expect(hasSpeech(undefined)).toBe(false);
});

test("pickVoice prefers an English default, then en-US, then en-GB, then any English; never a non-English voice", () => {
  const v = (lang: string, extra: Record<string, unknown> = {}) => ({ name: lang, lang, ...extra });
  expect(pickVoice([v("de-DE", { default: true }), v("en-GB"), v("en-US")])!.lang).toBe("en-US");
  expect(pickVoice([v("en-AU"), v("en-GB"), v("en-IN", { default: true })])!.lang).toBe("en-IN");
  expect(pickVoice([v("fr-FR"), v("en_GB"), v("en-AU")])!.lang).toBe("en_GB");
  expect(pickVoice([v("fr-FR"), v("en-AU")])!.lang).toBe("en-AU");
  expect(pickVoice([v("en")])!.lang).toBe("en");
  expect(pickVoice([v("fr-FR"), v("eng-XX")])).toBeNull();
  expect(pickVoice([])).toBeNull();
  expect(pickVoice(undefined)).toBeNull();
});

test("pickVoice takes an on-device voice over a network one at the same step (Chrome's network voices cut off)", () => {
  const voices = [
    { name: "Google US English", lang: "en-US", localService: false },
    { name: "Local US", lang: "en-US", localService: true },
    { name: "Local GB", lang: "en-GB", localService: true },
  ];
  expect(pickVoice(voices)!.name).toBe("Local US");
  // An en-US network voice still beats an en-GB local one: language first.
  expect(pickVoice([voices[0]!, voices[2]!])!.name).toBe("Google US English");
});

class FakeUtterance {
  text: string;
  voice?: unknown;
  lang = "";
  onstart?: () => void;
  onend?: () => void;
  onerror?: () => void;
  constructor(text: string) { this.text = text; }
}

function fakeSynth(voices: { lang: string; default?: boolean }[] = []) {
  const calls: string[] = [];
  const spoken: FakeUtterance[] = [];
  return {
    calls, spoken, paused: false, speaking: false, pending: false,
    speak(u: FakeUtterance) { calls.push("speak"); spoken.push(u); },
    cancel() { calls.push("cancel"); },
    pause() { calls.push("pause"); this.paused = true; },
    resume() { calls.push("resume"); this.paused = false; },
    getVoices() { return voices; },
  };
}

test("Read aloud queues one utterance per paragraph with an English voice; events move the highlight and end at idle", () => {
  const synth = fakeSynth([{ lang: "de-DE", default: true }, { lang: "en-US" }]);
  const changes: [string, number][] = [];
  const reader = createNewsReader(synth, FakeUtterance, (s, i) => changes.push([s, i]));
  const paragraphs = news(newsView(SCRIPT, GATHER, true)).paragraphs;
  reader.play(paragraphs);
  expect(synth.spoken.map((u) => u.text)).toEqual(paragraphs);
  expect(synth.spoken.every((u) => u.lang === "en-US" && (u.voice as { lang: string }).lang === "en-US")).toBe(true);
  // Nothing was queued, so no cancel() first (Chrome can drop the first
  // utterance spoken right after one).
  expect(synth.calls).toEqual(paragraphs.map(() => "speak"));
  expect(reader.state()).toBe("speaking");
  synth.spoken[2]!.onstart!();
  expect(reader.current()).toBe(2);
  // Only the last paragraph's end finishes the read.
  synth.spoken[2]!.onend!();
  expect(reader.state()).toBe("speaking");
  synth.spoken[4]!.onend!();
  expect(reader.state()).toBe("idle");
  expect(changes.at(-1)).toEqual(["idle", -1]);
});

test("with no English voice the utterances still ask for en-US", () => {
  const synth = fakeSynth([{ lang: "fr-FR" }]);
  createNewsReader(synth, FakeUtterance).play(["Un.", "Deux."]);
  expect(synth.spoken.map((u) => [u.lang, u.voice])).toEqual([["en-US", undefined], ["en-US", undefined]]);
});

test("Pause, then Read aloud resumes instead of starting over; Stop cancels and stale events can't revive the read", () => {
  const synth = fakeSynth();
  const reader = createNewsReader(synth, FakeUtterance);
  reader.play(["A.", "B."]);
  reader.pause();
  expect(reader.state()).toBe("paused");
  reader.pause(); // no-op when not speaking
  reader.play(["A.", "B."]);
  expect(reader.state()).toBe("speaking");
  expect(synth.calls).toEqual(["speak", "speak", "pause", "resume"]);
  reader.play(["A.", "B."]); // already speaking: no second queue
  expect(synth.spoken).toHaveLength(2);

  const first = [...synth.spoken];
  reader.stop();
  expect(synth.calls.at(-1)).toBe("cancel");
  expect(reader.state()).toBe("idle");
  // Chrome fires the cancelled utterances' events after cancel().
  first[0]!.onstart!();
  first[1]!.onerror!();
  first[1]!.onend!();
  expect(reader.state()).toBe("idle");
  expect(reader.current()).toBe(-1);

  // Stop while idle doesn't touch the synth.
  const before = synth.calls.length;
  reader.stop();
  expect(synth.calls.length).toBe(before);
});

test("a fresh read cancels speech already playing (another tab's) and clears a leftover pause; an utterance error stops the read", () => {
  const synth = fakeSynth();
  synth.paused = true;
  synth.speaking = true;
  const reader = createNewsReader(synth, FakeUtterance);
  reader.play(["A.", "B."]);
  expect(synth.calls).toEqual(["cancel", "speak", "speak", "resume"]);
  synth.spoken[0]!.onerror!();
  expect(reader.state()).toBe("idle");
  expect(synth.calls.at(-1)).toBe("cancel");
  // Nothing to read: nothing happens.
  reader.play([]);
  expect(reader.state()).toBe("idle");
  expect(synth.spoken).toHaveLength(2);
});

// --- Served and loaded by the board --------------------------------------

test("board.html loads board-news.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-news.js"></script>');
  expect(tag).toBeGreaterThan(0);
  expect(tag).toBeLessThan(html.indexOf("<script>\n(function () {"));
});

test("GET /board-news.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), await Registry.load());
  const res = await app(new Request("http://localhost/board-news.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function newsView(");
});

test("the drawer has no Copy script button and never touches navigator.clipboard (needs a secure context)", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const news = await readFile(join(import.meta.dir, "..", "src", "api", "public", "board-news.js"), "utf8");
  expect(html).not.toContain("navigator.clipboard");
  expect(news).not.toContain("navigator.clipboard");
  expect(html).not.toMatch(/Copy script/);
});

test("board-news.js has no em dashes", async () => {
  const news = await readFile(join(import.meta.dir, "..", "src", "api", "public", "board-news.js"), "utf8");
  const dts = await readFile(join(import.meta.dir, "..", "src", "api", "public", "board-news.d.ts"), "utf8");
  const EM_DASH = String.fromCharCode(0x2014);
  expect(news.includes(EM_DASH) || dts.includes(EM_DASH)).toBe(false);
});
