/**
 * Parses the reset time out of a claude-cli session-limit (429) error's
 * `result` text, e.g. "You've hit your session limit · resets 3:10pm
 * (UTC)" -> today (or tomorrow, if that clock time has already passed)
 * at 15:10 UTC. Pure and deterministic on purpose (see CLAUDE.md's
 * latent-vs-deterministic-space rule) — this is exactly the kind of
 * same-input-same-output text parsing that has no business being
 * re-derived by an LLM call.
 *
 * Returns `null` for anything that doesn't match this exact shape —
 * never guesses a time from partial or malformed text. `runClaude`
 * treats `null` as "not a retriable 429," falling back to a plain
 * failure rather than silently scheduling a retry with a bad timestamp.
 *
 * `now` is injectable so tests are deterministic regardless of wall
 * clock time — real callers omit it.
 */
export function parseSessionLimitReset(resultText: string, now: Date = new Date()): Date | null {
  const match = /resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/i.exec(resultText);
  if (!match) return null;

  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]!.toLowerCase();
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) return null;

  const hour24 = meridiem === "pm" ? (hour12 % 12) + 12 : hour12 % 12;

  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour24, minute, 0, 0));
  // The stated time has already passed today — a session limit that
  // resets "3:10pm" when it's currently 3:40pm means tomorrow's 3:10pm,
  // never a time already behind us.
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset;
}
