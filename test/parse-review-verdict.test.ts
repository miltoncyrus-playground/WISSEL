import { expect, test } from "bun:test";
import { parseReviewVerdict } from "../src/executors/parse-review-verdict.ts";

test("parses a valid approve block", () => {
  const raw = [
    "Looks good, checked the diff against conventions.",
    "",
    "```review-verdict",
    '{"verdict": "approve", "feedback": "Matches existing patterns, no issues found."}',
    "```",
  ].join("\n");
  expect(parseReviewVerdict(raw)).toEqual({
    verdict: "approve",
    feedback: "Matches existing patterns, no issues found.",
  });
});

test("parses a valid changes_requested block", () => {
  const raw = [
    "```review-verdict",
    '{"verdict": "changes_requested", "feedback": "Missing a null check on line 42."}',
    "```",
  ].join("\n");
  expect(parseReviewVerdict(raw)).toEqual({
    verdict: "changes_requested",
    feedback: "Missing a null check on line 42.",
  });
});

test("returns null when the block is missing entirely", () => {
  const raw = "Looks good to me, ship it.";
  expect(parseReviewVerdict(raw)).toBeNull();
});

test("returns null on malformed JSON inside the block", () => {
  const raw = ["```review-verdict", '{"verdict": "approve", "feedback": "missing closing brace"', "```"].join("\n");
  expect(parseReviewVerdict(raw)).toBeNull();
});

test("parses correctly even with prose before and after the block", () => {
  const raw = [
    "# Review",
    "",
    "I read through the diff carefully and checked it against the repo's conventions.",
    "Everything lines up with the existing patterns.",
    "",
    "```review-verdict",
    '{"verdict": "approve", "feedback": "Clean diff, matches conventions."}',
    "```",
    "",
    "Thanks for the quick turnaround.",
  ].join("\n");
  expect(parseReviewVerdict(raw)).toEqual({
    verdict: "approve",
    feedback: "Clean diff, matches conventions.",
  });
});

test("malformed output never resolves to approve — the one thing this parser must never do", () => {
  const malformedInputs = [
    "",
    "approve",
    "I approve this change.",
    "```review-verdict\n{\"verdict\": \"approve\"\n```", // truncated JSON
    "```review-verdict\n{\"verdict\": \"approved\", \"feedback\": \"lgtm\"}\n```", // wrong literal
    "```review-verdict\n{\"feedback\": \"lgtm, approve\"}\n```", // missing verdict field
    "```review-verdict\n[\"approve\"]\n```", // wrong shape (array, not object)
    "```review-verdict\nnull\n```",
  ];
  for (const input of malformedInputs) {
    expect(parseReviewVerdict(input)).toBeNull();
  }
});

test("returns null when verdict is present but not one of the two allowed literals", () => {
  const raw = ['```review-verdict', '{"verdict": "reject", "feedback": "no"}', '```'].join("\n");
  expect(parseReviewVerdict(raw)).toBeNull();
});

test("returns null when feedback is missing or the wrong type", () => {
  const missingFeedback = ['```review-verdict', '{"verdict": "approve"}', '```'].join("\n");
  const wrongTypeFeedback = ['```review-verdict', '{"verdict": "approve", "feedback": 123}', '```'].join("\n");
  expect(parseReviewVerdict(missingFeedback)).toBeNull();
  expect(parseReviewVerdict(wrongTypeFeedback)).toBeNull();
});

test("takes the last review-verdict block when more than one is present", () => {
  const raw = [
    "Example of the format:",
    "```review-verdict",
    '{"verdict": "approve", "feedback": "example, ignore this one"}',
    "```",
    "",
    "Actual verdict:",
    "```review-verdict",
    '{"verdict": "changes_requested", "feedback": "real verdict"}',
    "```",
  ].join("\n");
  expect(parseReviewVerdict(raw)).toEqual({
    verdict: "changes_requested",
    feedback: "real verdict",
  });
});
