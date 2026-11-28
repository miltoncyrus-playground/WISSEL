import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRY_FORWARD_OWNER, carryForward, finishResult, resumeAfterReviewVerdict, startReReview } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { afterForward, forwardChangedFiles } from "../src/services/merge-forward.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import { armBlockedBy } from "../src/services/pr-watcher.ts";
import { ADVERSARIAL_BRIEF, carryForwardText, combineVerdicts, keepsPass, reviewerModel, tierFor } from "../src/services/review-tiers.ts";
import { reviewTierError } from "../src/services/task-input.ts";
import type { MergeContext } from "../src/services/worktree.ts";
import type { ReviewPolicy, TaskCard, TaskResult } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.6 and §4.7, coordinator card 8b: review
// tiers with their reviewers, carry-forward of non-blocking findings,
// keeping a PASS across a text-only change, and re-reviewing a delivered
// PR after merge-forward.

const registry = await Registry.load();
const noRunner: CommandRunner = async () => {
  throw new Error("no command should run on these paths");
};
const memoryPath = join(mkdtempSync(join(tmpdir(), "wissel-tiers-")), "lessons.md");

const twoReviewers: ReviewPolicy = {
  tiers: [
    { id: "risky", when: "label:auth", reviewers: [{ model: "other-than-coder", mode: "adversarial" }, { model: "claude-sonnet-5-5", mode: "standard" }], maxRounds: 1 },
    { id: "light", when: "always", reviewers: [{ model: "other-than-coder", mode: "standard" }] },
  ],
  otherModels: ["claude-fable-5-1", "claude-opus-5-5"],
};
const ctx = (policy?: ReviewPolicy, extra: Partial<MergeContext> = {}): MergeContext => ({ runner: noRunner, reviewPolicyFor: async () => ({ policy }), ...extra });

/** A write-tier implementer card that has just finished, handed to finishResult. */
async function implemented(board: SqliteBoard, policy: ReviewPolicy | undefined, over: Partial<TaskCard> = {}) {
  const card = await board.create({ title: "Add login", body: "Add the login form.", labels: ["code"], repo: "/tmp/repo", dependsOn: [], routedTo: "implementer", ...over });
  await board.move(card.id, "running");
  await finishResult(board, registry, { taskId: card.id, agentId: "implementer", ok: true, summary: "added" }, undefined, ctx(policy), memoryPath);
  const reviews = (await board.list()).filter((t) => t.parentTaskId === card.id && t.labels.includes("review"));
  return { card: (await board.get(card.id))!, reviews };
}

async function report(board: SqliteBoard, reviewer: TaskCard, verdict: Partial<TaskResult>, c: MergeContext) {
  await board.move(reviewer.id, "done");
  const result: TaskResult = { taskId: reviewer.id, agentId: "reviewer", ok: true, summary: "reviewed", verdict: "approve", ...verdict };
  await board.recordResult(result);
  return resumeAfterReviewVerdict(board, registry, (await board.get(reviewer.id))!, result, c);
}

describe("tiers", () => {
  test("the card's own tier wins; else the first tier whose when matches; else none", () => {
    expect(tierFor(twoReviewers, { labels: ["auth"] })?.id).toBe("risky");
    expect(tierFor(twoReviewers, { labels: ["code"] })?.id).toBe("light");
    expect(tierFor(twoReviewers, { labels: ["auth"], review: { tier: "light" } })?.id).toBe("light");
    expect(tierFor(twoReviewers, { labels: ["code"], review: { tier: "gone" } })?.id).toBe("light");
    expect(tierFor({ tiers: [{ id: "big", when: "files>=3", reviewers: [{ model: "x", mode: "standard" }] }] }, { labels: [], files: ["a", "b"] })).toBeUndefined();
    expect(tierFor({ tiers: [{ id: "big", when: "files>=3", reviewers: [{ model: "x", mode: "standard" }] }] }, { labels: [], files: ["a", "b", "c"] })?.id).toBe("big");
    expect(tierFor(undefined, { labels: [] })).toBeUndefined();
  });

  test("other-than-coder takes the first other model, and says so when there is none", () => {
    expect(reviewerModel({ model: "other-than-coder", mode: "standard" }, "claude-fable-5-1", ["claude-fable-5-1", "claude-opus-5-5"])).toEqual({ model: "claude-opus-5-5" });
    expect(reviewerModel({ model: "claude-sonnet-5-5", mode: "standard" }, "claude-sonnet-5-5", [])).toEqual({ model: "claude-sonnet-5-5" });
    expect(reviewerModel({ model: "other-than-coder", mode: "standard" }, "m", undefined).note).toContain("names no otherModels");
    expect(reviewerModel({ model: "other-than-coder", mode: "standard" }, "m", ["m"]).note).toContain("every model in otherModels");
  });

  test("settings: tiers, carryForward, keepPass and otherModels are checked", () => {
    const ok = validateProjectSettings({ reviewPolicy: { ...twoReviewers, carryForward: "card", keepPass: ["text", "text"] } });
    expect(ok).toMatchObject({ ok: true, patch: { reviewPolicy: { carryForward: "card", keepPass: ["text"], otherModels: ["claude-fable-5-1", "claude-opus-5-5"] } } });
    expect((ok as { patch: { reviewPolicy: ReviewPolicy } }).patch.reviewPolicy.tiers).toHaveLength(2);
    for (const bad of [
      { tiers: [{ id: "A", reviewers: [{ model: "x" }] }] },
      { tiers: [{ id: "a", reviewers: [] }] },
      { tiers: [{ id: "a", when: "sometimes", reviewers: [{ model: "x" }] }] },
      { tiers: [{ id: "a", reviewers: [{ model: "x", mode: "harsh" }] }] },
      { tiers: [{ id: "a", reviewers: [{ model: "x" }] }, { id: "a", reviewers: [{ model: "y" }] }] },
      { carryForward: "email" },
      { keepPass: ["code"] },
      { otherModels: ["has space"] },
    ]) {
      expect(validateProjectSettings({ reviewPolicy: bad }).ok).toBe(false);
    }
  });

  test("a card's review.tier is the only review field set from outside", () => {
    expect(reviewTierError({ tier: "risky" })).toBeUndefined();
    expect(reviewTierError(null)).toBeUndefined();
    expect(reviewTierError({ tier: "Risky!" })).toContain("tier id");
    expect(reviewTierError({ owner: "me" })).toContain('"owner"');
    expect(reviewTierError("risky")).toContain("object");
  });
});

describe("a tier's reviewers", () => {
  test("one review card per reviewer, each on its model and mode, sharing a panel", async () => {
    const board = new SqliteBoard();
    const { card, reviews } = await implemented(board, twoReviewers, { labels: ["code", "auth"] });
    expect(card.status).toBe("pending-review");
    expect(reviews).toHaveLength(2);
    const [a, b] = reviews;
    expect(a!.title).toBe("Review 1/2: Add login");
    expect(a!.model).toBe("claude-opus-5-5"); // the coder runs on claude-fable-5-1
    expect(a!.body).toContain(ADVERSARIAL_BRIEF);
    expect(a!.body).toContain("reviewer 1 of 2");
    expect(b!.model).toBe("claude-sonnet-5-5");
    expect(b!.body).not.toContain(ADVERSARIAL_BRIEF);
    expect(a!.review?.panel).toBeDefined();
    expect(a!.review?.panel).toBe(b!.review?.panel);
    expect(a!.review).toMatchObject({ tier: "risky", mode: "adversarial" });
  });

  test("no tier: one review, as before", async () => {
    const board = new SqliteBoard();
    const { reviews } = await implemented(board, undefined);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.title).toBe("Review: Add login");
    expect(reviews[0]!.review).toBeUndefined();
    expect(reviews[0]!.model).toBeUndefined();
  });

  test("the verdict waits for the whole panel, then combines: one FAIL is a fix round with every reviewer's text", async () => {
    const board = new SqliteBoard();
    const { card, reviews } = await implemented(board, twoReviewers, { labels: ["code"], review: { tier: "risky" } });
    const c = ctx(twoReviewers);
    expect(await report(board, reviews[0]!, { verdict: "changes_requested", reviewFeedback: "The token is logged." }, c)).toBe("waiting");
    expect((await board.get(card.id))!.status).toBe("pending-review");
    expect(await report(board, reviews[1]!, { verdict: "approve", reviewFeedback: "Fine by me." }, c)).toBe("pushback");
    const next = await board.get((await board.get(card.id))!.supersededBy!);
    expect(next!.body).toContain("The token is logged.");
    expect(next!.body).toContain("Fine by me.");
    expect(next!.body).toContain("Reviewer 1 (adversarial), claude-opus-5-5 (changes requested)");
    // The tier stays with the work.
    expect(next!.review).toEqual({ tier: "risky" });
    // A late duplicate report does nothing.
    expect(await resumeAfterReviewVerdict(board, registry, reviews[1]!, { taskId: reviews[1]!.id, agentId: "reviewer", ok: true, summary: "", verdict: "approve" }, c)).toBe("no-op");
  });

  test("the tier's maxRounds caps its rounds", async () => {
    const board = new SqliteBoard();
    const { reviews } = await implemented(board, twoReviewers, { labels: ["code", "auth"], pushbackCount: 1 });
    const c = ctx(twoReviewers);
    await report(board, reviews[0]!, { verdict: "changes_requested", reviewFeedback: "No." }, c);
    expect(await report(board, reviews[1]!, { verdict: "changes_requested", reviewFeedback: "Still no." }, c)).toBe("escalated");
  });

  test("combineVerdicts: approve only when all do; counts summed; grants joined", () => {
    const r = (v: TaskResult["verdict"], extra: Partial<TaskResult> = {}): TaskResult => ({ taskId: "t", agentId: "reviewer", ok: true, summary: "s", verdict: v, ...extra });
    expect(combineVerdicts([{ label: "A", result: r("approve") }, { label: "B", result: r("approve") }]).verdict).toBe("approve");
    const c = combineVerdicts([
      { label: "A", result: r("approve", { reviewSeverity: { high: 0, med: 1, low: 2 }, reviewGrants: ["Bash(bun test:*)"] }) },
      { label: "B", result: r("changes_requested", { reviewSeverity: { high: 1, med: 0 }, reviewGrants: ["Bash(bun test:*)"] }) },
    ]);
    expect(c.verdict).toBe("changes_requested");
    expect(c.reviewSeverity).toEqual({ high: 1, med: 1, medWithScenario: 0, low: 2 });
    expect(c.reviewGrants).toEqual(["Bash(bun test:*)"]);
  });
});

describe("carry-forward", () => {
  const card = (): Omit<TaskCard, "id" | "status"> => ({ title: "Add login", body: "b", labels: ["code"], repo: "/tmp/repo", dependsOn: [], key: "A4" });
  const passed: TaskResult = { taskId: "r", agentId: "reviewer", ok: true, summary: "", verdict: "approve", reviewFeedback: "LOW: rename x to count.", reviewSeverity: { high: 0, med: 0, low: 1 } };

  test("card: a held follow-up with the full findings, never started by the sweep", async () => {
    const board = new SqliteBoard();
    const c = await board.create(card());
    expect(await carryForward(board, c, passed, { carryForward: "card" }, ctx())).toBe("card");
    const f = (await board.list()).find((t) => t.parentTaskId === c.id)!;
    expect(f.title).toBe("Follow-up: Add login");
    expect(f.body).toContain("LOW: rename x to count.");
    expect(f.status).toBe("escalated");
    expect(f.routedTo).toBe(CARRY_FORWARD_OWNER);
    expect(f.labels).toContain("carry-forward");
  });

  test("ticket: commented when the tracker takes it, else a card", async () => {
    const board = new SqliteBoard();
    const c = await board.create(card());
    const said: string[] = [];
    expect(await carryForward(board, c, passed, { carryForward: "ticket" }, ctx(undefined, { commentOnTicket: async (_c, text) => (said.push(text), true) }))).toBe("ticket");
    expect(said[0]).toContain("LOW: rename x to count.");
    expect(await carryForward(board, c, passed, { carryForward: "ticket" }, ctx(undefined, { commentOnTicket: async () => false }))).toBe("card");
  });

  test("drop, no policy, a clean pass or a FAIL carry nothing", async () => {
    const board = new SqliteBoard();
    const c = await board.create(card());
    expect(await carryForward(board, c, passed, { carryForward: "drop" }, ctx())).toBe("none");
    expect(await carryForward(board, c, passed, undefined, ctx())).toBe("none");
    expect(carryForwardText({ ...passed, reviewSeverity: { high: 0, med: 0, low: 0 } })).toBeUndefined();
    expect(carryForwardText({ ...passed, verdict: "changes_requested" })).toBeUndefined();
    expect((await board.list()).filter((t) => t.parentTaskId === c.id)).toHaveLength(0);
  });

  test("on a passing review under the policy, the follow-up appears", async () => {
    const board = new SqliteBoard();
    const policy: ReviewPolicy = { carryForward: "card" };
    const { card: impl, reviews } = await implemented(board, policy);
    await report(board, reviews[0]!, { reviewFeedback: "LOW: a nit.", reviewSeverity: { high: 0, med: 0, low: 1 } }, ctx(policy));
    expect((await board.list()).some((t) => t.parentTaskId === impl.id && t.title === "Follow-up: Add login")).toBe(true);
  });
});

describe("keeping a PASS", () => {
  test("a clean merge always keeps it; otherwise only the kinds keepPass names", () => {
    expect(keepsPass([], undefined)).toBe(true);
    expect(keepsPass(["README.md", "docs/a.txt"], ["text"])).toBe(true);
    expect(keepsPass(["test/a.test.ts", "e2e/b.spec.ts"], ["test"])).toBe(true);
    expect(keepsPass(["README.md", "src/a.ts"], ["text", "test"])).toBe(false);
    expect(keepsPass(["README.md"], undefined)).toBe(false);
  });

  test("a PR may be armed only at the reviewed head", () => {
    const w = { checks: { state: "passing" as const, headSha: "b".repeat(40), failing: [] }, mergeable: "clean" as const, armed: false, draft: false, base: "main" };
    expect(armBlockedBy(w, "a".repeat(40), "main", "open")).toContain("is not the reviewed");
    expect(armBlockedBy(w, "b".repeat(40), "main", "open")).toBeNull();
  });
});

describe("re-review of a delivered PR", () => {
  /** A real repo: the card's branch was reviewed at `reviewed`, then main
   *  moved and was merged in, conflicting in `conflictFile`. */
  function forwarded(conflictFile: string | undefined) {
    const dir = mkdtempSync(join(tmpdir(), "wissel-forward-"));
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "a\n");
    writeFileSync(join(dir, "app.ts"), "a\n");
    git("add", "README.md", "app.ts");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "card");
    writeFileSync(join(dir, conflictFile ?? "app.ts"), "card\n");
    git("commit", "-qam", "card");
    const reviewed = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    writeFileSync(join(dir, conflictFile ?? "other.ts"), "main\n");
    if (!conflictFile) git("add", "other.ts");
    git("commit", "-qam", "main");
    git("checkout", "-q", "card");
    if (conflictFile) {
      Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "merge", "-q", "--no-edit", "main"], { cwd: dir });
      writeFileSync(join(dir, conflictFile), "resolved\n");
      git("add", conflictFile);
      git("commit", "-qm", "resolve");
    } else git("merge", "-q", "--no-edit", "main");
    return { dir, reviewed, head: git("rev-parse", "HEAD") };
  }

  test("forwardChangedFiles lists only what the resolution changed", async () => {
    const clean = forwarded(undefined);
    expect(await forwardChangedFiles(runViaBun, clean.dir, clean.reviewed, clean.head)).toEqual([]);
    const resolved = forwarded("app.ts");
    expect(await forwardChangedFiles(runViaBun, resolved.dir, resolved.reviewed, resolved.head)).toEqual(["app.ts"]);
  });

  async function delivered(board: SqliteBoard, f: { reviewed: string; head: string }) {
    const card = await board.create({ title: "Add login", body: "b", labels: ["code"], repo: "/tmp/repo", dependsOn: [], routedTo: "implementer" });
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: f.head, reviewedHead: f.reviewed });
    await board.move(card.id, "done");
    return { before: { ...card, pr: { number: 7, url: "https://example.invalid/7", head: f.reviewed } }, card: (await board.get(card.id))! };
  }
  const deps = (board: SqliteBoard, policy?: ReviewPolicy) => ({ board, registry, merge: { runner: runViaBun, reviewPolicyFor: async () => ({ policy }), recordPullRequest: async (id: string, pr: NonNullable<TaskCard["pr"]>) => void (await board.setPullRequest(id, pr)) } });

  test("a clean merge keeps the PASS: the reviewed head moves on", async () => {
    const board = new SqliteBoard();
    const f = forwarded(undefined);
    const { before, card } = await delivered(board, f);
    expect(await afterForward(deps(board), before, f.dir)).toContain("main merged in cleanly");
    expect((await board.get(card.id))!.pr!.reviewedHead).toBe(f.head);
  });

  test("a resolved text file keeps the PASS under keepPass text; product code starts a narrow re-review", async () => {
    const board = new SqliteBoard();
    const text = forwarded("README.md");
    const one = await delivered(board, text);
    expect(await afterForward(deps(board, { keepPass: ["text"] }), one.before, text.dir)).toContain("keepPass allows");
    expect((await board.get(one.card.id))!.pr!.reviewedHead).toBe(text.head);

    const code = forwarded("app.ts");
    const two = await delivered(board, code);
    expect(await afterForward(deps(board, { keepPass: ["text"] }), two.before, code.dir)).toContain("re-review");
    expect((await board.get(two.card.id))!.pr!.reviewedHead).toBe(code.reviewed);
    const rr = (await board.list()).find((t) => t.parentTaskId === two.card.id && t.review?.reReview)!;
    expect(rr.title).toBe("Re-review: Add login");
    expect(rr.review!.reReview).toEqual({ from: code.reviewed, to: code.head, files: ["app.ts"] });
    expect(rr.body).toContain("Review only that change");
    expect(rr.repo).toBe(code.dir);
    // One at a time per head.
    expect(await startReReview(board, (await board.get(two.card.id))!, rr.review!.reReview!)).toBeUndefined();
  });

  test("its PASS makes the head reviewed and merges nothing; its FAIL starts a fix round", async () => {
    const board = new SqliteBoard();
    const f = { reviewed: "a".repeat(40), head: "b".repeat(40) };
    const { card } = await delivered(board, f);
    const rr = (await startReReview(board, card, { from: f.reviewed, to: f.head, files: ["app.ts"] }))!;
    const c = ctx(undefined, { recordPullRequest: async (id, pr) => void (await board.setPullRequest(id, pr)) });
    expect(await report(board, rr, { verdict: "approve" }, c)).toBe("done");
    expect((await board.get(card.id))!.pr!.reviewedHead).toBe(f.head);
    expect((await board.get(card.id))!.status).toBe("done");

    const again = (await startReReview(board, (await board.get(card.id))!, { from: f.head, to: "c".repeat(40), files: ["app.ts"] }))!;
    expect(await report(board, again, { verdict: "changes_requested", reviewFeedback: "The merge dropped the null check." }, c)).toBe("pushback");
    const next = await board.get((await board.get(card.id))!.supersededBy!);
    expect(next!.body).toContain("The merge dropped the null check.");
  });
});
