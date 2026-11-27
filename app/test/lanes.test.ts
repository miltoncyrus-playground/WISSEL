import { describe, expect, test } from "vitest";
import { LANES, laneOf, needsYouReason, partitionLanes, startOfLocalDay } from "../src/lanes";
import type { TaskCard } from "../src/types";

function card(id: string, over: Partial<TaskCard> = {}): TaskCard {
  return { id, title: id, body: "", labels: [], status: "inbox", ...over };
}

// Midday local time, so "today" and "yesterday" are unambiguous in any
// timezone the tests run in.
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const START = startOfLocalDay(NOW);
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("laneOf", () => {
  test("running and dispatched are Running", () => {
    expect(laneOf(card("a", { status: "running" }), START)).toBe("running");
    expect(laneOf(card("a", { status: "dispatched" }), START)).toBe("running");
  });

  test("review, escalated, failed and no-match need you", () => {
    for (const status of ["review", "escalated", "failed", "no-match"] as const) {
      expect(laneOf(card("a", { status }), START)).toBe("needs-you");
    }
  });

  test("pending-review is the reviewer's queue: Review", () => {
    expect(laneOf(card("a", { status: "pending-review" }), START)).toBe("review");
  });

  test("done shows only when it finished today (local)", () => {
    expect(laneOf(card("a", { status: "done", doneAt: hoursAgo(1) }), START)).toBe("done-today");
    expect(laneOf(card("a", { status: "done", doneAt: hoursAgo(13) }), START)).toBeNull();
    expect(laneOf(card("a", { status: "done" }), START)).toBeNull();
    expect(laneOf(card("a", { status: "done", doneAt: "garbage" }), START)).toBeNull();
  });

  test("inbox and ready are queued: not on the compact board", () => {
    expect(laneOf(card("a", { status: "inbox" }), START)).toBeNull();
    expect(laneOf(card("a", { status: "ready" }), START)).toBeNull();
  });

  test("archived and superseded cards never show", () => {
    expect(laneOf(card("a", { status: "failed", archivedAt: hoursAgo(1) }), START)).toBeNull();
    expect(laneOf(card("a", { status: "running", supersededBy: "b" }), START)).toBeNull();
  });
});

describe("partitionLanes", () => {
  test("puts every card in its lane, Done today newest first", () => {
    const tasks = [
      card("r", { status: "running" }),
      card("f", { status: "failed" }),
      card("p", { status: "pending-review" }),
      card("d-old", { status: "done", doneAt: hoursAgo(3) }),
      card("d-new", { status: "done", doneAt: hoursAgo(1) }),
      card("i", { status: "inbox" }),
    ];
    const lanes = partitionLanes(tasks, NOW);
    expect(lanes.running.map((t) => t.id)).toEqual(["r"]);
    expect(lanes["needs-you"].map((t) => t.id)).toEqual(["f"]);
    expect(lanes.review.map((t) => t.id)).toEqual(["p"]);
    expect(lanes["done-today"].map((t) => t.id)).toEqual(["d-new", "d-old"]);
  });

  test("has exactly the five lanes, in order", () => {
    expect(LANES.map((l) => l.label)).toEqual(["Running", "Needs a human", "Next step", "Review", "Done today"]);
    expect(Object.keys(partitionLanes([], NOW)).sort()).toEqual(LANES.map((l) => l.id).sort());
  });
});

describe("laneOf and the server's needsYou lane", () => {
  const ny = (lane: "human" | "next-step") => ({ kind: "merge" as const, lane, value: "merge", line: "l", why: "w", action: { label: "Merge", href: "/x", method: "POST" as const } });
  test("human goes to Needs a human, a finished next step to Next step, a queued next step stays hidden", () => {
    const start = startOfLocalDay(NOW);
    expect(laneOf(card("a", { status: "review", needsYou: ny("human") }), start)).toBe("needs-you");
    expect(laneOf(card("a", { status: "review", needsYou: ny("next-step") }), start)).toBe("next-step");
    expect(laneOf(card("a", { status: "inbox", needsYou: ny("next-step") }), start)).toBeNull();
    expect(laneOf(card("a", { status: "inbox", needsYou: ny("human") }), start)).toBe("needs-you");
    // An older server (no lane): the status decides, as before.
    expect(laneOf(card("a", { status: "review" }), start)).toBe("needs-you");
  });
});

describe("needsYouReason", () => {
  test("names an open MCP approval first", () => {
    expect(needsYouReason(card("a", { status: "review", pendingMcpApproval: { server: "slack", tool: "post" } }))).toBe("Approve slack · post");
  });

  test("a resolved approval (status moved on) is not an approval", () => {
    expect(needsYouReason(card("a", { status: "failed", pendingMcpApproval: { server: "slack", tool: "post" } }))).toBe("Failed");
  });

  test("plain statuses", () => {
    expect(needsYouReason(card("a", { status: "review" }))).toBe("Ready for your review");
    expect(needsYouReason(card("a", { status: "escalated" }))).toBe("Reviewer escalated it");
    expect(needsYouReason(card("a", { status: "no-match" }))).toBe("No agent matched");
  });
});

describe("a review in flight draws once", () => {
  test("the reviewer's live card leaves Running; the card it reviews says Review in progress", () => {
    const impl = card("impl", { status: "pending-review" });
    const rev = card("rev", { status: "running", routedTo: "reviewer", parentTaskId: "impl", labels: ["review"] });
    const lanes = partitionLanes([impl, rev], NOW);
    expect(lanes.running).toEqual([]);
    expect(lanes.review.map((t) => [t.id, t.reviewInProgress])).toEqual([["impl", true]]);
  });

  test("a queued reviewer folds too, without the in-progress mark; a lone reviewer still shows", () => {
    const impl = card("impl", { status: "pending-review" });
    const queued = card("rev", { status: "ready", routedTo: "reviewer", parentTaskId: "impl" });
    expect(partitionLanes([impl, queued], NOW).review[0]!.reviewInProgress).toBeUndefined();
    const lone = card("rev", { status: "running", routedTo: "reviewer", parentTaskId: "gone" });
    expect(partitionLanes([lone], NOW).running.map((t) => t.id)).toEqual(["rev"]);
  });
});
