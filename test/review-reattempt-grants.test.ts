import { expect, test } from "bun:test";
import { carriedCardSettings, resumeAfterReviewVerdict } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { TaskCard, TaskResult } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";

// 2026-10-10, "Wissel app 1/6": the implementer was refused `bun install`
// on every attempt, the reviewer asked for exactly that each round, and
// the loop ran 5 rounds ($9.28) before escalating. Under test: a review
// re-attempt keeps the card's grants (carriedCardSettings), and its body
// names what the last attempt was refused.

const registry = await Registry.load();
const noRunner: CommandRunner = async () => {
  throw new Error("no command should run on the pushback/escalate paths");
};

const GRANTS = ["Bash(bun install:*)", "Bash(bunx playwright test:*)"];

async function firstAttempt(board: SqliteBoard, over: Partial<TaskCard> = {}): Promise<TaskCard> {
  const t = await board.create({ title: "Wissel app 1/6", body: "build it", labels: ["code"], repo: "/tmp/repo", dependsOn: [], ...over });
  await board.move(t.id, "pending-review");
  return t;
}

/** Records `implementer`'s result (with these refusals), adds a reviewer
 *  card asking for changes, and runs the review decision. */
async function reviewRound(board: SqliteBoard, implementer: TaskCard, denials: string[] | undefined) {
  await board.recordResult({ taskId: implementer.id, agentId: "implementer", ok: true, summary: "done", ...(denials ? { permissionDenials: denials } : {}) });
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
  const verdict: TaskResult = { taskId: reviewer.id, agentId: "reviewer", ok: true, summary: "no", verdict: "changes_requested", reviewFeedback: "run bun install and commit the lockfile" };
  await board.recordResult(verdict);
  const outcome = await resumeAfterReviewVerdict(board, registry, (await board.get(reviewer.id))!, verdict, noRunner);
  const next = (await board.get(implementer.id))!.supersededBy;
  return { outcome, next: next ? (await board.get(next))! : undefined, implementer: (await board.get(implementer.id))! };
}

test("carriedCardSettings keeps grants, directories, model, harness and MCP override, and nothing else", () => {
  const card = {
    id: "x",
    status: "escalated",
    title: "t",
    body: "b",
    labels: [],
    repo: "/r",
    extraAllowedTools: GRANTS,
    extraAllowedDirs: ["/other"],
    model: "claude-opus-5-5",
    harnessOverride: "claude",
    mcpAccessOverride: [{ server: "s", tools: ["t"] }],
    pushbackCount: 3,
  } as TaskCard;
  expect(carriedCardSettings(card)).toEqual({
    extraAllowedTools: GRANTS,
    extraAllowedDirs: ["/other"],
    model: "claude-opus-5-5",
    harnessOverride: "claude",
    mcpAccessOverride: [{ server: "s", tools: ["t"] }],
  });
  expect(carriedCardSettings({ id: "y", status: "inbox", title: "t", body: "b", labels: [], extraAllowedTools: [] } as TaskCard)).toEqual({});
});

test("a review pushback keeps the card's grants and settings on the re-attempt", async () => {
  const board = new SqliteBoard();
  const first = await firstAttempt(board, { extraAllowedTools: GRANTS, model: "claude-opus-5-5", harnessOverride: "claude" });
  const { outcome, next } = await reviewRound(board, first, undefined);
  expect(outcome).toBe("pushback");
  expect(next!.extraAllowedTools).toEqual(GRANTS);
  expect(next!.model).toBe("claude-opus-5-5");
  expect(next!.harnessOverride).toBe("claude");
  expect(next!.pushbackCount).toBe(1);
});

test("a re-attempt's body names what the last attempt was refused", async () => {
  const board = new SqliteBoard();
  const first = await firstAttempt(board);
  const { outcome, next } = await reviewRound(board, first, ["Bash: bun install", "Bash: npm install"]);
  expect(outcome).toBe("pushback");
  expect(next!.body).toEndWith(
    "run bun install and commit the lockfile\n\nRefused on the last attempt: Bash: bun install, Bash: npm install. Don't retry these: they need a grant on the card (POST /tasks/:id/allowed-tools). Do everything else, and say plainly which checks you couldn't run.",
  );
});

test("a re-attempt's body is unchanged when nothing was refused", async () => {
  const board = new SqliteBoard();
  const first = await firstAttempt(board);
  const { next } = await reviewRound(board, first, undefined);
  expect(next!.body).toBe("build it\n\n---\nReviewer feedback (attempt 1):\nrun bun install and commit the lockfile");
});

test("repeated refusals never stop the loop on their own: pushback continues as before", async () => {
  const board = new SqliteBoard();
  let cur = await firstAttempt(board);
  for (let round = 1; round <= 3; round++) {
    const r = await reviewRound(board, cur, ["Bash: bun install"]);
    expect(r.outcome).toBe("pushback");
    expect(r.next!.pushbackCount).toBe(round);
    await board.move(r.next!.id, "pending-review");
    cur = r.next!;
  }
});
