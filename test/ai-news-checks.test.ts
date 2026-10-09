import { expect, test } from "bun:test";
import { ageInDays, checkAiNewsRun, countWords, gatherSourceSet, siteOf, type AiNewsRunOutputs } from "../eval/ai-news-checks.ts";

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

function goodRun(overrides: Partial<AiNewsRunOutputs> = {}): AiNewsRunOutputs {
  const stories = [1, 2, 3, 4, 5, 6].map((i) => story(i));
  return {
    gather: { generatedAt: "2026-10-07", stories },
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
  expect(checks.map((c) => c.name)).toEqual(["gather-shape", "final-shape", "sources-from-gather", "sources-per-story", "source-spread", "dates-recent", "story-count", "word-count", "cost"]);
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
  const all = ["gather-shape", "final-shape", "sources-from-gather", "sources-per-story", "source-spread", "dates-recent", "story-count", "word-count"];
  expect(failing(goodRun({ gather: undefined, final: undefined }))).toEqual(all);
  expect(failing(goodRun({ gather: { stories: "no" }, final: [] }))).toEqual(all);
  expect(failing(goodRun({ gather: { stories: [] } }))).toEqual(["gather-shape", "sources-from-gather", "sources-per-story", "source-spread", "dates-recent"]);
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
