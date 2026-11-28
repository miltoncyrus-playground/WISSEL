import { describe, expect, test } from "bun:test";
import { DECISION_CASES, judgeDecision } from "../eval/decision-quality-cases.ts";
import { decisionBrief, parseDecision } from "../src/services/decisions.ts";

// The decision-quality eval's judge (eval/decision-quality.eval.ts), for
// free: every case's right answer agrees, its wrong one doesn't, and both
// survive the real parser, so the eval only measures the model.

describe("the decision-quality cases", () => {
  test("ten cases, every implemented kind at least once, unique names", () => {
    expect(DECISION_CASES).toHaveLength(10);
    expect(new Set(DECISION_CASES.map((c) => c.name)).size).toBe(10);
    expect(new Set(DECISION_CASES.map((c) => c.kind))).toEqual(new Set(["plan-batch", "decide-default", "triage-red", "resolve-conflict", "read-owner-comments"]));
  });

  for (const c of DECISION_CASES) {
    test(`${c.name}: the right answer agrees, the wrong one doesn't`, () => {
      const block = (o: object) => "```decision\n" + JSON.stringify(o) + "\n```";
      const right = parseDecision(block(c.right), c.kind);
      const wrong = parseDecision(block(c.wrong), c.kind);
      expect(right).not.toBeNull();
      expect(judgeDecision(c, right)).toEqual({ valid: true, agrees: true, why: "agrees" });
      if (wrong) expect(judgeDecision(c, wrong)).toMatchObject({ valid: true, agrees: false });
      else expect(judgeDecision(c, wrong).valid).toBe(false);
      // The brief the decider gets fences the case's context.
      expect(decisionBrief(c.kind, c.context, "n")).toContain("```untrusted-n");
    });
  }

  test("no answer, or the wrong kind, is invalid", () => {
    const c = DECISION_CASES[0]!;
    expect(judgeDecision(c, null)).toEqual({ valid: false, agrees: false, why: "no valid decision block" });
    expect(judgeDecision(c, { kind: "decide-default", text: "t", alternative: "a", lean: "l" }).valid).toBe(false);
  });
});
