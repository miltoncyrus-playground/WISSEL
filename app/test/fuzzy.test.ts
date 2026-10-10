import { describe, expect, test } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../src/fuzzy";

describe("fuzzyScore", () => {
  test("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("   ", "anything")).toBe(0);
  });

  test("characters must appear in order", () => {
    expect(fuzzyScore("brd", "Board")).not.toBeNull();
    expect(fuzzyScore("dbr", "Board")).toBeNull();
    expect(fuzzyScore("x", "Board")).toBeNull();
  });

  test("is case-insensitive and ignores spaces in the query", () => {
    expect(fuzzyScore("BOARD", "board")).not.toBeNull();
    expect(fuzzyScore("ai news", "AINews podcast")).not.toBeNull();
  });

  test("a substring beats a scattered match", () => {
    expect(fuzzyScore("news", "Run AI news podcast")!).toBeGreaterThan(fuzzyScore("news", "New winter sale")!);
  });

  test("a match at a word start beats one mid-word", () => {
    expect(fuzzyScore("pod", "Run podcast")!).toBeGreaterThan(fuzzyScore("pod", "Run tripod")!);
  });

  test("initials across words match and beat a scattered mid-word match", () => {
    expect(fuzzyScore("anp", "AI news podcast")).not.toBeNull();
    expect(fuzzyScore("anp", "AI news podcast")!).toBeGreaterThan(fuzzyScore("anp", "Banana pie")!);
  });

  test("still matches when jumping to a word start would strand the rest", () => {
    // Preferring the word-start "a" in "ab" leaves no "c" after it; the
    // nearest-first fallback finds x-a-_-c.
    expect(fuzzyScore("ac", "xa_c ab")).not.toBeNull();
  });

  test("an earlier substring beats a later one", () => {
    expect(fuzzyScore("feed", "Feed")!).toBeGreaterThan(fuzzyScore("feed", "Open the feed")!);
  });
});

describe("fuzzyFilter", () => {
  const items = ["Feed", "Ask", "Board", "Listen", "You", "Run AI news podcast", "Fix the README"];

  test("empty query keeps every item in input order", () => {
    expect(fuzzyFilter("", items, (s) => s)).toEqual(items);
  });

  test("drops non-matches and ranks best first", () => {
    expect(fuzzyFilter("bo", items, (s) => s)[0]).toBe("Board");
    expect(fuzzyFilter("readme", items, (s) => s)).toEqual(["Fix the README"]);
    expect(fuzzyFilter("zzz", items, (s) => s)).toEqual([]);
  });

  test("ties keep input order", () => {
    expect(fuzzyFilter("a", ["ab", "ac"], (s) => s)).toEqual(["ab", "ac"]);
  });
});
