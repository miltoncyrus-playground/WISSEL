import { afterEach, describe, expect, test, vi } from "vitest";
import { fetchFeed, postAction } from "../src/api";
import { KIND_LABEL, toneOf, whenText } from "../src/components/FeedEntry";
import { loadSeen, saveSeen } from "../src/seen";
import { timeAgo } from "../src/time";
import { FEED_KINDS } from "../src/types";

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("timeAgo", () => {
  test("short, plain, no em dashes", () => {
    expect(timeAgo(ago(10_000), NOW)).toBe("just now");
    expect(timeAgo(ago(-30_000), NOW)).toBe("just now"); // a clock a little ahead
    expect(timeAgo(ago(5 * 60_000), NOW)).toBe("5 min ago");
    expect(timeAgo(ago(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(timeAgo(new Date(2026, 9, 9, 18, 0).toISOString(), NOW)).toBe("yesterday");
    expect(timeAgo(new Date(2026, 9, 6, 9, 0).toISOString(), NOW)).toBe("4 days ago");
    expect(timeAgo(new Date(2026, 8, 1, 9, 0).toISOString(), NOW)).toBe("1 Sep");
    expect(timeAgo(new Date(2025, 8, 1, 9, 0).toISOString(), NOW)).toBe("1 Sep 2025");
    expect(timeAgo("garbage", NOW)).toBe("");
  });
});

describe("feed items", () => {
  test("every kind has a label and a tone", () => {
    for (const kind of FEED_KINDS) {
      expect(KIND_LABEL[kind]).toBeTruthy();
      expect(toneOf({ kind, pass: true })).toMatch(/^tone-/);
    }
    expect(toneOf({ kind: "checks", pass: false })).toBe("tone-alert");
    expect(toneOf({ kind: "checks", pass: true })).toBe("tone-ok");
  });

  test("an undated needs-you item reads Waiting, not a time", () => {
    expect(whenText({ at: ago(0), undated: true }, NOW)).toBe("Waiting");
    expect(whenText({ at: ago(5 * 60_000) }, NOW)).toBe("5 min ago");
    // A needs-you item sits at now but reads as how long it has waited.
    expect(whenText({ at: ago(0), since: ago(5 * 60_000) }, NOW)).toBe("5 min ago");
  });
});

describe("seen storage", () => {
  test("round-trips, drops junk, and survives a broken storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSeen({ landed: 5, ai: 7 }, storage);
    expect(loadSeen(storage)).toEqual({ landed: 5, ai: 7 });
    store.set("wissel.app.storiesSeen", JSON.stringify({ landed: "x", ai: 3 }));
    expect(loadSeen(storage)).toEqual({ ai: 3 });
    store.set("wissel.app.storiesSeen", "{not json");
    expect(loadSeen(storage)).toEqual({});
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(loadSeen(broken)).toEqual({});
    expect(() => saveSeen({ ai: 1 }, broken)).not.toThrow();
    expect(loadSeen(undefined)).toEqual({});
  });
});

describe("feed API", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("fetchFeed asks for a page, with before when given", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ items: [], next: null }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await fetchFeed(50);
    await fetchFeed(50, "2026-10-10T10:00:00.000Z~landed:a");
    expect(fetchMock.mock.calls[0]![0]).toBe("/feed?limit=50");
    expect(fetchMock.mock.calls[1]![0]).toBe("/feed?limit=50&before=2026-10-10T10%3A00%3A00.000Z%7Elanded%3Aa");
  });

  test("postAction POSTs and surfaces the server's error", async () => {
    const ok = vi.fn(async () => new Response(null, { status: 202 }));
    globalThis.fetch = ok as unknown as typeof fetch;
    await postAction("/tasks/a/run");
    expect(ok).toHaveBeenCalledWith("/tasks/a/run", { method: "POST" });

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "task a is already running" }), { status: 409 })) as unknown as typeof fetch;
    await expect(postAction("/tasks/a/run")).rejects.toThrow("task a is already running");
    globalThis.fetch = (async () => new Response("oops", { status: 500 })) as unknown as typeof fetch;
    await expect(postAction("/tasks/a/run")).rejects.toThrow("HTTP 500");
  });
});
