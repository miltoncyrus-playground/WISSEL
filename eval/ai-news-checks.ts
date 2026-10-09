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
} as const;

export interface AiNewsCheck {
  name: "run-status" | "gather-shape" | "final-shape" | "sources-from-gather" | "dates-recent" | "story-count" | "word-count" | "cost" | "sources-per-story" | "source-spread";
  pass: boolean;
  detail: string;
}

export interface AiNewsRunOutputs {
  /** The gather step's pipeline-handoff `data`. */
  gather: unknown;
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

export function checkAiNewsRun(run: AiNewsRunOutputs): AiNewsCheck[] {
  const L = AI_NEWS_LIMITS;
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

  return checks;
}
