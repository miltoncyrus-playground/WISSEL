/**
 * Cron + timezone rules for schedules (docs/SDD-schedules.md §3.3): the
 * one place the API, the board's preview, the store and Ask check a
 * schedule's cadence, so all of them refuse the same values with the
 * same words.
 *
 * Pure: no I/O, and `from` is always passed in, never read from the
 * clock. croner (pinned exactly to 10.0.1, §3.1) is used for parsing and
 * next-run times only, always `paused: true`, so it never owns a timer;
 * the ticker (src/core/schedule-runner.ts) is ours.
 *
 * DST is croner's: an occurrence is a wall-clock time in `timezone`, so
 * `0 6 * * *` in Europe/Madrid is 04:00Z in summer and 05:00Z in winter.
 * A wall-clock time that falls in the spring-forward gap (02:30 on
 * 2027-03-28 in Europe/Madrid, where 02:00 jumps to 03:00) fires once
 * that day, shifted forward by the gap's hour to 03:30 local (01:30Z),
 * rather than skipping the day. test/schedule-time.test.ts
 * pins this so a croner upgrade that changes it fails loudly.
 */

import { Cron } from "croner";

/** The timezone a schedule gets when nobody names one. UIs preselect the
 *  browser's own zone and send it; this is only the server-side fallback. */
export const DEFAULT_SCHEDULE_TIMEZONE = "Europe/Madrid";

/** No schedule may fire more often than this (between any two of its
 *  next `GAP_SAMPLE` runs): guards `* * * * *` burning money on a paid
 *  pipeline. */
export const MIN_SCHEDULE_GAP_MINUTES = 5;
const GAP_SAMPLE = 10;

export type ScheduleTimeCheck = { ok: true } | { ok: false; error: string };

function cron(expr: string, timezone?: string): Cron {
  return new Cron(expr.trim(), { paused: true, ...(timezone ? { timezone } : {}) });
}

function fields(expr: string): string[] {
  return expr.trim().split(/\s+/).filter((f) => f !== "");
}

/** croner parses it and it has exactly 5 fields (minute hour
 *  day-of-month month day-of-week): no seconds field, no `@daily`. */
export function validateCron(expr: unknown): ScheduleTimeCheck {
  if (typeof expr !== "string" || expr.trim() === "") return { ok: false, error: "cron is required, e.g. 0 6 * * *" };
  const n = fields(expr).length;
  if (n !== 5) {
    return { ok: false, error: `cron must have exactly 5 fields (minute hour day-of-month month day-of-week), "${expr}" has ${n}` };
  }
  let next: Date | null;
  try {
    next = cron(expr).nextRun();
  } catch (err) {
    return { ok: false, error: `cron "${expr}" is not valid: ${err instanceof Error ? err.message : String(err)}` };
  }
  // e.g. `0 0 31 2 *` parses but never comes round.
  if (!next) return { ok: false, error: `cron "${expr}" never runs` };
  return { ok: true };
}

/** An IANA zone the runtime knows, e.g. `Europe/Madrid`. */
export function validateTimezone(tz: unknown): ScheduleTimeCheck {
  if (typeof tz !== "string" || tz.trim() === "") return { ok: false, error: "timezone is required, e.g. Europe/Madrid" };
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    return { ok: false, error: `unknown timezone "${tz}", use an IANA name like Europe/Madrid` };
  }
  return { ok: true };
}

/** The first run strictly after `from`. Throws on an invalid cron or
 *  timezone, or one that never runs: call validateSchedule first. */
export function nextRunAfter(expr: string, timezone: string, from: Date): Date {
  const next = cron(expr, timezone).nextRun(from);
  if (!next) throw new Error(`cron "${expr}" has no run after ${from.toISOString()}`);
  return next;
}

/** The next `n` runs strictly after `from`, for previews. */
export function nextRuns(expr: string, timezone: string, n: number, from: Date): Date[] {
  return cron(expr, timezone).nextRuns(n, from);
}

/** The one check the API, the UI preview, the store and Ask all call:
 *  a valid 5-field cron, a known timezone, and at least
 *  MIN_SCHEDULE_GAP_MINUTES between any two of the next 10 runs. `from`
 *  only matters for the gap check of a cadence that is uneven over time
 *  (the runs are sampled from it). */
export function validateSchedule(input: { cron: unknown; timezone: unknown }, from: Date = new Date()): ScheduleTimeCheck {
  const c = validateCron(input.cron);
  if (!c.ok) return c;
  const t = validateTimezone(input.timezone);
  if (!t.ok) return t;
  const runs = nextRuns(input.cron as string, input.timezone as string, GAP_SAMPLE, from);
  // Runs come back in order, so the smallest gap between any two of
  // them is the smallest gap between neighbours.
  let minGapMs = Infinity;
  for (let i = 1; i < runs.length; i++) minGapMs = Math.min(minGapMs, runs[i]!.getTime() - runs[i - 1]!.getTime());
  if (minGapMs < MIN_SCHEDULE_GAP_MINUTES * 60_000) {
    const every = Math.round(minGapMs / 60_000);
    const actual = every < 1 ? "less than a minute" : every === 1 ? "1 minute" : `${every} minutes`;
    return { ok: false, error: `runs must be at least ${MIN_SCHEDULE_GAP_MINUTES} minutes apart; "${input.cron}" runs ${actual} apart` };
  }
  return { ok: true };
}

// ---------- describeCadence: deterministic templates, no LLM ----------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ABBR = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** A plain non-negative integer field ("6", "06"), else undefined. */
function int(field: string, max: number): number | undefined {
  if (!/^\d{1,2}$/.test(field)) return undefined;
  const n = Number(field);
  return n <= max ? n : undefined;
}

/** A comma list of plain integers ("6", "6,18"), else undefined. */
function intList(field: string, max: number): number[] | undefined {
  const out: number[] = [];
  for (const part of field.split(",")) {
    const n = int(part, max);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** `*\/N` or `0/N` with N > 1, else undefined. */
function step(field: string): number | undefined {
  const m = /^(?:\*|0)\/(\d{1,2})$/.exec(field);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 1 ? n : undefined;
}

/** Day-of-week field as a sorted set of 0-6 (Sunday = 0, 7 also Sunday),
 *  accepting numbers, MON-style names, ranges and lists. */
function days(field: string): number[] | undefined {
  const one = (s: string): number | undefined => {
    const abbr = DAY_ABBR.indexOf(s.toUpperCase());
    if (abbr >= 0) return abbr;
    const n = int(s, 7);
    return n === undefined ? undefined : n % 7;
  };
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const d = one(part);
      if (d === undefined) return undefined;
      out.add(d);
    } else if (range.length === 2) {
      const a = one(range[0]!);
      // "5-7" ends on Sunday-as-7; keep it as 7 for the loop.
      const b = range[1] === "7" ? 7 : one(range[1]!);
      if (a === undefined || b === undefined || b < a) return undefined;
      for (let d = a; d <= b; d++) out.add(d % 7);
    } else {
      return undefined;
    }
  }
  return [...out].sort((a, b) => a - b);
}

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function joinAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "every day at 06:00", "weekdays at 07:30", "every Monday and Thursday
 *  at 09:00", "every 2 hours", ... for UIs. Anything no template covers
 *  comes back as the raw cron string. Says nothing about the timezone:
 *  UIs show that next to it. */
export function describeCadence(expr: string): string {
  const f = fields(expr);
  if (f.length !== 5) return expr;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];

  // every N minutes
  const minStep = step(min);
  if (minStep !== undefined && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `every ${minStep} minutes`;

  const m = int(min, 59);
  if (m === undefined) return expr;

  // every hour / every N hours
  if (dom === "*" && mon === "*" && dow === "*") {
    const hourStep = hour === "*" ? 1 : step(hour);
    if (hourStep !== undefined) {
      const base = hourStep === 1 ? "every hour" : `every ${hourStep} hours`;
      return m === 0 ? base : `${base} at ${String(m).padStart(2, "0")} past`;
    }
  }

  const hours = intList(hour, 23);
  if (!hours || hours.length > 4 || mon !== "*") return expr;
  const at = `at ${joinAnd(hours.map((h) => hhmm(h, m)))}`;

  if (dom === "*") {
    if (dow === "*") return `every day ${at}`;
    const d = days(dow);
    if (!d) return expr;
    if (d.length === 7) return `every day ${at}`;
    if (d.join() === "1,2,3,4,5") return `weekdays ${at}`;
    if (d.join() === "0,6") return `weekends ${at}`;
    // Monday first: a week reads Monday to Sunday.
    const ordered = [...d.filter((x) => x !== 0), ...d.filter((x) => x === 0)];
    return `every ${joinAnd(ordered.map((x) => DAY_NAMES[x]!))} ${at}`;
  }

  const day = int(dom, 31);
  if (day !== undefined && day >= 1 && dow === "*") return `on day ${day} of every month ${at}`;
  return expr;
}
