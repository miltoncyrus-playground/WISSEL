import { describe, expect, test } from "bun:test";
import { blockingFindings, resumeAfterReviewVerdict } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { parseReviewVerdict } from "../src/executors/parse-review-verdict.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { CARD_RULES_HEADING } from "../src/core/card-templates.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { MergeContext } from "../src/services/worktree.ts";
import type { ReviewPolicy, TaskCard, TaskResult } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.6, phase 2 card 8: severity counts on the
// verdict, a project's review policy (rounds, blocking severities, what
// happens at the cap), and fix rounds built from the full review through
// the project's fix-round template.

const registry = await Registry.load();
const noRunner: CommandRunner = async () => {
  throw new Error("no command should run on these paths");
};

function ctx(policy?: ReviewPolicy, fixRoundTemplate?: string, cardRules?: string): MergeContext {
  return { runner: noRunner, reviewPolicyFor: async () => ({ policy, fixRoundTemplate, cardRules }) };
}

async function round(board: SqliteBoard, verdict: Partial<TaskResult>, c: MergeContext, over: Partial<TaskCard> = {}) {
  const implementer = await board.create({ title: "Add retries", body: "Retry the import.", labels: ["code"], repo: "/tmp/repo", dependsOn: [], key: "A4", ...over });
  await board.move(implementer.id, "pending-review");
  await board.recordResult({ taskId: implementer.id, agentId: "implementer", ok: true, summary: "done" });
  const reviewer = await board.create({ title: "Review: Add retries", body: "review", labels: ["review"], repo: "/tmp/repo", dependsOn: [], parentTaskId: implementer.id, reviewLineageId: implementer.reviewLineageId ?? implementer.id, routedTo: "reviewer" });
  await board.move(reviewer.id, "done");
  const result: TaskResult = { taskId: reviewer.id, agentId: "reviewer", ok: true, summary: "reviewed", verdict: "changes_requested", reviewFeedback: "Handle the empty file.", ...verdict };
  await board.recordResult(result);
  const outcome = await resumeAfterReviewVerdict(board, registry, (await board.get(reviewer.id))!, result, c);
  const after = (await board.get(implementer.id))!;
  const next = after.supersededBy ? await board.get(after.supersededBy) : undefined;
  return { outcome, implementer: after, next };
}

describe("the verdict's severity counts", () => {
  test("parsed when well-formed, dropped (never failing the verdict) when not", () => {
    const block = (o: object) => "```review-verdict\n" + JSON.stringify(o) + "\n```";
    expect(parseReviewVerdict(block({ verdict: "approve", feedback: "ok", severity: { high: 0, med: 2, medWithScenario: 5, low: 1 } }))).toEqual({ verdict: "approve", feedback: "ok", severity: { high: 0, med: 2, medWithScenario: 2, low: 1 } });
    expect(parseReviewVerdict(block({ verdict: "approve", feedback: "ok", severity: { high: -1, med: 0 } }))).toEqual({ verdict: "approve", feedback: "ok" });
    expect(parseReviewVerdict(block({ verdict: "approve", feedback: "ok", severity: "none" }))).toEqual({ verdict: "approve", feedback: "ok" });
  });

  test("blockingFindings: only what the policy blocks counts", () => {
    expect(blockingFindings({ high: 2, med: 1 }, ["HIGH"])).toBe("2 HIGH findings");
    expect(blockingFindings({ high: 0, med: 1 }, ["HIGH", "MED"])).toBe("1 finding");
    expect(blockingFindings({ high: 0, med: 3, medWithScenario: 1 }, ["MED-with-scenario"])).toBe("1 finding");
    expect(blockingFindings({ high: 0, med: 3, medWithScenario: 0 }, ["MED-with-scenario"])).toBeUndefined();
    expect(blockingFindings({ high: 5, med: 5 }, undefined)).toBeUndefined();
  });
});

describe("the reviewPolicy setting", () => {
  test("stored when valid; unknown fields and bad values refused; empty clears", () => {
    expect(validateProjectSettings({ reviewPolicy: { maxRounds: 2, blocks: ["HIGH", "HIGH"], atCap: "spec-question" } })).toEqual({ ok: true, patch: { reviewPolicy: { maxRounds: 2, blocks: ["HIGH"], atCap: "spec-question" } } });
    expect(validateProjectSettings({ reviewPolicy: {} })).toEqual({ ok: true, patch: { reviewPolicy: null } });
    expect(validateProjectSettings({ reviewPolicy: { maxRounds: 11 } }).ok).toBe(false);
    expect(validateProjectSettings({ reviewPolicy: { blocks: ["LOW"] } }).ok).toBe(false);
    expect(validateProjectSettings({ reviewPolicy: { atCap: "merge" } }).ok).toBe(false);
    expect(validateProjectSettings({ reviewPolicy: { reviewers: [] } })).toMatchObject({ ok: false, error: expect.stringContaining('"reviewers"') });
    // Card 8b: tiers, carryForward, keepPass and otherModels.
    expect(validateProjectSettings({ reviewPolicy: { tiers: [] } })).toEqual({ ok: true, patch: { reviewPolicy: null } });
  });
});

describe("a verdict under the policy", () => {
  test("an approval with a blocking finding becomes a fix round that says why", async () => {
    const { outcome, next } = await round(new SqliteBoard(), { verdict: "approve", reviewFeedback: "Looks fine, one HIGH: the lock leaks.", reviewSeverity: { high: 1, med: 0 } }, ctx({ blocks: ["HIGH"] }));
    expect(outcome).toBe("pushback");
    expect(next!.body).toContain("the lock leaks.");
    expect(next!.body).toContain("the project's review policy blocks 1 finding");
  });

  test("an approval with nothing blocking still approves", async () => {
    const { outcome } = await round(new SqliteBoard(), { verdict: "approve", reviewFeedback: "ok", reviewSeverity: { high: 0, med: 2 } }, ctx({ blocks: ["HIGH"] }));
    expect(outcome).not.toBe("pushback");
    expect(outcome).not.toBe("escalated");
  });

  test("maxRounds caps the lineage, and the escalation names the policy", async () => {
    const { outcome, implementer } = await round(new SqliteBoard(), {}, ctx({ maxRounds: 1 }), { pushbackCount: 1 });
    expect(outcome).toBe("escalated");
    expect(implementer.escalationContext).toContain("the project's review policy allows 1 rounds");
  });

  test("atCap accept hands the work to a human; spec-question escalates as a question about the brief", async () => {
    const accepted = await round(new SqliteBoard(), {}, ctx({ maxRounds: 0, atCap: "accept" }));
    expect([accepted.outcome, accepted.implementer.status]).toEqual(["review", "review"]);
    const spec = await round(new SqliteBoard(), {}, ctx({ maxRounds: 0, atCap: "spec-question" }));
    expect(spec.outcome).toBe("escalated");
    expect(spec.implementer.escalationContext).toContain("a question about the spec");
  });

  test("no policy: today's behaviour, the same pushback body as before", async () => {
    const { outcome, next } = await round(new SqliteBoard(), {}, { runner: noRunner });
    expect(outcome).toBe("pushback");
    expect(next!.body).toBe("Retry the import.\n\n---\nReviewer feedback (attempt 1):\nHandle the empty file.");
  });
});

describe("fix rounds from the project's template", () => {
  const TEMPLATE = "Fix round {round} for {key}: {title}\n\nThe brief:\n{body}\n\nThe review, in full:\n{review}";

  test("the next attempt's whole brief is the rendered template with the full review, then the project rules", async () => {
    const long = "Handle the empty file.\n".repeat(20).trim();
    const { outcome, next } = await round(new SqliteBoard(), { reviewFeedback: long }, ctx(undefined, TEMPLATE, "Stage explicit paths."));
    expect(outcome).toBe("pushback");
    expect(next!.body).toBe(`Fix round 2 for A4: Add retries\n\nThe brief:\nRetry the import.\n\nThe review, in full:\n${long}\n\n---\n${CARD_RULES_HEADING}\nStage explicit paths.`);
    expect(next!.round).toBe(2);
  });

  test("a review with no text refuses the round instead of sending an empty brief", async () => {
    const { outcome, implementer, next } = await round(new SqliteBoard(), { reviewFeedback: "   " }, ctx(undefined, TEMPLATE));
    expect(outcome).toBe("escalated");
    expect(next).toBeUndefined();
    expect(implementer.escalationContext).toContain("No fix round was started: the fix-round template needs {review}");
  });
});
