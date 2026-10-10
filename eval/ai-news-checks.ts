/**
 * The deterministic checks eval/ai-news-podcast.eval.ts runs on one real
 * "AI news podcast" run (docs/SDD-ai-news-podcast.md §2, §5). Pure: no
 * claude, no board, no clock of its own (`now` is passed in), so
 * test/ai-news-checks.test.ts covers every check in the gate lane and
 * the paid eval only supplies real outputs.
 */

export const AI_NEWS_LIMITS = {
  maxAgeDays: 7,
  minStories: 5,
  maxStories: 8,
  minWords: 600,
  maxWords: 1000,
  maxCostUsd: 1.5,
  /** Most stories whose lead source (sources[0]) may share one site.
   *  A lab can legitimately announce two or three things in a week; six
   *  stories from one site means a roundup was cited instead of the
   *  originals (the first live run, 2026-10-07: aiweekly.co, 6 of 8). */
  maxStoriesPerSite: 3,
  /** Spoken pace the audio's length must fit, in words per minute
   *  (§3.7). Kokoro measured 829 words in 303 s, about 164 wpm. Outside
   *  90 to 240 the audio is cut short or isn't the script. */
  minWordsPerMinute: 90,
  maxWordsPerMinute: 240,
  /** §3.9 outcome 1: share of the gather step's numbers and names that
   *  the explain step carries over, across the whole run. */
  minNumbersRetained: 0.9,
  minNamesRetained: 0.8,
  /** §3.9 outcome 2: every explained story's `detail` has at least this
   *  many words (world: 50) and its `summary` at most 30. */
  minDetailWords: 60,
  maxSummaryWords: 30,
} as const;

export interface AiNewsCheck {
  name:
    | "run-status"
    | "gather-shape"
    | "final-shape"
    | "sources-from-gather"
    | "dates-recent"
    | "story-count"
    | "word-count"
    | "cost"
    | "sources-per-story"
    | "source-spread"
    | "audio"
    | "regions"
    | "groups"
    | "evidence"
    | "explain-shape"
    | "facts-retained"
    | "depth";
  pass: boolean;
  detail: string;
}

export interface AiNewsRunOutputs {
  /** The gather step's pipeline-handoff `data`. */
  gather: unknown;
  /** The explain step's pipeline-handoff `data` (§3.9). */
  explain: unknown;
  /** The script step's pipeline-handoff `data`. */
  final: unknown;
  /** Sum of telemetry `result` events' actualCost for the run's step
   *  tasks; undefined when none reported a cost. */
  costUsd: number | undefined;
  now: Date;
}

interface GatherStory {
  title: unknown;
  date: unknown;
  sources: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function gatherStories(gather: unknown): GatherStory[] | null {
  if (!isRecord(gather) || !Array.isArray(gather.stories)) return null;
  return gather.stories.filter(isRecord) as unknown as GatherStory[];
}

/** Hostname without a leading "www.", or null for a non-URL. */
export function siteOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Every URL the gather step handed off, across all its stories. */
export function gatherSourceSet(gather: unknown): Set<string> {
  const out = new Set<string>();
  for (const story of gatherStories(gather) ?? []) {
    if (!Array.isArray(story.sources)) continue;
    for (const url of story.sources) if (typeof url === "string") out.add(url);
  }
  return out;
}

/** Words as a listener hears them: whitespace-separated tokens. The
 *  model's own `wordCount` is not trusted. */
export function countWords(text: string): number {
  const words = text.trim().split(/\s+/);
  return words[0] === "" ? 0 : words.length;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between `now`'s UTC calendar day and a YYYY-MM-DD date (positive
 *  means the date is in the past); null for anything that isn't a real
 *  YYYY-MM-DD date. */
export function ageInDays(date: unknown, now: Date): number | null {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const then = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(then) || new Date(then).toISOString().slice(0, 10) !== date) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((today - then) / DAY_MS);
}

export type NewsLimits = { [K in keyof typeof AI_NEWS_LIMITS]: number };

/** The world headlines pipeline: same checks, shorter windows. World
 *  stories must be at most 2 days old; Spain and Netherlands stories at
 *  most 4 (Milton, 2026-10-10: a big national story such as an election
 *  call stays the main national news for days). `maxAgeDays` is the
 *  loosest window; checkWorldNewsRun applies the per-region ones. */
export const WORLD_NEWS_LIMITS: NewsLimits = { ...AI_NEWS_LIMITS, maxAgeDays: 4, minDetailWords: 50 };
export const WORLD_NEWS_REGION_MAX_AGE_DAYS: Record<string, number> = { world: 2, spain: 4, netherlands: 4 };

/** Regions every world run must cover (Milton, 2026-10-09: generic world
 *  headlines plus Spain and the Netherlands). */
export const WORLD_NEWS_REGIONS = ["world", "spain", "netherlands"] as const;

/** checkAiNewsRun with WORLD_NEWS_LIMITS, plus a `regions` check: every
 *  gathered story has a known region and each region has a story. */
export function checkWorldNewsRun(run: AiNewsRunOutputs): AiNewsCheck[] {
  const checks = checkAiNewsRun(run, WORLD_NEWS_LIMITS);
  const stories = gatherStories(run.gather) ?? [];
  const regionOf = (st: unknown) => (isRecord(st) ? st.region : undefined);
  // Per-region date windows replace the generic dates-recent result.
  const tooOld = stories.filter((st) => {
    const age = ageInDays(st.date, run.now);
    const max = WORLD_NEWS_REGION_MAX_AGE_DAYS[String(regionOf(st))] ?? WORLD_NEWS_LIMITS.maxAgeDays;
    return age === null || age > max || age < -1;
  });
  const di = checks.findIndex((c) => c.name === "dates-recent");
  checks[di] = {
    name: "dates-recent",
    pass: stories.length > 0 && tooOld.length === 0,
    detail:
      tooOld.length === 0
        ? "every story within its region's window (world 2 days, spain and netherlands 4)"
        : `out of range or missing: ${tooOld.map((st) => `${JSON.stringify(st.title)} (${String(regionOf(st))}, ${JSON.stringify(st.date)})`).join(", ")}`,
  };
  const unknown = stories.filter((st) => !(WORLD_NEWS_REGIONS as readonly unknown[]).includes(regionOf(st)));
  const missing = WORLD_NEWS_REGIONS.filter((r) => !stories.some((st) => regionOf(st) === r));
  checks.push({
    name: "regions",
    pass: stories.length > 0 && unknown.length === 0 && missing.length === 0,
    detail:
      unknown.length > 0
        ? `stories with no or unknown region: ${unknown.map((st) => JSON.stringify(st.title)).join(", ")}`
        : missing.length > 0
          ? `no story for: ${missing.join(", ")}`
          : WORLD_NEWS_REGIONS.map((r) => `${r} ${stories.filter((st) => regionOf(st) === r).length}`).join(", "),
  });
  return checks;
}

export function checkAiNewsRun(run: AiNewsRunOutputs, limits: NewsLimits = AI_NEWS_LIMITS): AiNewsCheck[] {
  const L = limits;
  const checks: AiNewsCheck[] = [];
  const stories = gatherStories(run.gather);
  checks.push({
    name: "gather-shape",
    pass: stories !== null && stories.length > 0,
    detail: stories === null ? "gather data has no stories array" : `${stories.length} gathered stories`,
  });

  const final = isRecord(run.final) ? run.final : null;
  const quickRead = final && Array.isArray(final.quickRead) ? final.quickRead : null;
  const script = final && typeof final.script === "string" ? final.script : null;
  checks.push({
    name: "final-shape",
    pass: quickRead !== null && script !== null,
    detail: final === null ? "final data missing" : `quickRead ${quickRead ? "ok" : "missing"}, script ${script !== null ? "ok" : "missing"}`,
  });

  const sources = gatherSourceSet(run.gather);
  const strays = (quickRead ?? []).map((row) => (isRecord(row) ? row.source : undefined)).filter((s) => typeof s !== "string" || !sources.has(s));
  checks.push({
    name: "sources-from-gather",
    pass: quickRead !== null && quickRead.length > 0 && strays.length === 0,
    detail: strays.length === 0 ? `${quickRead?.length ?? 0} quick-read sources all in the gather set (${sources.size} URLs)` : `not in the gather set: ${strays.map((s) => JSON.stringify(s)).join(", ")}`,
  });

  // Each story cites its own page: a URL shared by two stories is a
  // roundup or digest page, not the story's source.
  const urlStories = new Map<string, number>();
  for (const st of stories ?? []) {
    for (const u of new Set(Array.isArray(st.sources) ? st.sources.filter((x): x is string => typeof x === "string") : [])) {
      urlStories.set(u, (urlStories.get(u) ?? 0) + 1);
    }
  }
  const shared = [...urlStories].filter(([, n]) => n > 1);
  checks.push({
    name: "sources-per-story",
    pass: stories !== null && stories.length > 0 && shared.length === 0,
    detail: shared.length === 0 ? "no source URL is shared between stories" : `shared by several stories: ${shared.map(([u, n]) => `${u} (${n})`).join(", ")}`,
  });

  const bySite = new Map<string, number>();
  for (const st of stories ?? []) {
    const site = siteOf(Array.isArray(st.sources) ? st.sources[0] : undefined);
    if (site) bySite.set(site, (bySite.get(site) ?? 0) + 1);
  }
  const crowded = [...bySite].filter(([, n]) => n > L.maxStoriesPerSite);
  checks.push({
    name: "source-spread",
    pass: stories !== null && stories.length > 0 && crowded.length === 0,
    detail: crowded.length === 0 ? `lead sources from ${bySite.size} sites, none over ${L.maxStoriesPerSite} stories` : `too many stories from one site: ${crowded.map(([d, n]) => `${d} (${n})`).join(", ")}`,
  });

  // A day of slack into the future covers a source in a timezone ahead of UTC.
  const badDates = (stories ?? []).filter((s) => {
    const age = ageInDays(s.date, run.now);
    return age === null || age > L.maxAgeDays || age < -1;
  });
  checks.push({
    name: "dates-recent",
    pass: stories !== null && stories.length > 0 && badDates.length === 0,
    detail: badDates.length === 0 ? `every story dated within ${L.maxAgeDays} days` : `out of range or missing: ${badDates.map((s) => `${JSON.stringify(s.title)} (${JSON.stringify(s.date)})`).join(", ")}`,
  });

  const count = quickRead?.length ?? 0;
  checks.push({
    name: "story-count",
    pass: count >= L.minStories && count <= L.maxStories,
    detail: `${count} stories (want ${L.minStories} to ${L.maxStories})`,
  });

  const words = script === null ? 0 : countWords(script);
  checks.push({
    name: "word-count",
    pass: words >= L.minWords && words <= L.maxWords,
    detail: `${words} words (want ${L.minWords} to ${L.maxWords}; model said ${JSON.stringify(final?.wordCount)})`,
  });

  checks.push({
    name: "cost",
    pass: run.costUsd !== undefined && run.costUsd < L.maxCostUsd,
    detail: run.costUsd === undefined ? "no cost reported in telemetry" : `$${run.costUsd.toFixed(4)} (limit $${L.maxCostUsd.toFixed(2)})`,
  });

  checks.push(...checkExplain(stories, run.explain, L));
  return checks;
}

// ---- §3.9 explain step: shape, facts retained, depth ----------------------

// A number with its currency, scale and percent: "$1.5 billion", "20%",
// "1,200". Not glued to a letter or digit on either side, so "70B" and
// "H100" are names, not numbers. Alternatives in order: comma thousands
// (1,200 / 1,200.5), dot thousands with two or more groups (1.200.000,
// as Spanish and Dutch sources write it), plain or decimal (3.5).
const NUMBER_RE =
  /(?<![\p{L}\p{N}_.,])([$€£]\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?:\.\d{3}){2,}|\d+(?:\.\d+)?)(?:\s?(million|billion|trillion|bn)\b)?(?:\s?(%|percent\b|per cent\b))?(?![\p{L}\p{N}])/giu;

/** Every number in `text`, normalised so the same quantity written two
 *  ways compares equal: thousands separators dropped ("1,200" and
 *  "1200"), trailing decimal zeros dropped ("1.50" and "1.5"), "percent"
 *  as "%", "bn" as "billion", currency symbol and scale word kept with
 *  the number ("$2 billion" is not "2"). */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [, currency, digits, scale, pct] = m;
    const plain = /^\d{1,3}(?:\.\d{3}){2,}$/.test(digits!) ? digits!.replace(/\./g, "") : digits!.replace(/,/g, "");
    const scaleWord = scale ? ` ${scale.toLowerCase() === "bn" ? "billion" : scale.toLowerCase()}` : "";
    out.push(`${currency ? currency.trim() : ""}${String(Number(plain))}${scaleWord}${pct ? "%" : ""}`);
  }
  return out;
}

// Capitalised words that are dates, not names: a story's day of the
// week rarely survives a rewrite and isn't what "names retained" means.
const NOT_NAMES = new Set(
  "I Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September October November December"
    .toLowerCase()
    .split(" "),
);

/** A token stripped of surrounding punctuation and a trailing "'s". */
function bareToken(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’]s$/u, "");
}

/** Names in `text`: runs of capitalised words not at a sentence start
 *  ("Pedro Sánchez", "European Commission"; the run's first word is
 *  dropped when it opens a sentence or a quote), plus any token with an
 *  inner capital or a digit next to a letter ("OpenAI", "GPT-5", "H100",
 *  "NATO"), wherever it is. A run ends at a token with punctuation after
 *  it ("Spain, France" is two names). Deduplicated, first seen first. */
export function extractNames(text: string): string[] {
  const out: string[] = [];
  const add = (name: string) => {
    if (name && !NOT_NAMES.has(name.toLowerCase()) && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  };
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    let run: string[] = [];
    const flush = () => {
      if (run.length > 0) add(run.join(" "));
      run = [];
    };
    sentence.split(/\s+/).forEach((raw, i) => {
      const word = bareToken(raw);
      if (!word) return flush();
      // "2.5bn", "40m", "10k" are amounts, not names.
      const special = /\p{L}/u.test(word) && (/^.+\p{Lu}/u.test(word) || /\d/.test(word)) && !/^\d[\d.,]*(?:bn|mn|m|k)$/i.test(word);
      if (special) add(word);
      const opensSentence = i === 0 || /^["“'‘(]/.test(raw);
      if (/^\p{Lu}/u.test(word) && !NOT_NAMES.has(word.toLowerCase())) {
        if (opensSentence) flush();
        else run.push(word);
      } else {
        flush();
      }
      // "Spain, France": punctuation after a word ends its run.
      if (/[^\p{L}\p{N}'’]$/u.test(raw.replace(/['’]s$/u, ""))) flush();
    });
    flush();
  }
  return out;
}

const EXPLAIN_TEXT_FIELDS = ["summary", "detail", "whyItMatters", "unknowns"] as const;

/** An explained story's text the checks search: summary, detail, why it
 *  matters and unknowns. */
function explainedText(story: Record<string, unknown> | undefined): string {
  if (!story) return "";
  return EXPLAIN_TEXT_FIELDS.map((k) => (typeof story[k] === "string" ? story[k] : "")).join("\n");
}

/** `phrase` as whole words in `haystack`, case-insensitive. */
function containsWords(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(haystack);
}

/** A name is retained when it appears as written, or, for a run of
 *  several words, when every word of it does: "OpenAI CEO Sam Altman"
 *  rewritten as "Sam Altman, OpenAI's CEO" keeps the name. */
export function nameRetained(text: string, name: string): boolean {
  return containsWords(text, name) || (name.includes(" ") && name.split(" ").every((w) => containsWords(text, w)));
}

function pct(n: number, of: number): string {
  return of === 0 ? "none to keep" : `${n}/${of} (${Math.round((n / of) * 100)}%)`;
}

/** §3.9 explain-shape, facts-retained and depth, pairing the explain
 *  step's stories with the gather step's by position (explain-shape
 *  proves the positions line up). */
function checkExplain(gathered: GatherStory[] | null, explain: unknown, L: NewsLimits): AiNewsCheck[] {
  const explained = isRecord(explain) && Array.isArray(explain.stories) ? explain.stories : null;
  const gather = (gathered ?? []) as unknown as Record<string, unknown>[];
  const checks: AiNewsCheck[] = [];

  // explain-shape: same count, same titles in the same order, sources unchanged.
  const shapeProblems: string[] = [];
  if (explained !== null) {
    if (explained.length !== gather.length) shapeProblems.push(`${explained.length} explained stories for ${gather.length} gathered`);
    gather.forEach((g, i) => {
      const e = explained[i];
      if (!isRecord(e)) return void (i < explained.length && shapeProblems.push(`story ${i + 1} is not an object`));
      if (e.title !== g.title) shapeProblems.push(`story ${i + 1} is ${JSON.stringify(e.title)}, gather has ${JSON.stringify(g.title)}`);
      if (!Bun.deepEquals(e.sources, g.sources)) shapeProblems.push(`story ${i + 1} ${JSON.stringify(g.title)} sources changed`);
    });
  }
  checks.push({
    name: "explain-shape",
    pass: explained !== null && gather.length > 0 && shapeProblems.length === 0,
    detail: explained === null ? "explain data has no stories array" : shapeProblems.length === 0 ? `${explained.length} stories, same order and sources as gather` : shapeProblems.join("; "),
  });

  // facts-retained: each gather story's numbers and names, looked for in
  // the explained story at the same position.
  let numbers = 0;
  let numbersKept = 0;
  let names = 0;
  let namesKept = 0;
  const missing: string[] = [];
  gather.forEach((g, i) => {
    const facts = typeof g.facts === "string" ? g.facts : "";
    const e = explained?.[i];
    const text = explainedText(isRecord(e) ? e : undefined);
    const have = new Set(extractNumbers(text));
    const wantNumbers = [...new Set(extractNumbers(facts))];
    const lostNumbers = wantNumbers.filter((n) => !have.has(n));
    const wantNames = extractNames(facts);
    const lostNames = wantNames.filter((n) => !nameRetained(text, n));
    numbers += wantNumbers.length;
    numbersKept += wantNumbers.length - lostNumbers.length;
    names += wantNames.length;
    namesKept += wantNames.length - lostNames.length;
    if (lostNumbers.length + lostNames.length > 0) {
      missing.push(`${JSON.stringify(g.title)} lost ${[...lostNumbers, ...lostNames].map((x) => JSON.stringify(x)).join(", ")}`);
    }
  });
  const numbersOk = numbers === 0 || numbersKept / numbers >= L.minNumbersRetained;
  const namesOk = names === 0 || namesKept / names >= L.minNamesRetained;
  checks.push({
    name: "facts-retained",
    pass: explained !== null && gather.length > 0 && numbersOk && namesOk,
    detail:
      explained === null
        ? "explain data has no stories array"
        : `numbers ${pct(numbersKept, numbers)} (want ${Math.round(L.minNumbersRetained * 100)}%), names ${pct(namesKept, names)} (want ${Math.round(L.minNamesRetained * 100)}%)` +
          (missing.length > 0 ? `; ${missing.join("; ")}` : ""),
  });

  // depth: a summary of at most maxSummaryWords, a detail of at least minDetailWords.
  const shallow: string[] = [];
  (explained ?? []).forEach((e, i) => {
    const title = isRecord(e) ? JSON.stringify(e.title) : `story ${i + 1}`;
    const summary = isRecord(e) && typeof e.summary === "string" ? e.summary : "";
    const detail = isRecord(e) && typeof e.detail === "string" ? e.detail : "";
    const sw = countWords(summary);
    const dw = countWords(detail);
    if (sw === 0) shallow.push(`${title} has no summary`);
    else if (sw > L.maxSummaryWords) shallow.push(`${title} summary is ${sw} words`);
    if (dw < L.minDetailWords) shallow.push(`${title} detail is ${dw} words`);
  });
  checks.push({
    name: "depth",
    pass: explained !== null && explained.length > 0 && shallow.length === 0,
    detail:
      explained === null
        ? "explain data has no stories array"
        : shallow.length === 0
          ? `every summary 1 to ${L.maxSummaryWords} words, every detail at least ${L.minDetailWords}`
          : `${shallow.join("; ")} (want summary 1 to ${L.maxSummaryWords} words, detail at least ${L.minDetailWords})`,
  });
  return checks;
}

/** The Wissel retrospective podcast (docs/SDD-wissel-retro-podcast.md
 *  §2, §3.4): same script length as the news, a cheaper run (no web
 *  search; collect and audio cost nothing). */
export const RETRO_LIMITS = { minStories: 1, minWords: 600, maxWords: 1000, maxCostUsd: 1.0 } as const;

/** The analyst's groups, in the order the script speaks them. */
export const RETRO_GROUPS = ["done", "learnings", "improve", "ideas"] as const;

export interface RetroRunOutputs {
  /** The collect step's pipeline-handoff `data` (the digest). */
  gather: unknown;
  /** The analyse step's pipeline-handoff `data` ({stories: [{group, ...}]}). */
  analysis: unknown;
  /** The script step's pipeline-handoff `data`. */
  final: unknown;
  costUsd: number | undefined;
}

/** §3.4: gather-shape (at least one story), final-shape,
 *  sources-from-gather, groups, evidence, word-count and cost. No
 *  dates-recent, sources-per-story or source-spread: the digest's dates
 *  are the board's own and several ideas may rest on one commit. A quick
 *  read row with no source is allowed (an idea, or a card with no merge
 *  commit); any source it does give must be one the collect step
 *  produced. */
export function checkRetroRun(run: RetroRunOutputs): AiNewsCheck[] {
  const L = RETRO_LIMITS;
  const checks: AiNewsCheck[] = [];
  const stories = gatherStories(run.gather);
  checks.push({
    name: "gather-shape",
    pass: stories !== null && stories.length >= L.minStories,
    detail: stories === null ? "digest has no stories array" : `${stories.length} digest stories`,
  });

  const final = isRecord(run.final) ? run.final : null;
  const quickRead = final && Array.isArray(final.quickRead) ? final.quickRead : null;
  const script = final && typeof final.script === "string" ? final.script : null;
  checks.push({
    name: "final-shape",
    pass: quickRead !== null && script !== null,
    detail: final === null ? "final data missing" : `quickRead ${quickRead ? "ok" : "missing"}, script ${script !== null ? "ok" : "missing"}`,
  });

  const sources = gatherSourceSet(run.gather);
  const given = (quickRead ?? []).map((row) => (isRecord(row) ? row.source : undefined)).filter((s) => s !== undefined && s !== "");
  const strays = given.filter((s) => typeof s !== "string" || !sources.has(s));
  checks.push({
    name: "sources-from-gather",
    pass: quickRead !== null && quickRead.length > 0 && strays.length === 0,
    detail:
      strays.length === 0
        ? `${given.length} of ${quickRead?.length ?? 0} quick-read rows linked, all in the digest (${sources.size} URLs)`
        : `not in the digest: ${strays.map((s) => JSON.stringify(s)).join(", ")}`,
  });

  const items = isRecord(run.analysis) && Array.isArray(run.analysis.stories) ? run.analysis.stories.filter(isRecord) : null;
  const groupOf = (it: Record<string, unknown>) => it.group;
  const unknownGroup = (items ?? []).filter((it) => !(RETRO_GROUPS as readonly unknown[]).includes(groupOf(it)));
  const missing = RETRO_GROUPS.filter((g) => !(items ?? []).some((it) => groupOf(it) === g));
  checks.push({
    name: "groups",
    pass: items !== null && unknownGroup.length === 0 && missing.length === 0,
    detail:
      items === null
        ? "analysis data has no stories array"
        : unknownGroup.length > 0
          ? `items with no or unknown group: ${unknownGroup.map((it) => JSON.stringify(it.title)).join(", ")}`
          : missing.length > 0
            ? `no item for: ${missing.join(", ")}`
            : RETRO_GROUPS.map((g) => `${g} ${(items ?? []).filter((it) => groupOf(it) === g).length}`).join(", "),
  });

  // Every analysis source is a digest URL, and learnings and improve rest
  // on at least one.
  const problems: string[] = [];
  for (const it of items ?? []) {
    const srcs = Array.isArray(it.sources) ? it.sources : [];
    const bad = srcs.filter((s) => typeof s !== "string" || !sources.has(s));
    if (bad.length > 0) problems.push(`${JSON.stringify(it.title)} cites ${bad.map((s) => JSON.stringify(s)).join(", ")}, not in the digest`);
    if ((it.group === "learnings" || it.group === "improve") && srcs.length === 0) problems.push(`${it.group} item ${JSON.stringify(it.title)} has no source`);
  }
  checks.push({
    name: "evidence",
    pass: items !== null && items.length > 0 && problems.length === 0,
    detail: items === null ? "analysis data has no stories array" : problems.length === 0 ? "every learnings and improve item cites a digest source; no source outside the digest" : problems.join("; "),
  });

  const words = script === null ? 0 : countWords(script);
  checks.push({
    name: "word-count",
    pass: words >= L.minWords && words <= L.maxWords,
    detail: `${words} words (want ${L.minWords} to ${L.maxWords}; model said ${JSON.stringify(final?.wordCount)})`,
  });

  checks.push({
    name: "cost",
    pass: run.costUsd !== undefined && run.costUsd < L.maxCostUsd,
    detail: run.costUsd === undefined ? "no cost reported in telemetry" : `$${run.costUsd.toFixed(4)} (limit $${L.maxCostUsd.toFixed(2)})`,
  });
  return checks;
}

const MP3_KBPS_V1_L3 =[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_KBPS_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The first MPEG Layer III frame header's bitrate and sample rate,
 *  after an ID3v2 tag if there is one; null when the bytes aren't an
 *  MP3. Enough to tell an MP3 from an error page and to estimate its
 *  length (CBR: bytes * 8 / bitrate). */
export function mp3Info(bytes: Uint8Array): { kbps: number; sampleRate: number; offset: number } | null {
  let i = 0;
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // ID3v2: 10-byte header, size as four 7-bit bytes.
    i = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  }
  if (i + 4 > bytes.length || bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[i + 1]! >> 3) & 0x3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const layer = (bytes[i + 1]! >> 1) & 0x3; // 1 = Layer III
  const bitrateIndex = bytes[i + 2]! >> 4;
  const rateIndex = (bytes[i + 2]! >> 2) & 0x3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = (version === 3 ? MP3_KBPS_V1_L3 : MP3_KBPS_V2_L3)[bitrateIndex]!;
  return { kbps, sampleRate: MP3_RATES[version]![rateIndex]!, offset: i };
}

export interface AiNewsAudioOutputs {
  /** The audio step's pipeline-handoff `data` (TtsExecutor). */
  audio: unknown;
  /** The MP3 the step wrote, read back from disk; null when missing. */
  file: Uint8Array | null;
  /** Words in the script that was spoken (countWords). */
  words: number;
}

/** §3.7: the audio step handed off {file, voice, bytes,
 *  synthesisSeconds}, the file on disk is that many bytes of real MP3,
 *  and its length fits the script at a speaking pace. */
export function checkAudio(run: AiNewsAudioOutputs): AiNewsCheck {
  const L = AI_NEWS_LIMITS;
  const a = isRecord(run.audio) && isRecord(run.audio.audio) ? run.audio.audio : null;
  const fail = (detail: string): AiNewsCheck => ({ name: "audio", pass: false, detail });
  if (!a || typeof a.file !== "string" || typeof a.bytes !== "number" || typeof a.synthesisSeconds !== "number" || typeof a.voice !== "string") {
    return fail(`audio step handed off no {file, voice, bytes, synthesisSeconds}: ${JSON.stringify(run.audio)}`);
  }
  if (!run.file) return fail(`no file at ${a.file}`);
  if (run.file.byteLength !== a.bytes) return fail(`file is ${run.file.byteLength} bytes, handoff says ${a.bytes}`);
  const info = mp3Info(run.file);
  if (!info) return fail("file doesn't start with an MP3 frame");
  const seconds = ((run.file.byteLength - info.offset) * 8) / (info.kbps * 1000);
  const wpm = seconds > 0 ? (run.words / seconds) * 60 : Infinity;
  const pass = wpm >= L.minWordsPerMinute && wpm <= L.maxWordsPerMinute;
  return {
    name: "audio",
    pass,
    detail: `${a.bytes} bytes, ${info.kbps} kbps ${info.sampleRate} Hz, about ${Math.round(seconds)} s for ${run.words} words (${Math.round(wpm)} wpm, want ${L.minWordsPerMinute} to ${L.maxWordsPerMinute}); synthesis ${a.synthesisSeconds} s, voice ${a.voice}`,
  };
}
