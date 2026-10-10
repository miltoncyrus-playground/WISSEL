import { expect, test } from "bun:test";
import {
  ageInDays,
  checkAiNewsRun,
  checkWorldNewsRun,
  countWords,
  extractNames,
  extractNumbers,
  gatherSourceSet,
  nameRetained,
  siteOf,
  type AiNewsRunOutputs,
} from "../eval/ai-news-checks.ts";

// The deterministic half of eval/ai-news-podcast.eval.ts
// (docs/SDD-ai-news-podcast.md §5), proven here so the paid eval only
// has to supply real outputs.

const NOW = new Date("2026-10-07T15:00:00Z");

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

function story(i: number, date = "2026-10-05") {
  return { title: `Story ${i}`, date, sources: [`https://lab${i}.example.com/news/${i}`, `https://mirror.example.org/${i}`], facts: "f" };
}

/** The explain step's data for `gather`, story for story: titles,
 *  dates, sources and region copied, `facts` carried whole into
 *  `detail` (so every number and name is kept) and padded to 70 words. */
function explainFor(gather: unknown): { stories: Record<string, unknown>[] } {
  const stories = (gather as { stories?: unknown })?.stories;
  return {
    stories: (Array.isArray(stories) ? stories : []).map((s: Record<string, unknown>) => ({
      ...(s.region === undefined ? {} : { region: s.region }),
      title: s.title,
      date: s.date,
      sources: s.sources,
      summary: "One sentence on what happened.",
      detail: `${String(s.facts)} ${words(70)}`,
      whyItMatters: "It matters.",
      unknowns: "Not known yet.",
    })),
  };
}

function goodRun(overrides: Partial<AiNewsRunOutputs> = {}): AiNewsRunOutputs {
  const stories = [1, 2, 3, 4, 5, 6].map((i) => story(i));
  const gather = "gather" in overrides ? overrides.gather : { generatedAt: "2026-10-07", stories };
  return {
    gather,
    explain: explainFor(gather),
    final: {
      quickRead: stories.map((s, i) => ({ headline: s.title, oneLine: "x", source: s.sources[i % 2] })),
      script: `${words(400)}\n\n${words(400)}`,
      wordCount: 800,
    },
    costUsd: 1.2,
    now: NOW,
    ...overrides,
  };
}

function failing(run: AiNewsRunOutputs): string[] {
  return checkAiNewsRun(run).filter((c) => !c.pass).map((c) => c.name);
}

test("a good run passes every check", () => {
  const checks = checkAiNewsRun(goodRun());
  expect(checks.map((c) => c.name)).toEqual([
    "gather-shape",
    "final-shape",
    "sources-from-gather",
    "sources-per-story",
    "source-spread",
    "dates-recent",
    "story-count",
    "word-count",
    "cost",
    "explain-shape",
    "facts-retained",
    "depth",
  ]);
  expect(failing(goodRun())).toEqual([]);
});

test("a final source the gather step never handed off fails sources-from-gather and names it", () => {
  const run = goodRun();
  (run.final as { quickRead: { source: unknown }[] }).quickRead[2]!.source = "https://invented.example.net/x";
  expect(failing(run)).toEqual(["sources-from-gather"]);
  expect(checkAiNewsRun(run).find((c) => c.name === "sources-from-gather")!.detail).toContain("https://invented.example.net/x");
  // A missing source is just as bad as an invented one.
  delete (run.final as { quickRead: { source?: unknown }[] }).quickRead[2]!.source;
  expect(failing(run)).toEqual(["sources-from-gather"]);
});

test("dates: older than 7 days, missing, malformed or far future fail; exactly 7 days and tomorrow pass", () => {
  for (const bad of ["2026-09-29", "", "2026-10-32", "Oct 5", "2026-10-09"]) {
    const run = goodRun();
    (run.gather as { stories: { date: unknown }[] }).stories[0]!.date = bad;
    expect(failing(run), bad).toEqual(["dates-recent"]);
  }
  const run = goodRun();
  (run.gather as { stories: { date: unknown }[] }).stories[0]!.date = "2026-09-30";
  (run.gather as { stories: { date: unknown }[] }).stories[1]!.date = "2026-10-08";
  expect(failing(run)).toEqual([]);
});

test("story count must be 5 to 8; word count 600 to 1000, counted from the script, not the model's wordCount", () => {
  const run = goodRun();
  const final = run.final as { quickRead: unknown[]; script: string; wordCount: number };
  final.quickRead = final.quickRead.slice(0, 4);
  expect(failing(run)).toEqual(["story-count"]);

  const long = goodRun();
  (long.final as { script: string }).script = words(1001);
  expect(failing(long)).toEqual(["word-count"]);
  (long.final as { script: string }).script = words(1000);
  expect(failing(long)).toEqual([]);
  (long.final as { script: string }).script = words(599);
  expect(failing(long)).toEqual(["word-count"]);
});

test("cost must be reported and under $1.50", () => {
  expect(failing(goodRun({ costUsd: 1.5 }))).toEqual(["cost"]);
  expect(failing(goodRun({ costUsd: undefined }))).toEqual(["cost"]);
  expect(failing(goodRun({ costUsd: 1.49 }))).toEqual([]);
});

test("missing or malformed handoff data fails without throwing", () => {
  const explainChecks = ["explain-shape", "facts-retained", "depth"];
  const all = ["gather-shape", "final-shape", "sources-from-gather", "sources-per-story", "source-spread", "dates-recent", "story-count", "word-count", ...explainChecks];
  expect(failing(goodRun({ gather: undefined, final: undefined }))).toEqual(all);
  expect(failing(goodRun({ gather: { stories: "no" }, final: [] }))).toEqual(all);
  expect(failing(goodRun({ gather: { stories: [] } }))).toEqual(["gather-shape", "sources-from-gather", "sources-per-story", "source-spread", "dates-recent", ...explainChecks]);
  for (const explain of [undefined, null, "text", { stories: "no" }, []]) {
    expect(failing(goodRun({ explain })), JSON.stringify(explain)).toEqual(explainChecks);
  }
});

test("helpers: source set, word count, day age", () => {
  expect([...gatherSourceSet({ stories: [{ sources: ["a", 3, "b"] }, { sources: "c" }, null] })]).toEqual(["a", "b"]);
  expect(countWords("")).toBe(0);
  expect(countWords("  one\n\ntwo  three ")).toBe(3);
  expect(ageInDays("2026-10-07", NOW)).toBe(0);
  expect(ageInDays("2026-09-30", NOW)).toBe(7);
  expect(ageInDays("2026-02-30", NOW)).toBeNull();
  expect(ageInDays(20261007, NOW)).toBeNull();
});

// The first live run (2026-10-07) cited one roundup page for 5 stories
// and its site for 6 of 8; both checks must catch that shape.
test("a roundup page shared by several stories fails sources-per-story and source-spread", () => {
  const roundup = "https://aiweekly.co/ai-news-today/edition/2026-10-01";
  const stories = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
    ...story(i),
    sources: i <= 5 ? [roundup] : i === 6 ? ["https://aiweekly.co/ai-news-today"] : [`https://lab${i}.example.com/news/${i}`],
  }));
  const run = goodRun({
    gather: { generatedAt: "2026-10-07", stories },
    final: { quickRead: stories.map((s) => ({ headline: s.title, oneLine: "x", source: s.sources[0] })), script: `${words(400)}\n\n${words(400)}`, wordCount: 800 },
  });
  expect(failing(run)).toEqual(["sources-per-story", "source-spread"]);
  const spread = checkAiNewsRun(run).find((c) => c.name === "source-spread")!;
  expect(spread.detail).toContain("aiweekly.co (6)");
});

test("three stories from one lab is fine; four is not", () => {
  const mk = (n: number) => [1, 2, 3, 4, 5, 6].map((i) => ({ ...story(i), sources: [i <= n ? `https://openai.com/index/post-${i}` : `https://lab${i}.example.com/news/${i}`] }));
  const run = (n: number) => goodRun({ gather: { generatedAt: "2026-10-07", stories: mk(n) }, final: { quickRead: mk(n).map((s) => ({ headline: s.title, oneLine: "x", source: s.sources[0] })), script: `${words(400)}\n\n${words(400)}`, wordCount: 800 } });
  expect(failing(run(3))).toEqual([]);
  expect(failing(run(4))).toEqual(["source-spread"]);
});

test("siteOf strips www and rejects non-URLs", () => {
  expect(siteOf("https://www.anthropic.com/news/x")).toBe("anthropic.com");
  expect(siteOf("not a url")).toBeNull();
  expect(siteOf(undefined)).toBeNull();
});

// ---- World news podcast (SDD §3.8) ----

function worldRun(regions: (string | undefined)[], date = "2026-10-07"): AiNewsRunOutputs {
  const stories = regions.map((region, i) => ({ ...story(i + 1, date), ...(region === undefined ? {} : { region }) }));
  return goodRun({
    gather: { generatedAt: "2026-10-07", stories },
    final: { quickRead: stories.map((s) => ({ headline: s.title, oneLine: "x", source: s.sources[0] })), script: `${words(400)}\n\n${words(400)}`, wordCount: 800 },
  });
}
const worldFailing = (run: AiNewsRunOutputs) => checkWorldNewsRun(run).filter((c) => !c.pass).map((c) => c.name);

test("world run: world, spain and netherlands all covered passes every check, regions included", () => {
  const run = worldRun(["world", "world", "world", "world", "spain", "spain", "netherlands", "netherlands"]);
  expect(worldFailing(run)).toEqual([]);
  expect(checkWorldNewsRun(run).find((c) => c.name === "regions")!.detail).toBe("world 4, spain 2, netherlands 2");
});

test("world run: a missing region, or a story with none, fails the regions check", () => {
  expect(worldFailing(worldRun(["world", "world", "world", "spain", "spain"]))).toEqual(["regions"]);
  expect(checkWorldNewsRun(worldRun(["world", "world", "world", "spain", "spain"])).find((c) => c.name === "regions")!.detail).toBe("no story for: netherlands");
  expect(worldFailing(worldRun(["world", "world", "spain", "netherlands", undefined]))).toEqual(["regions"]);
});

test("world run: world stories may be 2 days old, Spain and Netherlands 4", () => {
  // NOW is 2026-10-07. 2026-10-04 is 3 days back, 2026-10-02 is 5.
  const mk = (dates: Record<string, string>) => {
    const regions = ["world", "world", "world", "spain", "netherlands"];
    const stories = regions.map((region, i) => ({ ...story(i + 1, dates[region]!), region }));
    return goodRun({
      gather: { generatedAt: "2026-10-07", stories },
      final: { quickRead: stories.map((s) => ({ headline: s.title, oneLine: "x", source: s.sources[0] })), script: `${words(400)}\n\n${words(400)}`, wordCount: 800 },
    });
  };
  // A 3-day-old Spain or Netherlands story is fine (the 2026-10-09 run's
  // election call was this case).
  expect(worldFailing(mk({ world: "2026-10-06", spain: "2026-10-04", netherlands: "2026-10-04" }))).toEqual([]);
  // A 3-day-old world story is not.
  const oldWorld = mk({ world: "2026-10-04", spain: "2026-10-06", netherlands: "2026-10-06" });
  expect(worldFailing(oldWorld)).toEqual(["dates-recent"]);
  expect(checkWorldNewsRun(oldWorld).find((c) => c.name === "dates-recent")!.detail).toContain("(world, ");
  // A 5-day-old national story is too old too.
  expect(worldFailing(mk({ world: "2026-10-06", spain: "2026-10-02", netherlands: "2026-10-06" }))).toEqual(["dates-recent"]);
  // The AI checks keep their 7-day window.
  expect(failing(mk({ world: "2026-10-02", spain: "2026-10-02", netherlands: "2026-10-02" }))).toEqual([]);
});

// ---- §3.9 explain at the listener's level ----

const AI_FACTS =
  "Anthropic released Claude Opus 5.5 on October 7, scoring 82.1% on SWE-bench Verified. " +
  "It costs $15 per million input tokens and has a 1,000,000 token context window. " +
  '"We think this is a real step," said Anthropic CEO Dario Amodei. ' +
  "OpenAI's GPT-5 scored 74.9 percent on the same test. Nvidia sold 1.200.000 H100 chips worth $2.5bn.";

test("extractNumbers: keeps currency, scale and percent with the number and normalises separators", () => {
  expect(extractNumbers(AI_FACTS)).toEqual(["5.5", "7", "82.1%", "$15", "1000000", "5", "74.9%", "1200000", "$2.5 billion"]);
  // The same quantities, written another way, normalise to the same tokens.
  expect(extractNumbers("1,200 and 1200; 1.50 and 1.5; 40 percent, 40 per cent and 40%; $2.5bn and $2.5 billion; €3 million")).toEqual([
    "1200", "1200", "1.5", "1.5", "40%", "40%", "40%", "$2.5 billion", "$2.5 billion", "€3 million",
  ]);
  // Glued to letters it's a name, not a number; a sentence's full stop isn't a decimal.
  expect(extractNumbers("The 70B model ran on H100s and Llama-3. It cost 20.")).toEqual(["3", "20"]);
  expect(extractNumbers("")).toEqual([]);
});

test("extractNames: capitalised runs not at a sentence start, plus inner-capital or digit tokens anywhere", () => {
  expect(extractNames(AI_FACTS)).toEqual(["Claude Opus", "SWE-bench", "SWE-bench Verified", "CEO", "Anthropic CEO Dario Amodei", "OpenAI", "GPT-5", "H100"]);
  // Sentence-start words and opening quotes are not names; weekdays and months are not names.
  expect(extractNames("The vote was on Monday in March. Then Pedro Sánchez spoke.")).toEqual(["Pedro Sánchez"]);
  expect(extractNames("Pedro Sánchez spoke. Anthropic said no.")).toEqual(["Sánchez"]);
  // A comma ends a run: two names, not one.
  expect(extractNames("Talks between Spain, France and the Netherlands ended.")).toEqual(["Spain", "France", "Netherlands"]);
  expect(extractNames("the Dutch PM's office said the 70B model is fine")).toEqual(["PM", "Dutch PM", "70B"]);
});

test("nameRetained: as written, case-insensitive, or every word of a reordered run", () => {
  expect(nameRetained("said openai's ceo", "OpenAI")).toBe(true);
  expect(nameRetained("Dario Amodei, Anthropic's CEO, said", "Anthropic CEO Dario Amodei")).toBe(true);
  expect(nameRetained("Amodei said", "Anthropic CEO Dario Amodei")).toBe(false);
  // Whole words only: GPT-5 is not kept by GPT-50.
  expect(nameRetained("GPT-50 shipped", "GPT-5")).toBe(false);
});

/** A one-story AI run: gather `facts`, explain with `explained` as its detail. */
function factsRun(facts: string, explained: string, extra: Record<string, unknown> = {}): AiNewsRunOutputs {
  const s = { ...story(1), facts };
  return goodRun({
    gather: { generatedAt: "2026-10-07", stories: [s] },
    explain: { stories: [{ title: s.title, date: s.date, sources: s.sources, summary: "What happened.", detail: `${explained} ${words(60)}`, whyItMatters: "W.", unknowns: "U.", ...extra }] },
  });
}
const check = (run: AiNewsRunOutputs, name: string) => checkAiNewsRun(run).find((c) => c.name === name)!;

test("facts-retained: every number and name kept passes, reformatted numbers included", () => {
  const facts = "Mistral raised €1,200 million at a valuation of $14.00 billion, up 40 percent. CEO Arthur Mensch confirmed it.";
  const explained = "Mistral, led by chief executive Arthur Mensch (CEO), raised €1200 million; its valuation is $14 billion, a 40% rise.";
  const c = check(factsRun(facts, explained), "facts-retained");
  expect(c.pass).toBe(true);
  expect(c.detail).toBe("numbers 3/3 (100%) (want 90%), names 2/2 (100%) (want 80%)");
});

test("facts-retained: a dropped number below 90% fails and the detail names it per story", () => {
  const facts = "Claude scored 82.1% and GPT-5 scored 74.9%.";
  const c = check(factsRun(facts, "Claude scored 82.1% and GPT-5 did worse."), "facts-retained");
  expect(c.pass).toBe(false);
  expect(c.detail).toBe('numbers 2/3 (67%) (want 90%), names 1/1 (100%) (want 80%); "Story 1" lost "74.9%"');
});

test("facts-retained: the 90% numbers and 80% names lines are inclusive", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `${i + 11}`);
  const facts = `The counts were ${ten.join(", ")}.`;
  expect(check(factsRun(facts, `Counts: ${ten.slice(0, 9).join(", ")}.`), "facts-retained").pass).toBe(true);
  expect(check(factsRun(facts, `Counts: ${ten.slice(0, 8).join(", ")}.`), "facts-retained").pass).toBe(false);

  const five = ["H100", "GPT-5", "OpenAI", "DeepMind", "iPhone"];
  const named = `It mentions ${five.join(", ")}.`;
  expect(check(factsRun(named, five.slice(0, 4).join(" ")), "facts-retained").pass).toBe(true);
  const c = check(factsRun(named, five.slice(0, 3).join(" ")), "facts-retained");
  expect(c.pass).toBe(false);
  expect(c.detail).toContain('lost "DeepMind", "iPhone"');
});

test("facts-retained: names and numbers count from summary, detail, whyItMatters and unknowns, not the title", () => {
  const facts = "Spain's PSOE won 121 seats.";
  expect(check(factsRun(facts, "A result.", { summary: "PSOE won.", whyItMatters: "121 seats matter." }), "facts-retained").pass).toBe(true);
  expect(check(factsRun(facts, "A result.", { title: "PSOE wins 121 seats" }), "facts-retained").pass).toBe(false);
});

test("depth: detail at least 60 words (world 50) and a summary of 1 to 30 words", () => {
  const one = (summary: unknown, detailWords: number) => {
    const s = story(1);
    return goodRun({
      gather: { generatedAt: "2026-10-07", stories: [s] },
      explain: { stories: [{ title: s.title, date: s.date, sources: s.sources, summary, detail: words(detailWords), whyItMatters: "W", unknowns: "U" }] },
    });
  };
  expect(check(one("Short.", 60), "depth").pass).toBe(true);
  expect(check(one(words(30), 150), "depth").pass).toBe(true);
  expect(check(one("Short.", 59), "depth").detail).toBe('"Story 1" detail is 59 words (want summary 1 to 30 words, detail at least 60)');
  expect(check(one(words(31), 60), "depth").detail).toContain('"Story 1" summary is 31 words');
  expect(check(one(undefined, 60), "depth").detail).toContain('"Story 1" has no summary');
  expect(check(one("", 60), "depth").pass).toBe(false);
  // An old explainer's `explanation` has no detail at all.
  const old = goodRun();
  (old.explain as { stories: Record<string, unknown>[] }).stories.forEach((s) => { s.explanation = s.detail; delete s.detail; });
  expect(failing(old)).toEqual(["depth"]);
  // World stories need 50 words.
  const w = one("Short.", 50);
  expect(check(w, "depth").pass).toBe(false);
  expect(checkWorldNewsRun(w).find((c) => c.name === "depth")!.pass).toBe(true);
  expect(checkWorldNewsRun(one("Short.", 49)).find((c) => c.name === "depth")!.pass).toBe(false);
});

test("explain-shape: count, order and sources must match the gather step", () => {
  const reordered = goodRun();
  (reordered.explain as { stories: unknown[] }).stories.reverse();
  expect(failing(reordered)).toContain("explain-shape");
  expect(check(reordered, "explain-shape").detail).toContain('story 1 is "Story 6", gather has "Story 1"');

  const dropped = goodRun();
  (dropped.explain as { stories: unknown[] }).stories.pop();
  expect(failing(dropped)).toEqual(["explain-shape"]);
  expect(check(dropped, "explain-shape").detail).toBe("5 explained stories for 6 gathered");

  const changed = goodRun();
  (changed.explain as { stories: { sources: string[] }[] }).stories[2]!.sources = ["https://lab3.example.com/news/3"];
  expect(failing(changed)).toEqual(["explain-shape"]);
  expect(check(changed, "explain-shape").detail).toBe('story 3 "Story 3" sources changed');

  expect(check(goodRun(), "explain-shape").detail).toBe("6 stories, same order and sources as gather");
});

test("world run: the explain checks run too, with region carried through", () => {
  const run = worldRun(["world", "world", "world", "world", "spain", "spain", "netherlands", "netherlands"]);
  expect(checkWorldNewsRun(run).map((c) => c.name)).toEqual(expect.arrayContaining(["explain-shape", "facts-retained", "depth", "regions"]));
  // Every story dropped: shape and depth fail (these facts hold no
  // number or name, so nothing was lost for facts-retained).
  run.explain = { stories: [] };
  expect(worldFailing(run)).toEqual(["explain-shape", "depth"]);
});
