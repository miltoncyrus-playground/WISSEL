import { expect, test } from "bun:test";
import { CASES, judgeCase } from "../eval/review-grants.eval.ts";
import type { TaskCard, TaskResult } from "../src/core/types.ts";

// eval:review-grants' judge, checked for free: each case passes a right
// outcome and fails the wrong ones.

const c = (name: string) => CASES.find((x) => x.name === name)!;
const card = (over: Partial<TaskCard>): TaskCard => ({ id: "i", title: "t", body: "b", labels: [], status: "pending-review", ...over });
const verdict = (over: Partial<TaskResult>): TaskResult => ({ taskId: "r", agentId: "reviewer", ok: true, summary: "x", verdict: "changes_requested", reviewFeedback: "f", ...over });

test("needs-grant: right only when escalated with a grant for the script", () => {
  const g = "Bash(bun run scripts/make-notes.ts:*)";
  expect(judgeCase(c("needs-grant"), card({ status: "escalated", suggestedGrants: [g] }), verdict({ reviewGrants: [g] }))).toBeNull();
  expect(judgeCase(c("needs-grant"), card({ supersededBy: "n" }), verdict({}))).toContain("wanted escalated");
  expect(judgeCase(c("needs-grant"), card({ status: "escalated", suggestedGrants: ["Bash(bun install:*)"] }), verdict({ reviewGrants: ["Bash(bun install:*)"] }))).toContain("no suggested grant mentions make-notes");
});

test("code-bug: right only as a pushback with no grant", () => {
  expect(judgeCase(c("code-bug"), card({ supersededBy: "n" }), verdict({}))).toBeNull();
  expect(judgeCase(c("code-bug"), card({ status: "escalated" }), verdict({ reviewGrants: ["Bash(curl:*)"] }))).toContain("wanted no grants");
  expect(judgeCase(c("code-bug"), card({ status: "review" }), verdict({ verdict: "approve" }))).toContain("wanted a pushback");
});

test("clean: right only as an approve with no grant", () => {
  expect(judgeCase(c("clean"), card({ status: "review" }), verdict({ verdict: "approve" }))).toBeNull();
  expect(judgeCase(c("clean"), card({ supersededBy: "n" }), verdict({}))).toContain("wanted approve");
});
