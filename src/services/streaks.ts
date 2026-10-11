import { existsSync } from "node:fs";
import type { TaskCard } from "../core/types.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { boardRepos, parseMergeSubject, readGitLog } from "./wissel-digest.ts";

/**
 * Streaks for Wissel Wrapped (docs/SDD-wissel-app.md §3.6): consecutive
 * local days with at least one merged card, read from git's
 * `Merge wissel/<id>: ...` commits in the board's repos. Git goes through
 * wissel-digest.ts's readGitLog and boardRepos, so it is the same
 * read-only command (assertReadOnlyGit), the same repos and the same
 * merge-subject rule as the digest: no second reading of git.
 *
 * Days are the server's local days, like the feed's "today". A streak
 * still counts through a day with no merge yet: today only breaks it once
 * today is over.
 */

/** How far back a streak is looked for. */
export const STREAK_LOOKBACK_DAYS = 366;

export interface Streak {
  /** Days in a row with a merge, ending today, or yesterday when today
   *  has none yet; 0 when neither has one. */
  current: number;
  /** The longest run in the lookback, at least `current`. */
  best: number;
  /** A card was merged today. */
  today: boolean;
  /** The last day with a merge (YYYY-MM-DD, local), or null. */
  lastDay: string | null;
  /** The last 7 local days, oldest first: true when one had a merge. */
  week: boolean[];
}

/** YYYY-MM-DD of a time in the server's local time zone. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The local day `n` days after `day` (negative goes back). Built from
 *  calendar fields, so a DST change never skips or repeats a day. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + n, 12).getTime());
}

/** The streak from the set of local days that had a merge. Pure. */
export function computeStreak(days: Iterable<string>, now: Date): Streak {
  const set = new Set(days);
  const today = localDay(now.getTime());
  const hasToday = set.has(today);
  let current = 0;
  for (let day = hasToday ? today : addDays(today, -1); set.has(day); day = addDays(day, -1)) current++;

  const sorted = [...set].filter((d) => d <= today).sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && addDays(sorted[i - 1]!, 1) === sorted[i] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return {
    current,
    best: Math.max(best, current),
    today: hasToday,
    lastDay: sorted.at(-1) ?? null,
    week: Array.from({ length: 7 }, (_, i) => set.has(addDays(today, i - 6))),
  };
}

export interface StreakInputs {
  /** The board's cards; their repos are the ones read (boardRepos). */
  cards: readonly TaskCard[];
  /** Only ever given read-only git commands. */
  runner: CommandRunner;
  now: Date;
  worktreesRoot?: string;
}

/** The local days with a wissel merge commit in the lookback. */
export async function mergeDays(inp: StreakInputs): Promise<Set<string>> {
  const from = new Date(inp.now.getTime() - STREAK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const days = new Set<string>();
  for (const repo of boardRepos(inp.cards, { worktreesRoot: inp.worktreesRoot })) {
    if (!existsSync(repo)) continue;
    const log = await readGitLog(inp.runner, repo, from, inp.now, { mergesOnly: true });
    for (const e of log ?? []) {
      const t = Date.parse(e.date);
      if (parseMergeSubject(e.subject) && !Number.isNaN(t)) days.add(localDay(t));
    }
  }
  return days;
}

export async function readStreak(inp: StreakInputs): Promise<Streak> {
  return computeStreak(await mergeDays(inp), inp.now);
}
