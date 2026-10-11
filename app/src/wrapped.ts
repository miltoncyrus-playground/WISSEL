// Wissel Wrapped's story cards (docs/SDD-wissel-app.md §3.6), pure: the
// You tab draws what this returns from GET /wrapped. The numbers are the
// server's (built on the retrospective's digest); this only words them.

import type { Wrapped } from "./types";

/** The periods the You tab offers. */
export const WRAPPED_PERIODS = [
  { input: "last 7 days", label: "7 days" },
  { input: "last 30 days", label: "30 days" },
] as const;

export type WrappedTone = "accent" | "violet" | "coral" | "plain";

export interface WrappedCard {
  /** Stable per card kind; also the PNG's file name part. */
  id: "intro" | "merged" | "runs" | "spend" | "streak" | "pipelines" | "lesson";
  kicker: string;
  /** The big line: a number, or the lesson's title. */
  big: string;
  /** Next to a number: "cards", "days"... */
  unit?: string;
  line: string;
  tone: WrappedTone;
  /** The streak card's last 7 days, oldest first. */
  week?: boolean[];
  /** The runs card's top agent, for its avatar. */
  agentId?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "Your week", "Your month", else "Your 12 days". */
export function periodTitle(days: number): string {
  if (days === 7) return "Your week";
  if (days === 30 || days === 31) return "Your month";
  return `Your ${days} ${plural(days, "day", "days")}`;
}

/** `2026-10-04` as "4 Oct". Read as a calendar date, never shifted by
 *  a time zone. */
export function shortDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/** Dollars with cents: "$12.30". */
export function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function wrappedCards(w: Wrapped, agentName: (id: string) => string): WrappedCard[] {
  const cards: WrappedCard[] = [
    {
      id: "intro",
      kicker: "Wissel Wrapped",
      big: periodTitle(w.period.days),
      line: `${shortDate(w.period.from)} to ${shortDate(w.period.to)}. Swipe for your numbers.`,
      tone: "violet",
    },
    {
      id: "merged",
      kicker: "Cards merged",
      big: String(w.cardsMerged),
      unit: plural(w.cardsMerged, "card", "cards"),
      line:
        w.cardsMerged === 0 && w.commits === 0
          ? "Nothing landed yet. Plenty of time."
          : `${w.commits} ${plural(w.commits, "commit", "commits")} across your repos.`,
      tone: "accent",
    },
    {
      id: "runs",
      kicker: "Agent runs",
      big: String(w.agentRuns),
      unit: plural(w.agentRuns, "run", "runs"),
      line: w.topAgent
        ? `Top agent: ${agentName(w.topAgent.id)}, ${w.topAgent.runs} ${plural(w.topAgent.runs, "run", "runs")}.`
        : "No paid runs yet, so no top agent.",
      tone: "plain",
      ...(w.topAgent ? { agentId: w.topAgent.id } : {}),
    },
    {
      id: "spend",
      kicker: "Spent",
      big: dollars(w.spendUsd),
      line: w.agentRuns > 0 && w.spendUsd > 0 ? `About ${dollars(w.spendUsd / w.agentRuns)} a run.` : "Nothing spent on models.",
      tone: "coral",
    },
    {
      id: "streak",
      kicker: "Merge streak",
      big: String(w.streak.current),
      unit: plural(w.streak.current, "day", "days"),
      line:
        w.streak.current === 0
          ? w.streak.best > 0
            ? `Best this year: ${w.streak.best} ${plural(w.streak.best, "day", "days")}. Merge a card to start again.`
            : "Merge a card to start one."
          : `${w.streak.today ? "Merged today." : "Merge today to keep it going."} Best: ${w.streak.best} ${plural(w.streak.best, "day", "days")}.`,
      tone: "accent",
      week: w.streak.week,
    },
    {
      id: "pipelines",
      kicker: "Pipelines added",
      big: String(w.pipelinesAdded.length),
      unit: plural(w.pipelinesAdded.length, "pipeline", "pipelines"),
      line: w.pipelinesAdded.length === 0 ? "No new pipelines." : listNames(w.pipelinesAdded.map((p) => p.name)),
      tone: "violet",
    },
  ];
  if (w.lesson) {
    cards.push({
      id: "lesson",
      kicker: "Lesson of the week",
      big: w.lesson.title,
      line: w.lesson.text,
      tone: "plain",
    });
  }
  return cards;
}

/** "A", "A and B", "A, B and 2 more". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** `wissel-wrapped-2026-10-11-streak.png`. */
export function pngFileName(w: Pick<Wrapped, "period">, card: Pick<WrappedCard, "id">): string {
  return `wissel-wrapped-${w.period.to}-${card.id}.png`;
}

/** The card a horizontal scroll position shows, clamped. */
export function cardIndexAt(scrollLeft: number, cardWidth: number, count: number): number {
  if (count <= 0 || cardWidth <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / cardWidth)));
}

/** True when the browser can share this file (Web Share level 2). */
export function canShareFile(nav: Pick<Navigator, "share" | "canShare"> | undefined, file: File): boolean {
  if (!nav || typeof nav.share !== "function") return false;
  if (typeof nav.canShare !== "function") return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}
