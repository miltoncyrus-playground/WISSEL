import { describe, expect, test } from "bun:test";
import type { TaskCard } from "../src/core/types.ts";
import type { ResultMeta } from "../src/services/board.ts";
import {
  buildFeed,
  cardHref,
  compareItems,
  FEED_KINDS,
  formatCursor,
  formatDuration,
  needsYouAction,
  parseCursor,
  spendItems,
  type FeedInput,
  type FeedItem,
  type FeedRun,
} from "../src/services/feed.ts";
import type { TelemetryLine } from "../src/services/news-run-checks.ts";

// docs/SDD-wissel-app.md §3.2: buildFeed is pure. Every test hands it
// cards, results, runs and telemetry directly.

// Local noon, so "yesterday" and "today" are unambiguous in any timezone.
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function card(id: string, over: Partial<TaskCard> = {}): TaskCard {
  return { id, title: `Card ${id}`, body: "", labels: [], status: "inbox", repo: "/home/m/code/wissel", ...over };
}

function feed(over: Partial<FeedInput>): FeedItem[] {
  return buildFeed({ tasks: [], now: NOW, limit: 200, ...over }).items;
}

const byId = (items: FeedItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));

describe("landed", () => {
  test("a done card is landed at its doneAt, with the merge branch when it had a worktree", () => {
    const results = new Map<string, ResultMeta>([["a", { agentId: "implementer", ok: true, worktreeBranch: "wissel/a" }]]);
    const items = feed({ tasks: [card("a", { status: "done", doneAt: hoursAgo(2) })], results });
    expect(items).toEqual([
      {
        id: "landed:a",
        kind: "landed",
        at: hoursAgo(2),
        title: "Card a",
        detail: "Merged wissel/a · implementer in wissel",
        links: [{ label: "Open", href: "/app#/board/a" }],
        taskId: "a",
      },
    ]);
  });

  test("with no doneAt it falls back to the result's finishedAt, then the card's latest telemetry", () => {
    const results = new Map<string, ResultMeta>([["r", { agentId: "x", ok: true, finishedAt: hoursAgo(3) }]]);
    const telemetry: TelemetryLine[] = [
      { type: "dispatch", taskId: "t", at: hoursAgo(6) },
      { type: "result", taskId: "t", at: hoursAgo(5) },
    ];
    const items = byId(feed({ tasks: [card("r", { status: "done" }), card("t", { status: "done" }), card("none", { status: "done" })], results, telemetry }));
    expect(items["landed:r"]!.at).toBe(hoursAgo(3));
    expect(items["landed:t"]!.at).toBe(hoursAgo(5));
    // Nothing dates it: left out rather than shown at a made-up time.
    expect(items["landed:none"]).toBeUndefined();
  });

  test("pipeline steps, reviewer cards and superseded cards are bookkeeping, not landings", () => {
    const tasks = [
      card("step", { status: "done", doneAt: hoursAgo(1), pipelineId: "p", pipelineRunId: "root", pipelineStepId: "s" }),
      card("rev", { status: "done", doneAt: hoursAgo(1), parentTaskId: "impl", labels: ["review"] }),
      card("old", { status: "done", doneAt: hoursAgo(1), supersededBy: "new" }),
      card("root", { status: "done", doneAt: hoursAgo(1), pipelineId: "p", title: "Pipeline: Review loop" }),
    ];
    expect(feed({ tasks }).map((i) => i.id)).toEqual(["landed:root"]);
  });
});

describe("needs-you", () => {
  const none = new Set<string>();

  test("each state carries the one action the board supports", () => {
    expect(needsYouAction(card("a", { status: "review" }), none)).toEqual({ detail: "Ready for your review", link: { label: "Open", href: cardHref("a") } });
    expect(needsYouAction(card("a", { status: "escalated" }), none)!.link.label).toBe("Open");
    expect(needsYouAction(card("a", { status: "no-match" }), none)!.link.label).toBe("Open");
    expect(needsYouAction(card("a", { status: "failed" }), none)!.link).toEqual({ label: "Retry", href: "/tasks/a/run", method: "POST" });
    expect(needsYouAction(card("a", { status: "review", pendingMcpApproval: { server: "slack", tool: "post", args: {}, reason: "r" } }), none)).toEqual({
      detail: "Wants to call slack · post",
      link: { label: "Approve", href: "/tasks/a/mcp-approval/approve", method: "POST" },
    });
  });

  test("a queued card pinned to a disabled harness is held; to an enabled one it is not", () => {
    const held = card("h", { status: "inbox", harnessOverride: "claude-adevinta" });
    expect(needsYouAction(held, new Set(["claude-adevinta"]))!.detail).toBe("Held: claude-adevinta is switched off");
    expect(needsYouAction(held, none)).toBeNull();
    expect(needsYouAction(card("r", { status: "running", harnessOverride: "claude-adevinta" }), new Set(["claude-adevinta"]))).toBeNull();
  });

  test("running, done, archived and superseded cards don't need you", () => {
    expect(needsYouAction(card("a", { status: "running" }), none)).toBeNull();
    expect(needsYouAction(card("a", { status: "pending-review" }), none)).toBeNull();
    expect(needsYouAction(card("a", { status: "failed", archivedAt: hoursAgo(1) }), none)).toBeNull();
    expect(needsYouAction(card("a", { status: "failed", supersededBy: "b" }), none)).toBeNull();
  });

  test("dated by the latest result; with none it sits at now, marked undated", () => {
    const results = new Map<string, ResultMeta>([["f", { agentId: "x", ok: false, finishedAt: hoursAgo(4) }]]);
    const items = byId(feed({ tasks: [card("f", { status: "failed" }), card("n", { status: "no-match" })], results }));
    expect(items["needs-you:f"]!.at).toBe(hoursAgo(4));
    expect(items["needs-you:f"]!.undated).toBeUndefined();
    expect(items["needs-you:n"]!.at).toBe(new Date(NOW).toISOString());
    expect(items["needs-you:n"]!.undated).toBe(true);
  });

  test("a failed pipeline step is told by its run's root, not on its own", () => {
    const tasks = [card("step", { status: "failed", pipelineId: "p", pipelineRunId: "root" }), card("root", { status: "failed", pipelineId: "p" })];
    expect(feed({ tasks }).map((i) => i.id)).toEqual(["needs-you:root"]);
  });
});

describe("podcast and checks", () => {
  const run: FeedRun = {
    runId: "run1",
    pipelineName: "AI news podcast",
    show: "ai",
    at: hoursAgo(1),
    headline: "Open coding model catches up",
    durationSeconds: 312,
    audioUrl: "/pipeline-runs/run1/audio",
    checks: { pass: false, total: 9, failed: ["dates-recent", "cost"] },
  };

  test("a run with audio is a podcast item, followed by its checks", () => {
    const tasks = [card("run1", { status: "done", doneAt: hoursAgo(1), pipelineId: "p" })];
    const items = feed({ tasks, runs: [run] });
    // The run's root is not also a landed item.
    expect(items.map((i) => i.id)).toEqual(["podcast:run1", "podcast:run1:checks"]);
    expect(items[0]).toMatchObject({
      kind: "podcast",
      title: "Open coding model catches up",
      detail: "AI news podcast · 5 min",
      show: "ai",
      audioUrl: "/pipeline-runs/run1/audio",
      durationSeconds: 312,
      runId: "run1",
      // The app's mini-player shows it under the title (§3.3).
      pipelineName: "AI news podcast",
    });
    expect(items[1]).toMatchObject({
      kind: "checks",
      title: "2 of 9 checks failed",
      detail: "AI news podcast: dates-recent, cost",
      pass: false,
      links: [{ label: "Open run", href: "/board#/pipelines/run/run1" }],
    });
  });

  test("passing checks say so; no headline falls back to the pipeline name; no time drops the run", () => {
    const ok = feed({ runs: [{ ...run, headline: undefined, durationSeconds: undefined, checks: { pass: true, total: 9, failed: [] } }] });
    expect(ok[0]!.title).toBe("AI news podcast");
    expect(ok[0]!.detail).toBe("AI news podcast");
    expect(ok[1]!.title).toBe("All 9 checks passed");
    expect(ok[1]!.pass).toBe(true);
    expect(feed({ runs: [{ ...run, at: undefined }] })).toEqual([]);
    expect(feed({ runs: [{ ...run, checks: undefined }] }).map((i) => i.kind)).toEqual(["podcast"]);
  });
});

describe("spend", () => {
  const yesterday = new Date(2026, 9, 9, 15, 0, 0).toISOString();
  const twoDaysAgo = new Date(2026, 9, 8, 9, 0, 0).toISOString();
  const telemetry: TelemetryLine[] = [
    { type: "result", taskId: "a", actualCost: 1.0, harnessId: "claude", at: yesterday },
    { type: "result", taskId: "b", actualCost: 0.25, harnessId: "codex", at: yesterday },
    { type: "result", taskId: "c", actualCost: 0.5, harnessId: "claude", at: yesterday },
    { type: "result", taskId: "d", actualCost: 0.1, at: twoDaysAgo },
    { type: "result", taskId: "e", actualCost: 9, harnessId: "claude", at: hoursAgo(1) }, // today: not yet
    { type: "result", taskId: "f", actualCost: 0, harnessId: "kokoro", at: yesterday }, // free: ignored
    { type: "dispatch", taskId: "g", estimatedCost: 5, at: yesterday } as TelemetryLine,
    { type: "result", taskId: "h", actualCost: 2, at: "not a date" },
  ];

  test("one item per past day, by harness, dated the midnight that closed it", () => {
    const items = spendItems(telemetry, NOW);
    const ids = items.map((i) => i.id).sort();
    expect(ids).toEqual(["spend:2026-10-08", "spend:2026-10-09"]);
    const y = items.find((i) => i.id === "spend:2026-10-09")!;
    expect(y.title).toBe("$1.75 spent on 2026-10-09");
    expect(y.detail).toBe("claude $1.50 · codex $0.25");
    expect(y.at).toBe(new Date(2026, 9, 10, 0, 0, 0).toISOString());
    expect(items.find((i) => i.id === "spend:2026-10-08")!.detail).toBe("unknown $0.10");
  });

  test("today's spend waits for tomorrow", () => {
    expect(spendItems(telemetry, NOW).some((i) => i.title.startsWith("$9"))).toBe(false);
  });
});

describe("order and pages", () => {
  const tasks = [
    card("a", { status: "done", doneAt: hoursAgo(1) }),
    card("b", { status: "done", doneAt: hoursAgo(3) }),
    card("c", { status: "done", doneAt: hoursAgo(3) }), // same time as b
    card("d", { status: "done", doneAt: hoursAgo(3) }),
    card("e", { status: "done", doneAt: hoursAgo(5) }),
  ];

  test("newest first, equal times by id", () => {
    expect(feed({ tasks }).map((i) => i.id)).toEqual(["landed:a", "landed:b", "landed:c", "landed:d", "landed:e"]);
  });

  test("paging with next visits every item exactly once, even across a tie", () => {
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = buildFeed({ tasks, now: NOW, limit: 2, before: before ? parseCursor(before)! : undefined });
      seen.push(...page.items.map((i) => i.id));
      before = page.next;
      if (!before) break;
    }
    expect(seen).toEqual(["landed:a", "landed:b", "landed:c", "landed:d", "landed:e"]);
  });

  test("before as a plain ISO time returns everything older", () => {
    const page = buildFeed({ tasks, now: NOW, limit: 50, before: parseCursor(hoursAgo(3))! });
    expect(page.items.map((i) => i.id)).toEqual(["landed:e"]);
    expect(page.next).toBeNull();
  });

  test("limit caps the page and next is null on the last page", () => {
    const page = buildFeed({ tasks, now: NOW, limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.next).toBeNull();
    expect(buildFeed({ tasks, now: NOW, limit: 4 }).next).toBe(formatCursor({ at: hoursAgo(3), id: "landed:d" }));
  });

  test("parseCursor reads ISO and ISO~id, and refuses junk", () => {
    expect(parseCursor("2026-10-10T10:00:00.000Z")).toEqual({ at: Date.parse("2026-10-10T10:00:00.000Z") });
    expect(parseCursor("2026-10-10T10:00:00.000Z~landed:x")).toEqual({ at: Date.parse("2026-10-10T10:00:00.000Z"), id: "landed:x" });
    expect(parseCursor("yesterday")).toBeNull();
  });

  test("compareItems is a total order", () => {
    expect(compareItems({ at: hoursAgo(1), id: "x" }, { at: hoursAgo(2), id: "a" })).toBeLessThan(0);
    expect(compareItems({ at: hoursAgo(1), id: "a" }, { at: hoursAgo(1), id: "b" })).toBeLessThan(0);
    expect(compareItems({ at: hoursAgo(1), id: "a" }, { at: hoursAgo(1), id: "a" })).toBe(0);
  });
});

test("same input, same output, and the input is not touched", () => {
  const tasks = [card("a", { status: "done", doneAt: hoursAgo(1) }), card("f", { status: "failed" })];
  const frozen = JSON.stringify(tasks);
  const input: FeedInput = { tasks, now: NOW, limit: 50, telemetry: [{ type: "result", taskId: "x", actualCost: 1, at: hoursAgo(30) }] };
  expect(buildFeed(input)).toEqual(buildFeed(input));
  expect(JSON.stringify(tasks)).toBe(frozen);
});

test("every item kind is one of FEED_KINDS, and copy has no em dashes", () => {
  const items = feed({
    tasks: [card("a", { status: "done", doneAt: hoursAgo(1) }), card("f", { status: "failed" })],
    runs: [{ runId: "r", pipelineName: "P", show: "other", at: hoursAgo(2), audioUrl: "/x", checks: { pass: true, total: 1, failed: [] } }],
    telemetry: [{ type: "result", taskId: "x", actualCost: 1, at: hoursAgo(30) }],
  });
  expect(new Set(items.map((i) => i.kind))).toEqual(new Set(FEED_KINDS));
  for (const i of items) expect(`${i.title} ${i.detail}`).not.toContain("—");
});

test("formatDuration", () => {
  expect(formatDuration(45)).toBe("45 s");
  expect(formatDuration(312)).toBe("5 min");
});
