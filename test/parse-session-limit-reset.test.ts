import { expect, test } from "bun:test";
import { parseSessionLimitReset } from "../src/executors/parse-session-limit-reset.ts";

// Real fixture string, captured live from a claude-cli 429 hit during
// this project's own review-handoff pipeline run (subtask C's first
// attempt, and again on Subtask G's reviewer pass).
const REAL_FIXTURE = "You've hit your session limit · resets 3:10pm (UTC)";

test("parses the real fixture string into today's (or tomorrow's) 15:10 UTC", () => {
  const now = new Date("2026-09-22T10:00:00.000Z"); // before 15:10 UTC
  const reset = parseSessionLimitReset(REAL_FIXTURE, now);
  expect(reset).toEqual(new Date("2026-09-22T15:10:00.000Z"));
});

test("rolls forward to tomorrow when the stated time has already passed today", () => {
  const now = new Date("2026-09-22T20:00:00.000Z"); // after 15:10 UTC
  const reset = parseSessionLimitReset(REAL_FIXTURE, now);
  expect(reset).toEqual(new Date("2026-09-23T15:10:00.000Z"));
});

test("handles every hour/minute/am-pm combination correctly, not just the one fixture", () => {
  // Strictly before every case below, including the 12:00am one — an
  // exact tie with `now` is covered separately by the roll-forward test.
  const now = new Date("2025-12-31T23:58:00.000Z");
  expect(parseSessionLimitReset("resets 12:00am (UTC)", now)).toEqual(new Date("2026-01-01T00:00:00.000Z"));
  expect(parseSessionLimitReset("resets 12:00pm (UTC)", now)).toEqual(new Date("2026-01-01T12:00:00.000Z"));
  expect(parseSessionLimitReset("resets 1:05am (UTC)", now)).toEqual(new Date("2026-01-01T01:05:00.000Z"));
  expect(parseSessionLimitReset("resets 11:59pm (UTC)", now)).toEqual(new Date("2025-12-31T23:59:00.000Z"));
  // Case-insensitive am/pm, confirmed against real output shape variance.
  expect(parseSessionLimitReset("resets 3:10PM (UTC)", now)).toEqual(new Date("2026-01-01T15:10:00.000Z"));
});

test("returns null for malformed or missing reset text, never a guessed time", () => {
  expect(parseSessionLimitReset("")).toBeNull();
  expect(parseSessionLimitReset("You've hit your session limit")).toBeNull();
  expect(parseSessionLimitReset("resets sometime later")).toBeNull();
  expect(parseSessionLimitReset("resets 13:10pm (UTC)")).toBeNull(); // not a valid 12-hour hour
  expect(parseSessionLimitReset("resets 3:10pm (PST)")).toBeNull(); // only UTC is trusted
  expect(parseSessionLimitReset("resets 0:10pm (UTC)")).toBeNull(); // 12-hour clock has no 0
});

test("an unrelated error message never accidentally matches", () => {
  expect(parseSessionLimitReset("claude exited 1: some other API error entirely")).toBeNull();
});
