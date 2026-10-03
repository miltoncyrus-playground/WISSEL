import { expect, test } from "bun:test";
import { formatMergeHealthBanner } from "../src/api/public/render-merge-health.js";

test("returns null (hidden) for an empty set", () => {
  expect(formatMergeHealthBanner([])).toBeNull();
});

test("returns null (hidden) for undefined/missing input", () => {
  expect(formatMergeHealthBanner(undefined)).toBeNull();
});

test("formats a single dangling merge with singular 'repo'", () => {
  const text = formatMergeHealthBanner([{ repo: "/home/m/code/wissel", branch: "feature-x" }]);
  expect(text).toContain("1 repo");
  expect(text).toContain("/home/m/code/wissel (feature-x)");
});

test("formats multiple dangling merges with plural 'repos', listing every one", () => {
  const text = formatMergeHealthBanner([
    { repo: "/repo-a", branch: "feature-x" },
    { repo: "/repo-b", branch: "deadbeef" },
  ]);
  expect(text).toContain("2 repos");
  expect(text).toContain("/repo-a (feature-x)");
  expect(text).toContain("/repo-b (deadbeef)");
});
