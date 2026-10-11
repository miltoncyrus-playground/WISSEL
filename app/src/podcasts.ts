// The Listen tab's shaping of GET /podcasts (docs/SDD-wissel-app.md
// §3.3), and what the player needs from an episode or a feed item.
// Pure.

import type { Track } from "./player";
import type { FeedItem, PodcastEpisode } from "./types";

export interface Show {
  pipelineId: string;
  pipelineName: string;
  /** Newest first; the first is the latest episode. */
  episodes: PodcastEpisode[];
}

/** Episodes by pipeline, the pipeline with the newest episode first.
 *  `episodes` comes newest first from the server, and stays so. */
export function groupByPipeline(episodes: readonly PodcastEpisode[]): Show[] {
  const shows = new Map<string, Show>();
  for (const e of episodes) {
    let s = shows.get(e.pipelineId);
    if (!s) {
      s = { pipelineId: e.pipelineId, pipelineName: e.pipelineName, episodes: [] };
      shows.set(e.pipelineId, s);
    }
    s.episodes.push(e);
  }
  return [...shows.values()];
}

export function trackOf(e: PodcastEpisode): Track {
  return {
    runId: e.runId,
    title: e.title,
    pipelineName: e.pipelineName,
    audioUrl: e.audioUrl,
    ...(e.durationSeconds !== undefined ? { durationSeconds: e.durationSeconds } : {}),
  };
}

/** A feed podcast item as a track; null for anything else. */
export function trackFromFeedItem(item: FeedItem): Track | null {
  if (item.kind !== "podcast" || !item.runId || !item.audioUrl) return null;
  return {
    runId: item.runId,
    title: item.title,
    pipelineName: item.pipelineName ?? "Podcast",
    audioUrl: item.audioUrl,
    ...(item.durationSeconds !== undefined ? { durationSeconds: item.durationSeconds } : {}),
  };
}
