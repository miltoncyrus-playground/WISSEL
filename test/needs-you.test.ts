import { describe, expect, test } from "bun:test";
import type { TaskCard } from "../src/core/types.ts";
import { deriveNeedsYou, lastParagraph, needsYouFor, needsYouLogLine, type NeedsYouContext } from "../src/services/needs-you.ts";
import { SqliteBoard } from "../src/services/board.ts";

const A = "aaaaaaaa-1111-4000-8000-000000000001";
const B = "bbbbbbbb-2222-4000-8000-000000000002";
const C = "cccccccc-3333-4000-8000-000000000003";

function mcp(server: string, tool: string) {
  return { server, tool, args: {}, reason: "needs it" };
}

function card(id: string, over: Partial<TaskCard> = {}): TaskCard {
  return { id, title: `title ${id.slice(0, 1)}`, body: "", labels: [], status: "inbox", ...over };
}

function ctx(cards: TaskCard[], worktrees: string[] = [], fallbackReason?: NeedsYouContext["fallbackReason"]): NeedsYouContext {
  const wt = new Set(worktrees);
  return { byId: new Map(cards.map((c) => [c.id, c])), hasWorktree: (id) => wt.has(id), ...(fallbackReason ? { fallbackReason } : {}) };
}

function derive(task: TaskCard, others: TaskCard[] = [], worktrees: string[] = [], fb?: NeedsYouContext["fallbackReason"]) {
  return deriveNeedsYou(task, ctx([task, ...others], worktrees, fb));
}

describe("deriveNeedsYou: one case per kind", () => {
  test("mcp-approval", () => {
    const ny = derive(card(A, { status: "review", pendingMcpApproval: mcp("slack", "post") }))!;
    expect(ny.value).toBe("mcp-approval");
    expect(ny.line).toBe("Wants to call slack · post");
    expect(ny.action).toEqual({ label: "Approve", href: `/tasks/${A}/mcp-approval/approve`, method: "POST" });
  });

  test("grant-tools", () => {
    const ny = derive(card(A, { status: "escalated", pushbackCount: 2, suggestedGrants: ["Bash(psql:*)", "Bash(make:*)"], escalationContext: "needs psql" }))!;
    expect(ny.value).toBe("grant-tools");
    expect(ny.line).toBe("Needs Bash(psql:*), Bash(make:*) to continue (round 3)");
    expect(ny.rounds).toBe(3);
    expect(ny.grants).toEqual(["Bash(psql:*)", "Bash(make:*)"]);
    expect(ny.reason).toBe("needs psql");
    expect(ny.reasonSource).toBe("escalation");
    expect(ny.action).toEqual({ label: "Grant and retry", href: `/tasks/${A}/escalation/grant-and-retry`, method: "POST" });
  });

  test("escalated uses escalationContext, last paragraph in the line", () => {
    const ny = derive(card(A, { status: "escalated", pushbackCount: 1, escalationContext: "  First para.\n\nThe tests still fail on DST.  \n\n " }))!;
    expect(ny.value).toBe("escalated");
    expect(ny.line).toBe("Escalated after 2 rounds: The tests still fail on DST.");
    expect(ny.reason).toBe("First para.\n\nThe tests still fail on DST.");
    expect(ny.reasonSource).toBe("escalation");
    expect(ny.rounds).toBe(2);
    expect(ny.action).toEqual({ label: "Retry", href: `/tasks/${A}/escalation/retry`, method: "POST" });
  });

  test("merge-after", () => {
    const dep = card(B, { status: "review", title: "Schema bump" });
    const ny = derive(card(A, { status: "review", dependsOn: [B] }), [dep], [A, B])!;
    expect(ny.value).toBe("merge-after:bbbbbbbb");
    expect(ny.line).toBe("Merge Schema bump first");
    expect(ny.blocker).toEqual({ id: B, id8: "bbbbbbbb", status: "review" });
    expect(ny.action).toEqual({ label: "Merge bbbbbbbb", href: `/tasks/${B}/merge`, method: "POST" });
  });

  test("merge-after opens the dep when it has no worktree to merge", () => {
    const dep = card(B, { status: "running" });
    const ny = derive(card(A, { status: "review", dependsOn: [B] }), [dep], [A])!;
    expect(ny.value).toBe("merge-after:bbbbbbbb");
    expect(ny.action).toEqual({ label: "Open", href: `/app#/board/${B}`, method: "GET" });
  });

  test("merge", () => {
    const ny = derive(card(A, { status: "review", dependsOn: [B] }), [card(B, { status: "done" })], [A])!;
    expect(ny.value).toBe("merge");
    expect(ny.line).toBe("Ready to merge");
    expect(ny.action).toEqual({ label: "Merge", href: `/tasks/${A}/merge`, method: "POST" });
  });

  test("blocked-on", () => {
    const ny = derive(card(A, { status: "ready", dependsOn: [B] }), [card(B, { status: "escalated", title: "Auth fix" })])!;
    expect(ny.value).toBe("blocked-on:bbbbbbbb escalated");
    expect(ny.line).toBe("Waiting on Auth fix, which is escalated");
    expect(ny.blocker).toEqual({ id: B, id8: "bbbbbbbb", status: "escalated" });
    expect(ny.action).toEqual({ label: "Open", href: `/app#/board/${B}`, method: "GET" });
  });

  test("review", () => {
    const ny = derive(card(A, { status: "review" }))!;
    expect(ny.value).toBe("review");
    expect(ny.line).toBe("Ready for your review");
    expect(ny.action).toEqual({ label: "Open", href: `/app#/board/${A}`, method: "GET" });
  });

  test("failed, with and without a fallback", () => {
    const bare = derive(card(A, { status: "failed" }))!;
    expect(bare.value).toBe("failed");
    expect(bare.line).toBe("Failed");
    expect(bare.action).toEqual({ label: "Retry", href: `/tasks/${A}/run`, method: "POST" });
    const told = derive(card(A, { status: "failed" }), [], [], { text: "claude exited 1\n\nrate limited", source: "implementer" })!;
    expect(told.line).toBe("Failed: rate limited");
  });

  test("no-match", () => {
    const ny = derive(card(A, { status: "no-match" }))!;
    expect(ny.value).toBe("no-match");
    expect(ny.line).toBe("No agent matched");
    expect(ny.action).toEqual({ label: "Open", href: `/app#/board/${A}`, method: "GET" });
  });
});

describe("deriveNeedsYou: precedence and non-cases", () => {
  test("escalated with grants is grant-tools, not escalated", () => {
    expect(derive(card(A, { status: "escalated", suggestedGrants: ["Bash(x:*)"] }))!.kind).toBe("grant-tools");
  });

  test("an empty grants list is plain escalated", () => {
    expect(derive(card(A, { status: "escalated", suggestedGrants: [] }))!.kind).toBe("escalated");
  });

  test("review with an MCP request and a worktree is mcp-approval", () => {
    expect(derive(card(A, { status: "review", pendingMcpApproval: mcp("s", "t") }), [], [A])!.value).toBe("mcp-approval");
  });

  test("an MCP request on a non-review card does not count", () => {
    expect(derive(card(A, { status: "failed", pendingMcpApproval: mcp("s", "t") }))!.value).toBe("failed");
  });

  test("archived and superseded give undefined", () => {
    expect(derive(card(A, { status: "review", archivedAt: "2026-10-01T00:00:00Z" }), [], [A])).toBeUndefined();
    expect(derive(card(A, { status: "escalated", supersededBy: B }))).toBeUndefined();
  });

  test("done, running, pending-review and dispatched give undefined", () => {
    for (const status of ["done", "running", "pending-review", "dispatched"] as const) {
      expect(derive(card(A, { status }), [], [A])).toBeUndefined();
    }
  });

  test("merge-after picks the first not-done dep in dependsOn order", () => {
    const ny = derive(card(A, { status: "review", dependsOn: [B, C] }), [card(B, { status: "done" }), card(C, { status: "failed" })], [A])!;
    expect(ny.value).toBe("merge-after:cccccccc");
    const both = derive(card(A, { status: "review", dependsOn: [C, B] }), [card(B, { status: "review" }), card(C, { status: "failed" })], [A])!;
    expect(both.value).toBe("merge-after:cccccccc");
  });

  test("merge-after with a missing dep", () => {
    const ny = derive(card(A, { status: "review", dependsOn: [B] }), [], [A])!;
    expect(ny.value).toBe("merge-after:bbbbbbbb");
    expect(ny.line).toBe("Merge bbbbbbbb first");
    expect(ny.blocker!.status).toBe("missing");
  });

  test("blocked-on with a missing dep", () => {
    const ny = derive(card(A, { status: "inbox", dependsOn: [B] }))!;
    expect(ny.value).toBe("blocked-on:bbbbbbbb missing");
    expect(ny.line).toBe("Waiting on bbbbbbbb, which is missing");
  });

  test("blocked-on skips healthy deps and reports the first stuck one", () => {
    const ny = derive(card(A, { status: "inbox", dependsOn: [B, C] }), [card(B, { status: "running" }), card(C, { status: "review" })])!;
    expect(ny.value).toBe("blocked-on:cccccccc review");
  });

  test("an inbox card whose dep is merely running gives undefined", () => {
    expect(derive(card(A, { status: "inbox", dependsOn: [B] }), [card(B, { status: "running" })])).toBeUndefined();
    expect(derive(card(A, { status: "inbox" }))).toBeUndefined();
  });
});

// adf63608: an escalated card with no escalationContext and no grants
// showed no reason at all in Needs you.
describe("escalated reason fallbacks (adf63608 regression)", () => {
  const esc = card(A, { status: "escalated", escalationContext: "   ", pushbackCount: 0 });

  test("reviewer fallback", () => {
    const ny = derive(esc, [], [], { text: "Missing migration for the new column.", source: "reviewer" })!;
    expect(ny.reason).toBe("Missing migration for the new column.");
    expect(ny.reasonSource).toBe("reviewer");
    expect(ny.rounds).toBe(1);
    expect(ny.line).toBe("Escalated after 1 round: Missing migration for the new column.");
  });

  test("implementer fallback", () => {
    const ny = derive(esc, [], [], { text: "Did the thing.", source: "implementer" })!;
    expect(ny.reasonSource).toBe("implementer");
    expect(ny.line).toBe("Escalated after 1 round: Did the thing.");
  });

  test("no reason recorded", () => {
    const ny = derive(esc)!;
    expect(ny.reason).toBe("No reason recorded");
    expect(ny.reasonSource).toBe("none");
    expect(ny.line).toBe("Escalated after 1 round: No reason recorded");
  });

  test("the line is clipped to 160 chars", () => {
    const ny = derive(card(A, { status: "escalated", escalationContext: "x".repeat(400) }))!;
    expect(lastParagraph("x".repeat(400))).toHaveLength(160);
    expect(ny.line).toBe(`Escalated after 1 round: ${"x".repeat(159)}…`);
    expect(ny.reason).toHaveLength(400);
  });
});

describe("needsYouFor against a real Board", () => {
  test("worktree presence, reviewer feedback and implementer summary come from results", async () => {
    const board = new SqliteBoard();
    const dep = await board.create({ title: "dep", body: "", labels: [] });
    await board.move(dep.id, "review");
    await board.recordResult({ taskId: dep.id, agentId: "impl", ok: true, summary: "s", worktree: { path: "/wt/dep", branch: "wissel/dep" } });

    const mergeMe = await board.create({ title: "m", body: "", labels: [], dependsOn: [dep.id] });
    await board.move(mergeMe.id, "review");
    await board.recordResult({ taskId: mergeMe.id, agentId: "impl", ok: true, summary: "s", worktree: { path: "/wt/m", branch: "wissel/m" } });

    const plainReview = await board.create({ title: "r", body: "", labels: [] });
    await board.move(plainReview.id, "review");

    // Two-card lineage: the older card got reviewer feedback, the
    // escalated one has only an implementer summary.
    const lineageId = "lineage-1";
    const first = await board.create({ title: "e", body: "", labels: [], reviewLineageId: lineageId });
    await board.recordResult({ taskId: first.id, agentId: "reviewer", ok: true, summary: "", verdict: "changes_requested", reviewFeedback: "Handle the DST edge." });
    const esc = await board.create({ title: "e", body: "", labels: [], reviewLineageId: lineageId, pushbackCount: 2 });
    await board.move(esc.id, "escalated");
    await board.recordResult({ taskId: esc.id, agentId: "impl", ok: true, summary: "Implemented it." });
    await board.setSupersededBy(first.id, esc.id);

    const lonely = await board.create({ title: "l", body: "", labels: [] });
    await board.move(lonely.id, "escalated");
    await board.recordResult({ taskId: lonely.id, agentId: "impl", ok: true, summary: "Only a summary." });

    const bare = await board.create({ title: "b", body: "", labels: [] });
    await board.move(bare.id, "escalated");

    const needs = await needsYouFor(board, await board.list());
    expect(needs.get(dep.id)!.value).toBe("merge");
    expect(needs.get(mergeMe.id)!.value).toBe(`merge-after:${dep.id.slice(0, 8)}`);
    expect(needs.get(mergeMe.id)!.action.href).toBe(`/tasks/${dep.id}/merge`);
    expect(needs.get(plainReview.id)!.value).toBe("review");
    expect(needs.get(esc.id)).toMatchObject({ value: "escalated", reason: "Handle the DST edge.", reasonSource: "reviewer", rounds: 3 });
    expect(needs.get(lonely.id)).toMatchObject({ reason: "Only a summary.", reasonSource: "implementer" });
    expect(needs.get(bare.id)).toMatchObject({ reason: "No reason recorded", reasonSource: "none" });
    expect(needs.has(first.id)).toBe(false);

    for (const ny of needs.values()) {
      expect(ny.value.length).toBeGreaterThan(0);
      expect(ny.line.length).toBeGreaterThan(0);
    }
    expect(needsYouLogLine(needs)).toBe("needs-you: escalated=3 merge=1 merge-after=1 review=1");
  });

  test("log line with nothing to do", () => {
    expect(needsYouLogLine(new Map())).toBe("needs-you: none");
  });
});
