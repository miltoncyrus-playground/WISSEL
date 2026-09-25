import { expect, test } from "bun:test";
import { parsePipelineHandoff } from "../src/executors/parse-pipeline-handoff.ts";

test("parses a valid choose-shaped handoff with next, data, and note", () => {
  const raw = ["Implemented the feature.", "", "```pipeline-handoff", '{"next": "reviewer", "data": {"files": ["a.ts"]}, "note": "ready for review"}', "```"].join(
    "\n",
  );
  expect(parsePipelineHandoff(raw)).toEqual({ next: "reviewer", data: { files: ["a.ts"] }, note: "ready for review" });
});

test("parses a valid all/fan-out-shaped handoff with no next at all", () => {
  const raw = ["```pipeline-handoff", '{"data": {"branches": 3}}', "```"].join("\n");
  expect(parsePipelineHandoff(raw)).toEqual({ data: { branches: 3 } });
});

test("parses a valid handoff with nothing set at all — an empty object is well-formed", () => {
  const raw = ["```pipeline-handoff", "{}", "```"].join("\n");
  expect(parsePipelineHandoff(raw)).toEqual({});
});

test("returns null when the block is missing entirely", () => {
  expect(parsePipelineHandoff("Did the work, no block here.")).toBeNull();
});

test("returns null on malformed JSON inside the block", () => {
  const raw = ["```pipeline-handoff", '{"next": "reviewer"', "```"].join("\n");
  expect(parsePipelineHandoff(raw)).toBeNull();
});

test("returns null when next is present but not a non-empty string", () => {
  const emptyString = ["```pipeline-handoff", '{"next": ""}', "```"].join("\n");
  const wrongType = ["```pipeline-handoff", '{"next": 5}', "```"].join("\n");
  expect(parsePipelineHandoff(emptyString)).toBeNull();
  expect(parsePipelineHandoff(wrongType)).toBeNull();
});

test("returns null when data is present but not a plain object", () => {
  const array = ["```pipeline-handoff", '{"data": [1, 2]}', "```"].join("\n");
  const string = ["```pipeline-handoff", '{"data": "nope"}', "```"].join("\n");
  const nullValue = ["```pipeline-handoff", '{"data": null}', "```"].join("\n");
  expect(parsePipelineHandoff(array)).toBeNull();
  expect(parsePipelineHandoff(string)).toBeNull();
  expect(parsePipelineHandoff(nullValue)).toBeNull();
});

test("returns null when note is present but not a string", () => {
  const raw = ["```pipeline-handoff", '{"note": 42}', "```"].join("\n");
  expect(parsePipelineHandoff(raw)).toBeNull();
});

test("returns null on every shape that must never resolve to a guessed handoff", () => {
  const malformedInputs = [
    "",
    "next: reviewer",
    "```pipeline-handoff\n{\"next\": \"reviewer\"\n```", // truncated JSON
    "```pipeline-handoff\n[\"reviewer\"]\n```", // wrong shape (array, not object)
    "```pipeline-handoff\nnull\n```",
  ];
  for (const input of malformedInputs) {
    expect(parsePipelineHandoff(input)).toBeNull();
  }
});

test("takes the last pipeline-handoff block when more than one is present", () => {
  const raw = [
    "Example of the format:",
    "```pipeline-handoff",
    '{"next": "example-step"}',
    "```",
    "",
    "Actual handoff:",
    "```pipeline-handoff",
    '{"next": "reviewer"}',
    "```",
  ].join("\n");
  expect(parsePipelineHandoff(raw)).toEqual({ next: "reviewer" });
});

test("parses correctly even with prose before and after the block", () => {
  const raw = [
    "# Implementation notes",
    "",
    "I wrote the change and ran the tests.",
    "",
    "```pipeline-handoff",
    '{"next": "reviewer", "note": "all green"}',
    "```",
    "",
    "Handing off now.",
  ].join("\n");
  expect(parsePipelineHandoff(raw)).toEqual({ next: "reviewer", note: "all green" });
});
