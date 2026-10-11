import { describe, expect, test } from "vitest";
import { groupStories, isUnseen, markSeen, step, STORY_GROUPS, STORY_WINDOW_MS, storyOf, type Story } from "../src/stories";
import type { FeedItem } from "../src/types";

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function item(id: string, over: Partial<FeedItem>): FeedItem {
  return { id, kind: "landed", at: hoursAgo(1), title: id, detail: "", links: [], ...over };
}

describe("storyOf", () => {
  test("each kind lands in its ring; podcasts by show", () => {
    expect(storyOf({ kind: "needs-you" })).toBe("needs-you");
    expect(storyOf({ kind: "landed" })).toBe("landed");
    expect(storyOf({ kind: "spend" })).toBe("week");
    expect(storyOf({ kind: "podcast", show: "ai" })).toBe("ai");
    expect(storyOf({ kind: "checks", show: "ai" })).toBe("ai");
    expect(storyOf({ kind: "podcast", show: "world" })).toBe("world");
    expect(storyOf({ kind: "podcast", show: "retro" })).toBe("week");
    expect(storyOf({ kind: "podcast", show: "other" })).toBe("week");
  });
});

describe("groupStories", () => {
  test("the last 24 h only, in ring order, each story oldest first", () => {
    const items = [
      item("l-new", { at: hoursAgo(1) }),
      item("n", { kind: "needs-you", at: hoursAgo(2) }),
      item("l-old", { at: hoursAgo(5) }),
      item("ai", { kind: "podcast", show: "ai", at: hoursAgo(6) }),
      item("ai-c", { kind: "checks", show: "ai", at: hoursAgo(6) }),
      item("stale", { at: hoursAgo(25) }),
      item("spend", { kind: "spend", at: hoursAgo(12) }),
    ];
    const stories = groupStories(items, NOW);
    expect(stories.map((s) => s.id)).toEqual(["ai", "needs-you", "landed", "week"]);
    expect(stories.find((s) => s.id === "landed")!.items.map((i) => i.id)).toEqual(["l-old", "l-new"]);
    expect(stories.find((s) => s.id === "ai")!.items.map((i) => i.id)).toEqual(["ai", "ai-c"]);
    expect(stories.find((s) => s.id === "landed")!.latestAt).toBe(Date.parse(hoursAgo(1)));
    expect(stories.flatMap((s) => s.items).some((i) => i.id === "stale")).toBe(false);
  });

  test("the window edge is inclusive; junk times are skipped; no items, no stories", () => {
    expect(groupStories([item("edge", { at: new Date(NOW - STORY_WINDOW_MS).toISOString() })], NOW)).toHaveLength(1);
    expect(groupStories([item("bad", { at: "nope" })], NOW)).toEqual([]);
    expect(groupStories([], NOW)).toEqual([]);
  });

  test("the five groups the SDD names", () => {
    expect(STORY_GROUPS.map((g) => g.label)).toEqual(["AI news", "World", "Needs you", "Landed", "Your week"]);
  });
});

describe("seen", () => {
  const story = (id: Story["id"], latestAt: number): Story => ({ id, label: id, items: [], latestAt });

  test("a story is new until watched, and new again when something newer arrives", () => {
    const s = story("landed", 100);
    expect(isUnseen(s, {})).toBe(true);
    const seen = markSeen({}, s);
    expect(isUnseen(s, seen)).toBe(false);
    expect(isUnseen(story("landed", 200), seen)).toBe(true);
    // Watching an older copy never moves the mark back.
    expect(markSeen({ landed: 300 }, s).landed).toBe(300);
  });
});

describe("step", () => {
  const stories: Story[] = [
    { id: "ai", label: "AI news", items: [item("a1", {}), item("a2", {})], latestAt: 0 },
    { id: "landed", label: "Landed", items: [item("l1", {})], latestAt: 0 },
  ];

  test("next walks items, then the next story, then ends", () => {
    expect(step(stories, { story: 0, item: 0 }, 1)).toEqual({ story: 0, item: 1 });
    expect(step(stories, { story: 0, item: 1 }, 1)).toEqual({ story: 1, item: 0 });
    expect(step(stories, { story: 1, item: 0 }, 1)).toBeNull();
  });

  test("previous walks back into the last item of the story before", () => {
    expect(step(stories, { story: 1, item: 0 }, -1)).toEqual({ story: 0, item: 1 });
    expect(step(stories, { story: 0, item: 0 }, -1)).toBeNull();
  });

  test("an index past the end is null, not a crash", () => {
    expect(step(stories, { story: 9, item: 0 }, 1)).toBeNull();
  });
});
