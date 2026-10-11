// Stories (docs/SDD-wissel-app.md §3.2): the feed's last 24 hours
// grouped by kind into rings at the top of the Feed screen. Tapping a
// ring plays its items full screen. Pure: FeedScreen and StoryViewer
// draw what these return; the seen map lives in localStorage (seen.ts).

import type { FeedItem } from "./types";

export type StoryId = "ai" | "world" | "needs-you" | "landed" | "week";

/** Left to right in the rings row. */
export const STORY_GROUPS: readonly { id: StoryId; label: string }[] = [
  { id: "ai", label: "AI news" },
  { id: "world", label: "World" },
  { id: "needs-you", label: "Needs you" },
  { id: "landed", label: "Landed" },
  { id: "week", label: "Your week" },
];

export const STORY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface Story {
  id: StoryId;
  label: string;
  /** Oldest first: the order the viewer plays them. */
  items: FeedItem[];
  /** The newest item's time (ms). */
  latestAt: number;
}

/** Which ring an item belongs to. Podcasts and their checks go by show;
 *  the weekly retro, other podcasts and daily spend are "Your week". */
export function storyOf(item: Pick<FeedItem, "kind" | "show">): StoryId {
  switch (item.kind) {
    case "needs-you":
      return "needs-you";
    case "landed":
      return "landed";
    case "spend":
      return "week";
    default:
      return item.show === "ai" ? "ai" : item.show === "world" ? "world" : "week";
  }
}

/** The non-empty stories for items in the 24 hours up to `now`, in
 *  STORY_GROUPS order. */
export function groupStories(items: readonly FeedItem[], now: number): Story[] {
  const since = now - STORY_WINDOW_MS;
  const groups = new Map<StoryId, FeedItem[]>();
  for (const item of items) {
    const at = Date.parse(item.at);
    if (Number.isNaN(at) || at < since || at > now + 60_000) continue;
    const id = storyOf(item);
    const list = groups.get(id) ?? [];
    list.push(item);
    groups.set(id, list);
  }
  const out: Story[] = [];
  for (const g of STORY_GROUPS) {
    const list = groups.get(g.id);
    if (!list) continue;
    const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.push({ id: g.id, label: g.label, items: sorted, latestAt: Date.parse(sorted[sorted.length - 1]!.at) });
  }
  return out;
}

/** Story id to the newest item time (ms) already watched. */
export type SeenMap = Partial<Record<StoryId, number>>;

/** True when the story has something newer than what was watched. */
export function isUnseen(story: Story, seen: SeenMap): boolean {
  return story.latestAt > (seen[story.id] ?? -Infinity);
}

export function markSeen(seen: SeenMap, story: Story): SeenMap {
  return { ...seen, [story.id]: Math.max(seen[story.id] ?? -Infinity, story.latestAt) };
}

/** Where the viewer goes from (story, item) on Next or Previous: the
 *  next item, the next story's first, or null past either end. */
export function step(stories: readonly Story[], at: { story: number; item: number }, dir: 1 | -1): { story: number; item: number } | null {
  const s = stories[at.story];
  if (!s) return null;
  const item = at.item + dir;
  if (item >= 0 && item < s.items.length) return { story: at.story, item };
  const story = at.story + dir;
  const next = stories[story];
  if (!next) return null;
  return { story, item: dir === 1 ? 0 : next.items.length - 1 };
}
