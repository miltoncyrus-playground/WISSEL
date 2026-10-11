import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { deniedKeyGranted, finishResult, grantAndRetry, grantsToSuggest, resumeAfterReviewVerdict } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import type { TaskCard, TaskResult } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { parseReviewVerdict } from "../src/executors/parse-review-verdict.ts";
import { SqliteBoard } from "../src/services/board.ts";

// docs/proposal-agent-run-efficiency.md item 3. 2026-10-11, "Wissel app
// 5/6": from round 2 the reviewer wrote that the card "needs an
// allowed-tools grant ... for `bun run scripts/make-stt-fixtures.ts`",
// yet the loop pushed back 4 more times. Now the reviewer names the
// grant in its verdict, the card escalates at once with it offered, and
// "Grant and retry" continues in the same lineage and worktree.

const registry = await Registry.load();
const noRunner: CommandRunner = async () => {
  throw new Error("no command should run on these paths");
};
const FIXTURES = "Bash(bun run scripts/make-stt-fixtures.ts:*)";

const verdictBlock = (body: unknown) => "Reviewed.\n\n```review-verdict\n" + JSON.stringify(body) + "\n```";

test("parseReviewVerdict keeps grants on changes_requested only, and drops a malformed list instead of failing", () => {
  expect(parseReviewVerdict(verdictBlock({ verdict: "changes_requested", feedback: "f", grants: [FIXTURES, ` ${FIXTURES} `, ""] }))).toEqual({
    verdict: "changes_requested",
    feedback: "f",
    grants: [FIXTURES],
  });
  expect(parseReviewVerdict(verdictBlock({ verdict: "approve", feedback: "f", grants: [FIXTURES] }))).toEqual({ verdict: "approve", feedback: "f" });
  expect(parseReviewVerdict(verdictBlock({ verdict: "changes_requested", feedback: "f", grants: "Bash(x)" }))).toEqual({ verdict: "changes_requested", feedback: "f" });
  expect(parseReviewVerdict(verdictBlock({ verdict: "changes_requested", feedback: "f", grants: [3, null] }))).toEqual({ verdict: "changes_requested", feedback: "f" });
});

test("grantsToSuggest offers valid grants the card lacks and explains the refused ones", () => {
  const card = { extraAllowedTools: ["Bash(bun install:*)"] } as TaskCard;
  const out = grantsToSuggest([FIXTURES, "Bash(bun install:*)", "Bash(rm -rf:*)", "Bash(*)", FIXTURES], card);
  expect(out.grants).toEqual([FIXTURES]);
  expect(out.invalid).toHaveLength(2);
  expect(out.invalid[0]).toContain('"rm"');
  expect(grantsToSuggest(undefined, card)).toEqual({ grants: [], invalid: [] });
});

test("deniedKeyGranted matches a refusal to a grant for the same command", () => {
  expect(deniedKeyGranted("Bash: bun install", ["Bash(bun install:*)"])).toBe(true);
  expect(deniedKeyGranted("Bash: bun run scripts/make-stt-fixtures.ts", [FIXTURES])).toBe(true);
  expect(deniedKeyGranted("Bash: bun run", ["Bash(bun run build:app:*)"])).toBe(true);
  expect(deniedKeyGranted("Bash: bun run build:app", ["Bash(bun run:*)"])).toBe(true);
  expect(deniedKeyGranted("Bash: bun installer", ["Bash(bun install:*)"])).toBe(false);
  expect(deniedKeyGranted("Bash: npm install", ["Bash(bun install:*)"])).toBe(false);
  expect(deniedKeyGranted("Write", ["Bash(bun install:*)"])).toBe(false);
});

async function attempt(board: SqliteBoard, over: Partial<TaskCard> = {}): Promise<TaskCard> {
  const t = await board.create({ title: "Wissel app 5/6", body: "build voice", labels: ["code"], repo: "/tmp/repo", dependsOn: [], routedTo: "implementer", ...over });
  await board.move(t.id, "pending-review");
  return t;
}

async function review(board: SqliteBoard, implementer: TaskCard, verdict: Partial<TaskResult>) {
  await board.recordResult({ taskId: implementer.id, agentId: "implementer", ok: true, summary: "done", permissionDenials: ["Bash: bun run scripts/make-stt-fixtures.ts"] });
  const reviewer = await board.create({
    title: `Review: ${implementer.title}`,
    body: "review",
    labels: ["review"],
    repo: implementer.repo,
    dependsOn: [],
    parentTaskId: implementer.id,
    reviewLineageId: implementer.reviewLineageId ?? implementer.id,
    routedTo: "reviewer",
  });
  await board.move(reviewer.id, "done");
  const result: TaskResult = { taskId: reviewer.id, agentId: "reviewer", ok: true, summary: "no", verdict: "changes_requested", reviewFeedback: "commit the five fixture notes", ...verdict };
  await board.recordResult(result);
  const outcome = await resumeAfterReviewVerdict(board, registry, (await board.get(reviewer.id))!, result, noRunner);
  return { outcome, implementer: (await board.get(implementer.id))!, reviewer };
}

test("a review naming a valid grant escalates on the first round, with the grant offered", async () => {
  const board = new SqliteBoard();
  const { outcome, implementer } = await review(board, await attempt(board), { reviewGrants: [FIXTURES, "Bash(curl:*)"] });
  expect(outcome).toBe("escalated");
  expect(implementer.status).toBe("escalated");
  expect(implementer.supersededBy).toBeUndefined(); // no pushback round spent
  expect(implementer.suggestedGrants).toEqual([FIXTURES]);
  expect(implementer.escalationContext).toContain("Attempt 1: commit the five fixture notes");
  expect(implementer.escalationContext).toContain(`Needs a grant: the reviewer says the next attempt needs ${FIXTURES}`);
  expect(implementer.escalationContext).toContain('Not offered, as grants are refused: "Bash(curl:*)" grants "curl"');
});

test("a review naming only refused or already-held grants pushes back as before", async () => {
  const board = new SqliteBoard();
  const invalidOnly = await review(board, await attempt(board), { reviewGrants: ["Bash(rm -rf:*)"] });
  expect(invalidOnly.outcome).toBe("pushback");
  const held = await review(board, await attempt(board, { extraAllowedTools: [FIXTURES] }), { reviewGrants: [FIXTURES] });
  expect(held.outcome).toBe("pushback");
});

test("Grant and retry adds the grants and continues the same lineage from the latest review", async () => {
  const board = new SqliteBoard();
  const first = await attempt(board, { extraAllowedTools: ["Bash(bun install:*)"], model: "claude-opus-5-5" });
  const { implementer, reviewer } = await review(board, first, { reviewGrants: [FIXTURES] });

  const next = await grantAndRetry(board, implementer);
  if (typeof next === "string") throw new Error(next);
  expect(next.extraAllowedTools).toEqual(["Bash(bun install:*)", FIXTURES]);
  expect(next.model).toBe("claude-opus-5-5");
  expect(next.reviewLineageId).toBe(first.id); // same lineage, so the same worktree
  expect(next.parentTaskId).toBe(reviewer.id);
  expect(next.pushbackCount).toBe(1);
  expect(next.body).toContain("commit the five fixture notes");
  expect(next.body).toContain("granted since, so run them now: Bash: bun run scripts/make-stt-fixtures.ts");
  expect(next.body).not.toContain("Don't retry these");
  expect((await board.get(first.id))!.supersededBy).toBe(next.id);
  expect((await board.get(first.id))!.extraAllowedTools).toEqual(["Bash(bun install:*)", FIXTURES]);
});

test("Grant and retry refuses a card that isn't escalated, has nothing to grant, or would exceed the grant rules", async () => {
  const board = new SqliteBoard();
  const live = await attempt(board);
  expect(await grantAndRetry(board, live)).toBe("task is not escalated");

  const { implementer } = await review(board, await attempt(board), { reviewGrants: [FIXTURES] });
  expect(await grantAndRetry(board, { ...implementer, suggestedGrants: undefined })).toContain("no grants to add");
  expect(await grantAndRetry(board, implementer, ["Bash(sudo ls:*)"])).toContain('"sudo"');
  // Nothing changed on a refusal.
  expect((await board.get(implementer.id))!.supersededBy).toBeUndefined();
});

test("Grant and retry on a card escalated without a review falls back to an explanation", async () => {
  const board = new SqliteBoard();
  const card = await attempt(board);
  await board.escalate(card.id, "by hand", [FIXTURES]);
  expect(await grantAndRetry(board, (await board.get(card.id))!)).toContain("no review of this attempt");
});

test("the reviewer card is told what the implementer was refused", async () => {
  const board = new SqliteBoard();
  const card = await board.create({ title: "build", body: "the body", labels: ["code"], repo: "/tmp/repo", dependsOn: [] });
  await board.recordDecision({ taskId: card.id, matchedTags: [], candidates: [], selected: "implementer", confident: true, reason: "r", strategy: "manual", decidedAt: new Date().toISOString() });
  await finishResult(board, registry, { taskId: card.id, agentId: "implementer", ok: true, summary: "done", permissionDenials: ["Bash: bun run build:app"] }, undefined, noRunner);
  const reviewerCard = (await board.list()).find((t) => t.parentTaskId === card.id)!;
  expect(reviewerCard.body).toContain("the body");
  expect(reviewerCard.body).toContain("The implementer was refused these commands on this attempt: Bash: bun run build:app.");
});

test("POST /tasks/:id/escalation/grant-and-retry: 201 with the next attempt, 400 on bad input", async () => {
  const board = new SqliteBoard();
  const app = createApp(board, registry);
  const post = (id: string, body: unknown) =>
    app(new Request(`http://wissel.test/tasks/${id}/escalation/grant-and-retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const { implementer } = await review(board, await attempt(board), { reviewGrants: [FIXTURES] });

  expect((await post(implementer.id, { tools: "nope" })).status).toBe(400);
  const res = await post(implementer.id, {});
  expect(res.status).toBe(201);
  const next = (await res.json()) as TaskCard;
  expect(next.extraAllowedTools).toEqual([FIXTURES]);
  expect((await post(next.id, {})).status).toBe(400); // not escalated
  expect((await post("missing", {})).status).toBe(404);
});
