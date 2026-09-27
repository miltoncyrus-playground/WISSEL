import { expect, test } from "bun:test";
import { parseSubtaskPlan } from "../src/executors/parse-subtask-plan.ts";

test("parses a valid multi-item plan with chained dependsOnIndex", () => {
  const raw = [
    "Here's the decomposition:",
    "",
    "```subtask-plan",
    JSON.stringify([
      { title: "Add types", body: "Add SubtaskPlanItem to types.ts.", labels: ["code"] },
      { title: "Add parser", body: "Add parse-subtask-plan.ts.", labels: ["code"], dependsOnIndex: 0 },
      { title: "Wire orchestrator", body: "Wire it into finishResult.", labels: ["code"], dependsOnIndex: 1 },
    ]),
    "```",
  ].join("\n");
  expect(parseSubtaskPlan(raw)).toEqual([
    { title: "Add types", body: "Add SubtaskPlanItem to types.ts.", labels: ["code"] },
    { title: "Add parser", body: "Add parse-subtask-plan.ts.", labels: ["code"], dependsOnIndex: 0 },
    { title: "Wire orchestrator", body: "Wire it into finishResult.", labels: ["code"], dependsOnIndex: 1 },
  ]);
});

test("returns null when the block is missing entirely", () => {
  expect(parseSubtaskPlan("Here's my plan: do the thing.")).toBeNull();
});

test("returns null on malformed JSON inside the block", () => {
  const raw = ["```subtask-plan", '[{"title": "x", "body": "y", "labels": []}', "```"].join("\n");
  expect(parseSubtaskPlan(raw)).toBeNull();
});

test("returns null when the JSON is valid but not an array", () => {
  const raw = ["```subtask-plan", '{"title": "x", "body": "y", "labels": []}', "```"].join("\n");
  expect(parseSubtaskPlan(raw)).toBeNull();
});

test("returns null when an item is missing title, body, or labels", () => {
  const missingTitle = ["```subtask-plan", '[{"body": "y", "labels": []}]', "```"].join("\n");
  const missingBody = ["```subtask-plan", '[{"title": "x", "labels": []}]', "```"].join("\n");
  const missingLabels = ["```subtask-plan", '[{"title": "x", "body": "y"}]', "```"].join("\n");
  const emptyTitle = ["```subtask-plan", '[{"title": "", "body": "y", "labels": []}]', "```"].join("\n");
  const wrongTypeLabels = ["```subtask-plan", '[{"title": "x", "body": "y", "labels": ["a", 1]}]', "```"].join("\n");
  expect(parseSubtaskPlan(missingTitle)).toBeNull();
  expect(parseSubtaskPlan(missingBody)).toBeNull();
  expect(parseSubtaskPlan(missingLabels)).toBeNull();
  expect(parseSubtaskPlan(emptyTitle)).toBeNull();
  expect(parseSubtaskPlan(wrongTypeLabels)).toBeNull();
});

test("returns null when dependsOnIndex points forward or at itself", () => {
  const forward = [
    "```subtask-plan",
    JSON.stringify([
      { title: "a", body: "a", labels: [], dependsOnIndex: 1 },
      { title: "b", body: "b", labels: [] },
    ]),
    "```",
  ].join("\n");
  const selfRef = [
    "```subtask-plan",
    JSON.stringify([
      { title: "a", body: "a", labels: [] },
      { title: "b", body: "b", labels: [], dependsOnIndex: 1 },
    ]),
    "```",
  ].join("\n");
  expect(parseSubtaskPlan(forward)).toBeNull();
  expect(parseSubtaskPlan(selfRef)).toBeNull();
});

test("returns null when dependsOnIndex is negative or not an integer", () => {
  const negative = [
    "```subtask-plan",
    JSON.stringify([
      { title: "a", body: "a", labels: [] },
      { title: "b", body: "b", labels: [], dependsOnIndex: -1 },
    ]),
    "```",
  ].join("\n");
  const notInteger = [
    "```subtask-plan",
    JSON.stringify([
      { title: "a", body: "a", labels: [] },
      { title: "b", body: "b", labels: [], dependsOnIndex: 0.5 },
    ]),
    "```",
  ].join("\n");
  expect(parseSubtaskPlan(negative)).toBeNull();
  expect(parseSubtaskPlan(notInteger)).toBeNull();
});

test("takes the last subtask-plan block when more than one is present (a model that thinks out loud)", () => {
  const raw = [
    "Example of the format:",
    "```subtask-plan",
    JSON.stringify([{ title: "example, ignore this one", body: "b", labels: [] }]),
    "```",
    "",
    "Actual plan:",
    "```subtask-plan",
    JSON.stringify([{ title: "real subtask", body: "b", labels: ["code"] }]),
    "```",
  ].join("\n");
  expect(parseSubtaskPlan(raw)).toEqual([{ title: "real subtask", body: "b", labels: ["code"] }]);
});

test("an empty array is a valid (empty) plan", () => {
  const raw = ["```subtask-plan", "[]", "```"].join("\n");
  expect(parseSubtaskPlan(raw)).toEqual([]);
});

test("parses correctly when an item's own body embeds a nested fenced code sample (the real bug this parser once had)", () => {
  // Caught live: a planner run decomposing "Add/import projects" put a
  // TypeScript interface snippet (its own ```/``` fence) inside its
  // first item's `body` field — legitimate, useful prose for the
  // implementer who reads it. The old non-greedy regex
  // (`/```subtask-plan\s*\n([\s\S]*?)```/g`) stopped at THAT nested
  // closing fence instead of the block's real end, truncating the
  // capture mid-string and failing every plan shaped like this one.
  const nestedSnippetBody = [
    "Add a Project type:",
    "```",
    "export interface Project {",
    "  id: string;",
    "}",
    "```",
    "Then wire it in.",
  ].join("\n");
  const raw = [
    "Decomposed into 2 subtasks.",
    "",
    "```subtask-plan",
    JSON.stringify([
      { title: "Core model", body: nestedSnippetBody, labels: ["code"] },
      { title: "Wire it up", body: "Depends on the model above.", labels: ["code"], dependsOnIndex: 0 },
    ]),
    "```",
  ].join("\n");

  expect(parseSubtaskPlan(raw)).toEqual([
    { title: "Core model", body: nestedSnippetBody, labels: ["code"] },
    { title: "Wire it up", body: "Depends on the model above.", labels: ["code"], dependsOnIndex: 0 },
  ]);
});

test("multiple items each embedding their own nested fenced code sample still parse correctly", () => {
  const bodyA = ["Snippet A:", "```", "const a = 1;", "```"].join("\n");
  const bodyB = ["Snippet B:", "```", "const b = 2;", "```"].join("\n");
  const raw = [
    "```subtask-plan",
    JSON.stringify([
      { title: "a", body: bodyA, labels: [] },
      { title: "b", body: bodyB, labels: [], dependsOnIndex: 0 },
    ]),
    "```",
  ].join("\n");

  expect(parseSubtaskPlan(raw)).toEqual([
    { title: "a", body: bodyA, labels: [] },
    { title: "b", body: bodyB, labels: [], dependsOnIndex: 0 },
  ]);
});
