import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { parseDay, runReplay, type CoordinatorRecord } from "../src/services/replay.ts";

// docs/SDD-coordinator.md §8, phase 4 card 24: the replay eval runs a day
// through Wissel in Shadow and compares its would-records with what the
// coordinator did.

const FIX = join(import.meta.dir, "..", "eval", "fixtures");
const day = parseDay(readFileSync(join(FIX, "replay-day.jsonl"), "utf8"));
const expected = JSON.parse(readFileSync(join(FIX, "replay-day.expected.json"), "utf8")) as CoordinatorRecord;

describe("the replay eval", () => {
  test("the example day: Wissel would claim every started card and call exactly the clean, green, reviewed PRs ready; nothing breaks a hard limit", async () => {
    const r = await runReplay(day, expected, HarnessPool.from([]));
    expect(r.wissel).toEqual({ readyToMerge: ["A1", "A3"], claims: ["A1", "A2", "A3", "A4"] });
    expect([r.readyToMergeAgreement, r.claimsAgreement, r.hardLimitViolations, r.pass]).toEqual([1, 1, 0, true]);
    expect(r.events).toBe(18);
  });

  test("a disagreement is measured and named, and fails the target", async () => {
    const r = await runReplay(day, { readyToMerge: ["A1", "A2", "A3"], claims: ["A1"] }, HarnessPool.from([]));
    expect(r.missedReady).toEqual(["A2"]);
    expect(r.extraReady).toEqual([]);
    expect(r.readyToMergeAgreement).toBeCloseTo(2 / 3);
    expect(r.claimsAgreement).toBe(0.25);
    expect(r.pass).toBe(false);
  });

  test("the day file must be JSON lines; comment lines are skipped", () => {
    expect(parseDay("// note\n{\"type\":\"card\",\"key\":\"A1\",\"title\":\"x\"}\n")).toHaveLength(1);
    expect(() => parseDay("{\"type\":\"card\"}\nnot json")).toThrow("line 2 is not JSON");
  });
});
