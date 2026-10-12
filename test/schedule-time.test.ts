import { expect, test } from "bun:test";
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  MIN_SCHEDULE_GAP_MINUTES,
  describeCadence,
  nextRunAfter,
  nextRuns,
  validateCron,
  validateSchedule,
  validateTimezone,
} from "../src/core/schedule-time.ts";

// Cron + timezone rules for schedules, docs/SDD-schedules.md §3.3.
// croner is pinned to exactly 10.0.1 (package.json); the DST tests below
// pin its behaviour so an upgrade that changes it fails here first.

const FROM = new Date("2026-10-12T10:00:00.000Z");
const iso = (d: Date) => d.toISOString();

// ---------- validateCron ----------

test("validateCron accepts a 5-field cron", () => {
  for (const ok of ["0 6 * * *", "30 7 * * 1-5", "0 9 * * MON,THU", "*/5 * * * *", "  0  6 * * *  "]) {
    expect(validateCron(ok)).toEqual({ ok: true });
  }
});

test("validateCron refuses a seconds field, a nickname and a short cron", () => {
  expect(validateCron("0 0 6 * * *")).toEqual({
    ok: false,
    error: 'cron must have exactly 5 fields (minute hour day-of-month month day-of-week), "0 0 6 * * *" has 6',
  });
  expect(validateCron("@daily").ok).toBe(false);
  expect(validateCron("0 6 * *").ok).toBe(false);
});

test("validateCron refuses garbage, an out-of-range field, a cron that never runs, and non-strings", () => {
  const garbage = validateCron("a b c d e");
  expect(garbage.ok).toBe(false);
  if (!garbage.ok) expect(garbage.error).toStartWith('cron "a b c d e" is not valid:');
  expect(validateCron("61 6 * * *").ok).toBe(false);
  expect(validateCron("0 25 * * *").ok).toBe(false);
  expect(validateCron("0 0 31 2 *").ok).toBe(false);
  expect(validateCron("")).toEqual({ ok: false, error: "cron is required, e.g. 0 6 * * *" });
  expect(validateCron(undefined).ok).toBe(false);
  expect(validateCron(6).ok).toBe(false);
});

// ---------- validateTimezone ----------

test("validateTimezone accepts IANA zones and UTC, refuses the rest", () => {
  for (const ok of ["Europe/Madrid", "America/New_York", "UTC", DEFAULT_SCHEDULE_TIMEZONE]) {
    expect(validateTimezone(ok)).toEqual({ ok: true });
  }
  expect(validateTimezone("Mars/Olympus")).toEqual({ ok: false, error: 'unknown timezone "Mars/Olympus", use an IANA name like Europe/Madrid' });
  expect(validateTimezone("").ok).toBe(false);
  expect(validateTimezone(null).ok).toBe(false);
});

test("the default timezone is Europe/Madrid", () => {
  expect(DEFAULT_SCHEDULE_TIMEZONE).toBe("Europe/Madrid");
});

// ---------- validateSchedule: 5-minute minimum ----------

test("validateSchedule refuses every minute and every 2 minutes, accepts every 5", () => {
  expect(MIN_SCHEDULE_GAP_MINUTES).toBe(5);
  expect(validateSchedule({ cron: "* * * * *", timezone: "Europe/Madrid" }, FROM)).toEqual({
    ok: false,
    error: 'runs must be at least 5 minutes apart; "* * * * *" runs 1 minute apart',
  });
  expect(validateSchedule({ cron: "*/2 * * * *", timezone: "Europe/Madrid" }, FROM)).toEqual({
    ok: false,
    error: 'runs must be at least 5 minutes apart; "*/2 * * * *" runs 2 minutes apart',
  });
  expect(validateSchedule({ cron: "*/5 * * * *", timezone: "Europe/Madrid" }, FROM)).toEqual({ ok: true });
});

test("validateSchedule catches a close pair inside an otherwise daily cron", () => {
  const check = validateSchedule({ cron: "0,3 6 * * *", timezone: "Europe/Madrid" }, FROM);
  expect(check).toEqual({ ok: false, error: 'runs must be at least 5 minutes apart; "0,3 6 * * *" runs 3 minutes apart' });
});

test("validateSchedule reports a bad cron before a bad timezone, and passes a good pair", () => {
  expect(validateSchedule({ cron: "0 0 6 * * *", timezone: "Nowhere" }, FROM).ok).toBe(false);
  const tz = validateSchedule({ cron: "0 6 * * *", timezone: "Nowhere" }, FROM);
  expect(tz).toEqual({ ok: false, error: 'unknown timezone "Nowhere", use an IANA name like Europe/Madrid' });
  expect(validateSchedule({ cron: "0 6 * * *", timezone: "Europe/Madrid" }, FROM)).toEqual({ ok: true });
});

// ---------- nextRunAfter / nextRuns ----------

test("nextRunAfter is strictly after `from`", () => {
  const at = new Date("2026-10-13T04:00:00.000Z"); // 06:00 Madrid
  expect(iso(nextRunAfter("0 6 * * *", "Europe/Madrid", at))).toBe("2026-10-14T04:00:00.000Z");
});

test("nextRuns gives n runs in order, in the schedule's timezone", () => {
  expect(nextRuns("30 7 * * 1-5", "Europe/Madrid", 3, new Date("2026-10-16T12:00:00.000Z")).map(iso)).toEqual([
    "2026-10-19T05:30:00.000Z", // Monday
    "2026-10-20T05:30:00.000Z",
    "2026-10-21T05:30:00.000Z",
  ]);
  expect(nextRuns("0 6 * * *", "UTC", 2, FROM).map(iso)).toEqual(["2026-10-13T06:00:00.000Z", "2026-10-14T06:00:00.000Z"]);
});

// ---------- DST, pinned to croner 10.0.1 ----------

test("DST autumn: 06:00 Europe/Madrid is 04:00Z the day before the change and 05:00Z on it", () => {
  const first = nextRunAfter("0 6 * * *", "Europe/Madrid", new Date("2026-10-24T00:00:00.000Z"));
  expect(iso(first)).toBe("2026-10-24T04:00:00.000Z");
  const second = nextRunAfter("0 6 * * *", "Europe/Madrid", first);
  expect(iso(second)).toBe("2026-10-25T05:00:00.000Z");
});

// 2027-03-28 in Europe/Madrid: 02:00 CET jumps to 03:00 CEST, so 02:30
// doesn't exist that day. croner 10.0.1 fires once, shifting the missing
// time forward by the gap's hour to 03:30 CEST (01:30Z), instead of
// skipping the day.
// The day before and after are plain 02:30 local. Same note in
// src/core/schedule-time.ts's header.
test("DST spring: 02:30 Europe/Madrid fires exactly once on 2027-03-28", () => {
  const runs = nextRuns("30 2 * * *", "Europe/Madrid", 3, new Date("2027-03-27T00:00:00.000Z")).map(iso);
  expect(runs).toEqual([
    "2027-03-27T01:30:00.000Z", // 02:30 CET
    "2027-03-28T01:30:00.000Z", // gap: 03:30 CEST
    "2027-03-29T00:30:00.000Z", // 02:30 CEST
  ]);
  const onTheDay = runs.filter((r) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(r)) === "2027-03-28");
  expect(onTheDay).toHaveLength(1);
});

// ---------- describeCadence ----------

test("describeCadence: daily, weekdays, weekends, chosen days, several times", () => {
  expect(describeCadence("0 6 * * *")).toBe("every day at 06:00");
  expect(describeCadence("30 7 * * 1-5")).toBe("weekdays at 07:30");
  expect(describeCadence("0 10 * * 0,6")).toBe("weekends at 10:00");
  expect(describeCadence("0 10 * * 6-7")).toBe("weekends at 10:00");
  expect(describeCadence("0 9 * * 1,4")).toBe("every Monday and Thursday at 09:00");
  expect(describeCadence("0 9 * * MON,thu")).toBe("every Monday and Thursday at 09:00");
  expect(describeCadence("15 8 * * 0,1,3,5")).toBe("every Monday, Wednesday, Friday and Sunday at 08:15");
  expect(describeCadence("0 9 * * 2")).toBe("every Tuesday at 09:00");
  expect(describeCadence("0 6,18 * * *")).toBe("every day at 06:00 and 18:00");
  expect(describeCadence("0 6 * * 0-6")).toBe("every day at 06:00");
});

test("describeCadence: hourly, every N hours, every N minutes, monthly", () => {
  expect(describeCadence("0 */2 * * *")).toBe("every 2 hours");
  expect(describeCadence("15 */3 * * *")).toBe("every 3 hours at 15 past");
  expect(describeCadence("0 * * * *")).toBe("every hour");
  expect(describeCadence("*/15 * * * *")).toBe("every 15 minutes");
  expect(describeCadence("0 6 1 * *")).toBe("on day 1 of every month at 06:00");
});

test("describeCadence falls back to the raw cron for anything else", () => {
  for (const raw of ["0 6 * 1 *", "0 6-8 * * *", "5,10 6 * * *", "0 6 1 * 1", "0 1,2,3,4,5 * * *", "0 0 6 * * *", "nonsense"]) {
    expect(describeCadence(raw)).toBe(raw);
  }
});
