// The Board screen's Scheduled section and the "Starts 23:00" chip
// (docs/SDD-schedules.md §3.8, §4). Pure: `now` is passed in, and
// `timeZone` only so tests can pin one; the app leaves it out and gets
// the browser's own zone.

import type { Schedule } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Upcoming runs first: what runs in the next 24 h by time, then the
 *  rest of the enabled ones by time, then the paused ones by name. */
export function orderSchedules(schedules: readonly Schedule[], now: number): Schedule[] {
  const at = (s: Schedule) => (s.enabled && s.nextRunAt ? Date.parse(s.nextRunAt) : Number.NaN);
  const rank = (s: Schedule) => (Number.isNaN(at(s)) ? 2 : at(s) - now <= DAY_MS ? 0 : 1);
  return [...schedules].sort((a, b) => rank(a) - rank(b) || (rank(a) < 2 ? at(a) - at(b) : 0) || a.name.localeCompare(b.name));
}

/** How many of them run in the next 24 h. */
export function dueWithinDay(schedules: readonly Schedule[], now: number): number {
  return schedules.filter((s) => s.enabled && s.nextRunAt && Date.parse(s.nextRunAt) - now <= DAY_MS).length;
}

function parts(ms: number, timeZone?: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
}

const dayKey = (p: Record<string, string>) => `${p.year}-${p.month}-${p.day}`;

/** "today 06:00", "tomorrow 06:00", "Wed 14 Oct 06:00", in the reader's
 *  zone. "" for a time that doesn't parse. */
export function whenLabel(iso: string, now: number, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const p = parts(ms, timeZone);
  const hhmm = `${p.hour}:${p.minute}`;
  if (dayKey(p) === dayKey(parts(now, timeZone))) return `today ${hhmm}`;
  if (dayKey(p) === dayKey(parts(now + DAY_MS, timeZone))) return `tomorrow ${hhmm}`;
  return `${p.weekday} ${p.day} ${p.month} ${hhmm}`;
}

/** The line under a schedule's name: when it runs next and how often. */
export function scheduleLine(s: Schedule, now: number, timeZone?: string): string {
  const next = s.enabled && s.nextRunAt ? `next ${whenLabel(s.nextRunAt, now, timeZone)}` : "paused";
  return `${next} · ${s.cadence} (${s.timezone})`;
}

/** "Starts 23:00" for a card that waits for its start time (within the
 *  next 24 h), "Starts 14 Oct 23:00" further out, null once it is due:
 *  the sweep picks it up then and the chip would only mislead. */
export function startsChip(notBefore: string | undefined, now: number, timeZone?: string): string | null {
  if (!notBefore) return null;
  const ms = Date.parse(notBefore);
  if (Number.isNaN(ms) || ms <= now) return null;
  const p = parts(ms, timeZone);
  return ms - now < DAY_MS ? `Starts ${p.hour}:${p.minute}` : `Starts ${p.day} ${p.month} ${p.hour}:${p.minute}`;
}
