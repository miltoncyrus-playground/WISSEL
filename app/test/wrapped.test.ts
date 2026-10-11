import { describe, expect, test } from "vitest";
import type { Wrapped } from "../src/types";
import { canShareFile, cardIndexAt, dollars, listNames, periodTitle, pngFileName, shortDate, wrappedCards } from "../src/wrapped";

// docs/SDD-wissel-app.md §3.6: the You tab's Wrapped cards.

function wrapped(over: Partial<Wrapped> = {}): Wrapped {
  return {
    period: { input: "last 7 days", from: "2026-10-04", to: "2026-10-11", days: 7 },
    cardsMerged: 12,
    commits: 31,
    agentRuns: 48,
    spendUsd: 23.4,
    topAgent: { id: "implementer", runs: 20, spendUsd: 14.1 },
    pipelinesAdded: [{ id: "p1", name: "World news podcast" }],
    streak: { current: 5, best: 9, today: true, lastDay: "2026-10-11", week: [false, false, true, true, true, true, true] },
    lesson: { title: "Test the real path", text: "Mocks hid the bug twice.", runId: "r1" },
    ...over,
  };
}

const names = (id: string) => ({ implementer: "Implementer" })[id] ?? id;

describe("wrappedCards", () => {
  test("the full set, in order, worded from the numbers", () => {
    const cards = wrappedCards(wrapped(), names);
    expect(cards.map((c) => [c.id, c.kicker, c.big, c.unit ?? "", c.line])).toEqual([
      ["intro", "Wissel Wrapped", "Your week", "", "4 Oct to 11 Oct. Swipe for your numbers."],
      ["merged", "Cards merged", "12", "cards", "31 commits across your repos."],
      ["runs", "Agent runs", "48", "runs", "Top agent: Implementer, 20 runs."],
      ["spend", "Spent", "$23.40", "", "About $0.49 a run."],
      ["streak", "Merge streak", "5", "days", "Merged today. Best: 9 days."],
      ["pipelines", "Pipelines added", "1", "pipeline", "World news podcast"],
      ["lesson", "Lesson of the week", "Test the real path", "", "Mocks hid the bug twice."],
    ]);
    expect(cards.find((c) => c.id === "runs")!.agentId).toBe("implementer");
    expect(cards.find((c) => c.id === "streak")!.week).toEqual([false, false, true, true, true, true, true]);
  });

  test("an empty period: no top agent, no lesson card, nothing spent, a streak to start", () => {
    const cards = wrappedCards(
      wrapped({ cardsMerged: 0, commits: 0, agentRuns: 0, spendUsd: 0, topAgent: null, pipelinesAdded: [], lesson: null, streak: { current: 0, best: 0, today: false, lastDay: null, week: Array(7).fill(false) } }),
      names,
    );
    expect(cards.map((c) => c.id)).toEqual(["intro", "merged", "runs", "spend", "streak", "pipelines"]);
    const line = (id: string) => cards.find((c) => c.id === id)!.line;
    expect(line("merged")).toBe("Nothing landed yet. Plenty of time.");
    expect(line("runs")).toBe("No paid runs yet, so no top agent.");
    expect(cards.find((c) => c.id === "runs")!.agentId).toBeUndefined();
    expect(line("spend")).toBe("Nothing spent on models.");
    expect(line("streak")).toBe("Merge a card to start one.");
    expect(line("pipelines")).toBe("No new pipelines.");
  });

  test("singulars, and a streak alive from yesterday or broken", () => {
    const one = wrappedCards(wrapped({ cardsMerged: 1, commits: 1, agentRuns: 1, topAgent: { id: "x", runs: 1, spendUsd: 1 }, streak: { current: 1, best: 1, today: false, lastDay: "2026-10-10", week: Array(7).fill(false) } }), names);
    const get = (id: string) => one.find((c) => c.id === id)!;
    expect([get("merged").unit, get("merged").line]).toEqual(["card", "1 commit across your repos."]);
    expect([get("runs").unit, get("runs").line]).toEqual(["run", "Top agent: x, 1 run."]);
    expect([get("streak").unit, get("streak").line]).toEqual(["day", "Merge today to keep it going. Best: 1 day."]);
    const broken = wrappedCards(wrapped({ streak: { current: 0, best: 4, today: false, lastDay: "2026-10-01", week: Array(7).fill(false) } }), names);
    expect(broken.find((c) => c.id === "streak")!.line).toBe("Best this year: 4 days. Merge a card to start again.");
  });

  test("no em dashes in any card copy", () => {
    for (const c of wrappedCards(wrapped(), names)) expect(JSON.stringify(c)).not.toContain("—");
  });
});

describe("helpers", () => {
  test("periodTitle", () => {
    expect(periodTitle(7)).toBe("Your week");
    expect(periodTitle(30)).toBe("Your month");
    expect(periodTitle(1)).toBe("Your 1 day");
    expect(periodTitle(12)).toBe("Your 12 days");
  });

  test("shortDate reads the calendar date as is, no time zone shift", () => {
    expect(shortDate("2026-10-04")).toBe("4 Oct");
    expect(shortDate("2026-01-31")).toBe("31 Jan");
    expect(shortDate("2026-12-01")).toBe("1 Dec");
    expect(shortDate("soon")).toBe("soon");
  });

  test("dollars and listNames", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(12.3)).toBe("$12.30");
    expect(listNames([])).toBe("");
    expect(listNames(["A"])).toBe("A");
    expect(listNames(["A", "B"])).toBe("A and B");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
    expect(listNames(["A", "B", "C", "D", "E"])).toBe("A, B and 3 more");
  });

  test("pngFileName", () => {
    expect(pngFileName(wrapped(), { id: "streak" })).toBe("wissel-wrapped-2026-10-11-streak.png");
  });

  test("cardIndexAt rounds to the nearest card and clamps", () => {
    expect(cardIndexAt(0, 390, 7)).toBe(0);
    expect(cardIndexAt(390 * 2 + 150, 390, 7)).toBe(2);
    expect(cardIndexAt(390 * 2 + 250, 390, 7)).toBe(3);
    expect(cardIndexAt(99_999, 390, 7)).toBe(6);
    expect(cardIndexAt(-20, 390, 7)).toBe(0);
    expect(cardIndexAt(100, 0, 7)).toBe(0);
    expect(cardIndexAt(100, 390, 0)).toBe(0);
  });

  test("canShareFile: needs share and canShare, and canShare saying yes", () => {
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    const share = async () => {};
    expect(canShareFile(undefined, file)).toBe(false);
    expect(canShareFile({ share: undefined as never, canShare: () => true }, file)).toBe(false);
    expect(canShareFile({ share, canShare: undefined as never }, file)).toBe(false);
    expect(canShareFile({ share, canShare: () => false }, file)).toBe(false);
    expect(canShareFile({ share, canShare: () => { throw new Error("no"); } }, file)).toBe(false);
    expect(canShareFile({ share, canShare: (d) => d?.files?.[0] === file }, file)).toBe(true);
  });
});
