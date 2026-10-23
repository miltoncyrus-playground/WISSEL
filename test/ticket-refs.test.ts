import { expect, test } from "bun:test";
import { extractTicketKey, patternError, referencesOf, ticketKeyOf } from "../src/services/ticket-refs.ts";

test("the default finds a PROJ-123 key in a branch, a title and a commit subject", () => {
  expect(extractTicketKey("spec/ABC-943-desks")).toBe("ABC-943");
  expect(extractTicketKey("feat/ABC-940-04b-comments")).toBe("ABC-940");
  expect(extractTicketKey("Approval pins (ABC-929) (#77)")).toBe("ABC-929");
  expect(extractTicketKey("ABC-12: fix the thing")).toBe("ABC-12");
});

test("no key, and a lowercase look-alike, find nothing", () => {
  expect(extractTicketKey("chore/dec-019-rollout")).toBeUndefined();
  expect(extractTicketKey("main")).toBeUndefined();
  expect(extractTicketKey(undefined)).toBeUndefined();
  expect(extractTicketKey("")).toBeUndefined();
});

test("a project's own pattern replaces the default", () => {
  expect(extractTicketKey("spec/ABC-943-desks and XYZ-7", ["XYZ-\\d+"])).toBe("XYZ-7");
  expect(extractTicketKey("spec/XYZ-943-desks", ["ABC-\\d+"])).toBeUndefined();
});

test("the first text with a key wins, in the order given", () => {
  expect(ticketKeyOf([undefined, "main", "feat/ABC-2-x", "ABC-9"])).toBe("ABC-2");
  expect(ticketKeyOf(["no key", undefined])).toBeUndefined();
});

test("references that are not tickets come back distinct, only when patterns are set", () => {
  const texts = ["chore/DEC-019-rollout", "I-03-15d workflow gate", "DEC-019 again"];
  expect(referencesOf(texts)).toEqual([]);
  expect(referencesOf(texts, ["DEC-\\d+", "I-\\d+-\\d+\\w*"])).toEqual(["DEC-019", "I-03-15d"]);
});

test("bad patterns are refused, and skipped (not thrown on) at match time", () => {
  expect(patternError("ABC-\\d+")).toBeUndefined();
  expect(patternError("")).toContain("non-empty");
  expect(patternError("(")).toContain("not a valid regular expression");
  expect(patternError("(a+)+$")).toContain("repeats a repeated group");
  expect(patternError("x".repeat(81))).toContain("over 80");
  expect(extractTicketKey("ABC-1", ["("])).toBeUndefined();
});
