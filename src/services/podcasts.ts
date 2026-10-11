import { gatherUrlSet } from "../api/public/board-news.js";
import type { FeedShow } from "./feed.ts";

/**
 * `GET /podcasts` (docs/SDD-wissel-app.md §3.3): every podcast
 * pipeline's runs with audio, newest first, for the app's Listen tab
 * and mini-player. Pure: the runs are read off the board and disk by
 * src/services/feed-sources.ts (the same cached read as the feed's
 * podcast items); this only shapes and orders them.
 *
 * `quickRead` carries the parsed handoff data the Quick read is made
 * from, not rows: the app shapes rows with board-news.js's
 * quickReadView (through app/src/news.ts), the same code as the board's
 * run drawer, so the two can't drift.
 */

/** One explained story, cut to the fields joinExplained reads. */
export interface PodcastExplainStory {
  sources: string[];
  detail?: string;
  explanation?: string;
  whyItMatters?: string;
  unknowns?: string;
}

export interface PodcastQuickRead {
  /** The script step's `quickRead` list as handed off (rows are shaped in the app). */
  items: unknown[];
  /** Every source URL the gather step handed off; null when there is no
   *  gather `stories` list to check against (rows are then "unchecked"). */
  gatherSources: string[] | null;
  /** The explain step's stories; null when there is no explain data. */
  explain: { stories: PodcastExplainStory[] } | null;
}

export interface PodcastEpisode {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  show: FeedShow;
  /** ISO time the run finished. */
  at: string;
  /** First quick-read headline, else the pipeline's name. */
  title: string;
  durationSeconds?: number;
  audioUrl: string;
  /** null when the script step handed off no quickRead list. */
  quickRead: PodcastQuickRead | null;
}

/** An episode as read by feed-sources.ts: `at` may be missing (nothing
 *  dates the run yet) and `title` may be missing (no headline). */
export interface PodcastRun extends Omit<PodcastEpisode, "at" | "title"> {
  at?: string;
  headline?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The Quick read inputs from a stored run's parsed handoff data
 *  (news-run-checks.ts loadStoredRun's `final`, `gather`, `explain`). */
export function podcastQuickRead(
  final: Record<string, unknown> | undefined,
  gather: Record<string, unknown> | undefined,
  explain: Record<string, unknown> | undefined,
): PodcastQuickRead | null {
  if (!final || !Array.isArray(final.quickRead)) return null;
  const urls = gatherUrlSet(gather);
  const stories = explain && Array.isArray(explain.stories) ? explain.stories : null;
  return {
    items: final.quickRead,
    gatherSources: urls ? [...urls] : null,
    explain: stories
      ? {
          stories: stories.filter(isRecord).map((s) => ({
            sources: Array.isArray(s.sources) ? s.sources.filter((u): u is string => typeof u === "string") : [],
            detail: text(s.detail),
            explanation: text(s.explanation),
            whyItMatters: text(s.whyItMatters),
            unknowns: text(s.unknowns),
          })),
        }
      : null,
  };
}

/** Newest first (run id breaks a tie), at most `limit` per pipeline.
 *  A run with no time yet is left out, as the feed leaves it out. */
export function buildPodcasts(runs: readonly PodcastRun[], limit: number): PodcastEpisode[] {
  const dated: PodcastEpisode[] = [];
  for (const r of runs) {
    if (!r.at || Number.isNaN(Date.parse(r.at))) continue;
    const { headline, ...rest } = r;
    dated.push({ ...rest, at: r.at, title: headline ?? r.pipelineName });
  }
  dated.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  const per = new Map<string, number>();
  const max = Math.max(1, Math.floor(limit));
  return dated.filter((e) => {
    const n = (per.get(e.pipelineId) ?? 0) + 1;
    per.set(e.pipelineId, n);
    return n <= max;
  });
}
