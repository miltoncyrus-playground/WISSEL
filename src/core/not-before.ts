/**
 * Validation for `TaskCard.notBefore`, a person's "start this card at"
 * time (docs/SDD-schedules.md §4). Accepted on `POST /tasks` and
 * `POST /tasks/:id/not-before`; the board UI and Ask reuse it so all
 * three refuse the same values with the same words.
 *
 * Pure: `now` is passed in, never read from the clock, so the tests pin
 * every edge without a fake timer.
 *
 * The time must carry its zone (`Z` or `+02:00`). A bare
 * `2026-10-12T23:00` would be read in the server's own zone, which is
 * not the zone of the person who typed it; the board converts its
 * datetime-local input to UTC before sending.
 */

/** How far ahead a start time may be. A card waiting longer than this
 *  is better as a schedule (docs/SDD-schedules.md §3). */
export const MAX_NOT_BEFORE_DAYS = 30;

const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type NotBeforeCheck = { ok: true; notBefore: string } | { ok: false; error: string };

/** On success `notBefore` is the same instant normalized to
 *  `toISOString()` (UTC, milliseconds), the form stored on the card. */
export function validateNotBefore(value: unknown, now: Date): NotBeforeCheck {
  if (typeof value !== "string" || !ISO_WITH_ZONE_RE.test(value)) {
    return { ok: false, error: "notBefore must be a date and time with a zone, e.g. 2026-10-12T23:00:00Z" };
  }
  const at = new Date(value).getTime();
  if (Number.isNaN(at)) return { ok: false, error: `notBefore "${value}" is not a real date and time` };
  if (at <= now.getTime()) return { ok: false, error: "notBefore must be in the future" };
  if (at - now.getTime() > MAX_NOT_BEFORE_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `notBefore must be at most ${MAX_NOT_BEFORE_DAYS} days from now` };
  }
  return { ok: true, notBefore: new Date(at).toISOString() };
}
