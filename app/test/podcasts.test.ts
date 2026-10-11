import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { episodeQuickRead, quickReadView } from "../src/news";
import { groupByPipeline, trackFromFeedItem, trackOf } from "../src/podcasts";
import type { FeedItem, PodcastEpisode } from "../src/types";

// docs/SDD-wissel-app.md §3.3: the Listen tab's shaping, and the ESM
// wrapper over the board's board-news.js.

const ep = (runId: string, pipelineId: string, over: Partial<PodcastEpisode> = {}): PodcastEpisode => ({
  runId,
  pipelineId,
  pipelineName: pipelineId === "ai" ? "AI news podcast" : "World news podcast",
  show: pipelineId === "ai" ? "ai" : "world",
  at: "2026-10-10T06:00:00.000Z",
  title: `Episode ${runId}`,
  audioUrl: `/pipeline-runs/${runId}/audio`,
  quickRead: null,
  ...over,
});

describe("groupByPipeline", () => {
  test("pipelines in order of their newest episode; episodes keep the server's newest-first order", () => {
    const shows = groupByPipeline([ep("a3", "ai"), ep("w2", "world"), ep("a2", "ai"), ep("w1", "world"), ep("a1", "ai")]);
    expect(shows.map((s) => s.pipelineName)).toEqual(["AI news podcast", "World news podcast"]);
    expect(shows[0]!.episodes.map((e) => e.runId)).toEqual(["a3", "a2", "a1"]);
    expect(shows[1]!.episodes.map((e) => e.runId)).toEqual(["w2", "w1"]);
    expect(groupByPipeline([])).toEqual([]);
  });
});

describe("tracks", () => {
  test("from an episode", () => {
    expect(trackOf(ep("a", "ai", { durationSeconds: 300 }))).toEqual({
      runId: "a",
      title: "Episode a",
      pipelineName: "AI news podcast",
      audioUrl: "/pipeline-runs/a/audio",
      durationSeconds: 300,
    });
    expect(trackOf(ep("a", "ai"))).not.toHaveProperty("durationSeconds");
  });

  test("from a feed podcast item; anything else is not a track", () => {
    const item: FeedItem = {
      id: "podcast:r1",
      kind: "podcast",
      at: "2026-10-10T06:00:00.000Z",
      title: "Big news",
      detail: "AI news podcast · 5 min",
      links: [],
      runId: "r1",
      audioUrl: "/pipeline-runs/r1/audio",
      durationSeconds: 312,
      pipelineName: "AI news podcast",
    };
    expect(trackFromFeedItem(item)).toEqual({ runId: "r1", title: "Big news", pipelineName: "AI news podcast", audioUrl: "/pipeline-runs/r1/audio", durationSeconds: 312 });
    expect(trackFromFeedItem({ ...item, pipelineName: undefined })?.pipelineName).toBe("Podcast");
    expect(trackFromFeedItem({ ...item, kind: "checks" })).toBeNull();
    expect(trackFromFeedItem({ ...item, audioUrl: undefined })).toBeNull();
  });
});

describe("board-news.js through the ESM wrapper", () => {
  test("is the board's own file, not a copy in app/", () => {
    const wrapper = readFileSync(new URL("../src/news.ts", import.meta.url), "utf8");
    expect(wrapper).toContain('from "../../src/api/public/board-news.js?browser-script"');
    expect(wrapper).not.toMatch(/function quickReadView/);
  });

  test("shapes rows: links only for http(s), flags, joined detail", () => {
    const view = quickReadView(
      [
        { headline: " Open model ", oneLine: "Close to the best.", source: "https://lab.example.com/a" },
        { headline: "Not from gather", source: "https://other.example.com/b" },
        { headline: "Bad link", source: "javascript:alert(1)" },
      ],
      new Set(["https://lab.example.com/a"]),
      { stories: [{ sources: ["https://lab.example.com/a"], detail: "Longer story.", whyItMatters: "It is cheaper.", unknowns: "" }] },
    );
    expect(view.kind).toBe("rows");
    if (view.kind !== "rows") return;
    expect(view.rows[0]).toMatchObject({ headline: "Open model", href: "https://lab.example.com/a", flag: null, explained: { detail: "Longer story.", whyItMatters: "It is cheaper.", unknowns: "" } });
    expect(view.rows[1]).toMatchObject({ flag: "source not from the gather step", explained: null });
    expect(view.rows[2]).toMatchObject({ href: null, flag: "source is not a web link" });
    expect(view.flaggedCount).toBe(2);
  });

  test("episodeQuickRead: null data is no Quick read; no gather sources marks rows unchecked; a broken entry is raw", () => {
    expect(episodeQuickRead(null)).toBeNull();
    const unchecked = episodeQuickRead({ items: [{ headline: "H", source: "https://x.example" }], gatherSources: null, explain: null });
    expect(unchecked).toMatchObject({ kind: "rows", gatherChecked: false, rows: [{ flag: "source not checked: the gather step's output is unavailable" }] });
    expect(episodeQuickRead({ items: [{ oneLine: "no headline" }], gatherSources: [], explain: null })).toEqual({ kind: "raw", reason: "quickRead entry 1 has no headline." });
  });
});
