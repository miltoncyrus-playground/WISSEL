// The ESM wrapper over the board's src/api/public/board-news.js
// (docs/SDD-wissel-app.md §3.3): the Listen tab shapes its Quick read
// with the board's own quickReadView, so the run drawer and the app show
// the same rows, flags and details. Not a copy: vite.config.ts's
// browserScript plugin loads the file as is. Types come from its
// board-news.d.ts.

import script from "../../src/api/public/board-news.js?browser-script";
import type * as BoardNews from "../../src/api/public/board-news.js";
import type { PodcastQuickRead } from "./types";

export type { NewsExplained, NewsRow, QuickReadView } from "../../src/api/public/board-news.js";

const news = script as typeof BoardNews;

export const quickReadView = news.quickReadView;
export const NEWS_FLAG_UNCHECKED = news.NEWS_FLAG_UNCHECKED;

/** The Quick read of one GET /podcasts episode; null when the run handed
 *  off no quickRead list. */
export function episodeQuickRead(q: PodcastQuickRead | null): BoardNews.QuickReadView | null {
  if (!q) return null;
  return news.quickReadView(q.items, q.gatherSources ? new Set(q.gatherSources) : null, q.explain);
}
