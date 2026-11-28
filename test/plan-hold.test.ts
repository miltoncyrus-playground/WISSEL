import { describe, expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { DEFAULT_PLAN_HOLD_MINUTES, holdCard, isHeld, planHoldMinutes, planStartsAt, plannedCards, releaseCard } from "../src/services/plan-hold.ts";
import { describeCondition, StartConditionChecker, startConditionsError } from "../src/services/start-conditions.ts";

// docs/SDD-coordinator.md §4.14: plans that start unless held.

const now = new Date("2026-11-28T09:30:00Z");

describe("the hold window", () => {
  test("WISSEL_PLAN_HOLD_MINUTES: default 10, 0 starts at once, nonsense falls back", () => {
    expect(planHoldMinutes({})).toBe(DEFAULT_PLAN_HOLD_MINUTES);
    expect(planHoldMinutes({ WISSEL_PLAN_HOLD_MINUTES: "0" })).toBe(0);
    expect(planHoldMinutes({ WISSEL_PLAN_HOLD_MINUTES: "30" })).toBe(30);
    expect(planHoldMinutes({ WISSEL_PLAN_HOLD_MINUTES: "-1" })).toBe(DEFAULT_PLAN_HOLD_MINUTES);
    expect(planHoldMinutes({ WISSEL_PLAN_HOLD_MINUTES: "soon" })).toBe(DEFAULT_PLAN_HOLD_MINUTES);
    expect(planStartsAt(now, 10)).toBe("2026-11-28T09:40:00.000Z");
    expect(planStartsAt(now, 0)).toBeUndefined();
  });
});

describe("the held start condition", () => {
  test("accepted with only at; never met; described plainly", async () => {
    const exists = async () => true;
    expect(await startConditionsError([{ kind: "held" }], exists)).toBeUndefined();
    expect(await startConditionsError([{ kind: "held", at: now.toISOString() }], exists)).toBeUndefined();
    expect(await startConditionsError([{ kind: "held", by: "me" }], exists)).toContain("held takes only at");
    expect(await startConditionsError([{ kind: "held", at: "later" }], exists)).toContain("held.at");
    const checker = new StartConditionChecker({ runner: async () => ({ exitCode: 1, stdout: "", stderr: "" }) });
    expect(await checker.firstUnmet([{ kind: "held" }], new Map(), (t) => t)).toEqual({ kind: "held" });
    expect(describeCondition({ kind: "held" })).toBe("released (it is held)");
  });
});

describe("Hold and Release", () => {
  async function planned(board: SqliteBoard, over: Record<string, unknown> = {}) {
    return board.create({ title: "Add the export", body: "b", labels: [], repo: "/tmp/repo", dependsOn: [], workstreamId: "ws1", key: "A5", notBefore: "2026-11-28T09:40:00.000Z", ...over });
  }

  test("Hold adds the condition once; Release removes it and clears the start time", async () => {
    const board = new SqliteBoard();
    const card = await planned(board, { waitsFor: [{ kind: "card-done", cardId: "x" }] });
    const held = await holdCard(board, card, now);
    expect(held.ok).toBe(true);
    const after = (await board.get(card.id))!;
    expect(isHeld(after)).toBe(true);
    expect(after.waitsFor).toEqual([{ kind: "card-done", cardId: "x" }, { kind: "held", at: now.toISOString() }]);
    expect(await holdCard(board, after, now)).toMatchObject({ ok: true });
    expect((await board.get(card.id))!.waitsFor).toHaveLength(2);

    const released = await releaseCard(board, (await board.get(card.id))!);
    expect(released.ok).toBe(true);
    const free = (await board.get(card.id))!;
    expect(free.waitsFor).toEqual([{ kind: "card-done", cardId: "x" }]);
    expect(free.notBefore).toBeUndefined();
    expect(await releaseCard(board, free)).toEqual({ ok: false, status: 409, error: "this card isn't held" });
  });

  test("a card that started can't be held", async () => {
    const board = new SqliteBoard();
    const card = await planned(board);
    await board.move(card.id, "running");
    const r = await holdCard(board, (await board.get(card.id))!, now);
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as { error: string }).error).toContain("only a card that hasn't started can be held");
  });

  test("plannedCards: the workstream's cards that haven't started, with when or held", async () => {
    const board = new SqliteBoard();
    const a = await planned(board);
    const b = await planned(board, { key: "A6", title: "Split the form" });
    await holdCard(board, b, now);
    const due = await planned(board, { key: "A7", title: "Due now", notBefore: "2026-11-28T09:00:00.000Z" });
    await planned(board, { key: "B1", title: "Elsewhere", workstreamId: "ws2" });
    const started = await planned(board, { key: "A8", title: "Running" });
    await board.move(started.id, "running");
    expect(plannedCards(await board.list(), "ws1", now)).toEqual([
      { id: a.id, key: "A5", title: "Add the export", held: false, startsAt: "2026-11-28T09:40:00.000Z" },
      { id: b.id, key: "A6", title: "Split the form", held: true },
      { id: due.id, key: "A7", title: "Due now", held: false },
    ]);
  });
});
