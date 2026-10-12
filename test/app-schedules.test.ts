import { describe, expect, test } from "bun:test";
import { dueWithinDay, orderSchedules, scheduleLine, startsChip, whenLabel } from "../app/src/schedules.ts";
import { statusTextOf } from "../app/src/ask.ts";
import type { Schedule, TaskCard } from "../app/src/types.ts";

// The app's Scheduled section and "Starts 23:00" chip
// (docs/SDD-schedules.md §3.8, §4), pure. Here rather than in app/test
// (vitest) so the gate lane runs it without app/node_modules. Every
// label is pinned to Europe/Madrid so the machine's zone doesn't matter.

const TZ = "Europe/Madrid";
// 12:00 in Madrid on Monday 2026-10-12.
const NOW = Date.parse("2026-10-12T10:00:00.000Z");

function sched(id: string, over: Partial<Schedule> = {}): Schedule {
  return { id, name: id, kind: "pipeline", cron: "0 6 * * *", timezone: TZ, enabled: true, cadence: "every day at 06:00", lastRunStatus: null, ...over };
}

describe("orderSchedules: next 24 h first", () => {
  test("due within a day by time, then later by time, then paused by name", () => {
    const list = [
      sched("paused-b", { enabled: false }),
      sched("weekly", { nextRunAt: "2026-10-19T07:00:00.000Z" }),
      sched("tonight", { nextRunAt: "2026-10-12T21:00:00.000Z" }),
      sched("paused-a", { enabled: false, nextRunAt: "2026-10-12T11:00:00.000Z" }),
      sched("morning", { nextRunAt: "2026-10-13T04:00:00.000Z" }),
      sched("in-two-days", { nextRunAt: "2026-10-14T04:00:00.000Z" }),
    ];
    expect(orderSchedules(list, NOW).map((s) => s.id)).toEqual(["tonight", "morning", "in-two-days", "weekly", "paused-a", "paused-b"]);
    expect(dueWithinDay(list, NOW)).toBe(2);
  });

  test("leaves the input alone", () => {
    const list = [sched("b", { nextRunAt: "2026-10-13T04:00:00.000Z" }), sched("a", { nextRunAt: "2026-10-12T21:00:00.000Z" })];
    orderSchedules(list, NOW);
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("labels", () => {
  test("today, tomorrow, then a short date, in the reader's zone", () => {
    expect(whenLabel("2026-10-12T21:00:00.000Z", NOW, TZ)).toBe("today 23:00");
    expect(whenLabel("2026-10-13T04:00:00.000Z", NOW, TZ)).toBe("tomorrow 06:00");
    expect(whenLabel("2026-10-19T07:00:00.000Z", NOW, TZ)).toBe("Mon 19 Oct 09:00");
    expect(whenLabel("not a date", NOW, TZ)).toBe("");
  });

  test("the line under a schedule: next run and cadence, or paused", () => {
    expect(scheduleLine(sched("a", { nextRunAt: "2026-10-13T04:00:00.000Z" }), NOW, TZ)).toBe("next tomorrow 06:00 · every day at 06:00 (Europe/Madrid)");
    expect(scheduleLine(sched("a", { enabled: false }), NOW, TZ)).toBe("paused · every day at 06:00 (Europe/Madrid)");
  });
});

describe("startsChip (§4)", () => {
  test("Starts HH:MM within a day, with the date further out, nothing once due", () => {
    expect(startsChip("2026-10-12T21:00:00.000Z", NOW, TZ)).toBe("Starts 23:00");
    expect(startsChip("2026-10-15T21:00:00.000Z", NOW, TZ)).toBe("Starts 15 Oct 23:00");
    expect(startsChip("2026-10-12T09:00:00.000Z", NOW, TZ)).toBeNull();
    expect(startsChip(undefined, NOW, TZ)).toBeNull();
    expect(startsChip("garbage", NOW, TZ)).toBeNull();
  });

  test("an Ask chip for a queued card waiting for its start says when it starts", () => {
    const card: TaskCard = { id: "c1", title: "Tidy", body: "", labels: [], status: "inbox", notBefore: new Date(NOW + 60 * 60 * 1000).toISOString() };
    expect(statusTextOf(card, NOW)).toStartWith("Starts ");
    expect(statusTextOf({ ...card, notBefore: undefined }, NOW)).toBe("Queued");
    expect(statusTextOf({ ...card, status: "running" }, NOW)).toBe("Running");
  });
});
