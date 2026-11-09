import { expect, test } from "bun:test";
import type { PrRef, TaskCard, TaskResult } from "../src/core/types.ts";
import { SqliteBoard, type BoardEvent } from "../src/services/board.ts";
import { buildMergeForwardBody, canArm, mergeForwardCards, startMergeForward, touchesProductCode } from "../src/services/merge-forward.ts";

// Merge-forward on DIRTY and the arming rules (docs/SDD-coordinator.md
// §4.7, §4.13): one merge-forward card per DIRTY PR head, a narrow
// re-review when its resolution touched product code, and canArm as the
// pure rule the executor will consult. Nothing here calls a code host.

const NOW = "2026-11-09T10:00:00.000Z";
const prOf = (sha: string, over: Partial<PrRef> = {}): PrRef => ({
  number: 7,
  url: "https://github.com/acme/repo/pull/7",
  head: "feat/ABC-1-a4-x",
  lifecycle: "landed",
  watch: { sha, checks: "passing", mergeable: "dirty", state: "open", at: NOW },
  ...over,
});

const passed = (name: string) => ({ name, result: "passed" as const });

test("canArm allows only main as base, the reviewed sha as head and green or skipped checks", () => {
  const ok = canArm({ base: "main", main: "main", head: "abc", reviewedSha: "abc", checks: [passed("fast"), { name: "docs", result: "skipped" }] });
  expect(ok.ok).toBe(true);
  expect(canArm({ base: "main", main: "main", head: "abc", reviewedSha: "abc", checks: [] }).ok).toBe(true);

  const base = canArm({ base: "develop", main: "main", head: "abc", reviewedSha: "abc", checks: [] });
  expect(base.ok).toBe(false);
  expect(base.reason).toContain("develop");
  expect(canArm({ base: "main", main: "main", head: "abc", reviewedSha: "old", checks: [] })).toEqual({ ok: false, reason: 'head abc is not the reviewed sha old' });
  expect(canArm({ base: "main", main: "main", head: "abc", checks: [] }).reason).toContain("no review has passed");
  expect(canArm({ base: "main", main: "main", head: "abc", reviewedSha: "abc", checks: [passed("fast"), { name: "e2e", result: "pending" }] }).reason).toBe('check "e2e" is still pending');
  expect(canArm({ base: "main", main: "main", head: "abc", reviewedSha: "abc", checks: [{ name: "lint", result: "failed" }] }).reason).toBe('check "lint" failed');
  // A rule that denies is a rule, whatever else is right: no empty head either.
  expect(canArm({ base: "main", main: "main", head: "", reviewedSha: "", checks: [] }).ok).toBe(false);
});

test("touchesProductCode is false for docs and tests only, true for anything else or nothing known", () => {
  expect(touchesProductCode(["docs/SDD-x.md", "README.md", "test/a.test.ts", "tests/b_test.go", "src/__tests__/c.spec.tsx", "notes.txt"])).toBe(false);
  expect(touchesProductCode(["docs/SDD-x.md", "src/services/board.ts"])).toBe(true);
  expect(touchesProductCode(["src/test-helpers.ts"])).toBe(true); // a helper under src is product code
  expect(touchesProductCode([])).toBe(false);
  expect(touchesProductCode(undefined)).toBe(true); // unknown is treated as touched: the safe side
});

test("buildMergeForwardBody prefers the project's merge-forward template and falls back to the built-in brief", () => {
  const task = { id: "t1", title: "Add thing", key: "A4", repo: "/r", pr: prOf("abc123") } as TaskCard;
  const templated = buildMergeForwardBody({ cardTemplates: { "merge-forward": "Merge {main} into {branch} for PR #{pr} ({key})" }, cardRules: "Never force-push." }, task);
  expect(templated.split("\n")[0]).toBe("merge-forward: /r#7@abc123");
  expect(templated).toContain("Merge main into feat/ABC-1-a4-x for PR #7 (A4)");
  expect(templated.trimEnd().endsWith("Never force-push.")).toBe(true);
  // No template: the built-in brief, still carrying the marker line.
  const plain = buildMergeForwardBody({}, task);
  expect(plain.split("\n")[0]).toBe("merge-forward: /r#7@abc123");
  expect(plain).toContain("https://github.com/acme/repo/pull/7");
  // A template that can't render (an unknown placeholder is empty) falls back too, rather than dropping the DIRTY PR.
  const broken = buildMergeForwardBody({ cardTemplates: { "merge-forward": "Do {nonsense}" } }, task);
  expect(broken).toContain("merge-forward: /r#7@abc123");
  expect(broken).not.toContain("Do {nonsense}");
  expect(broken).toContain("can no longer be merged");
});

async function setup(touched: () => Promise<string[] | undefined>) {
  const board = new SqliteBoard();
  const card = await board.create({ title: "Add thing", body: "", labels: ["code"], repo: "/r", key: "A4", mergeTarget: "main" });
  const dirty = await board.updateFields(card.id, { pr: prOf("abc123") });
  const created: TaskCard[] = [];
  board.events.on("event", (e: BoardEvent) => {
    if (e.type === "task.created") created.push(e.task);
  });
  const service = startMergeForward({ board, settingsFor: async () => ({ cardTemplates: { "merge-forward": "Merge {main} into {branch}" } }), touchedFiles: touched, logger: { warn: () => {} } });
  const emit = (event: BoardEvent) => board.events.emit("event", event);
  return { board, card: dirty, created, service, emit };
}

test("pr.dirty starts exactly one merge-forward card per PR head, idempotent on replay", async () => {
  const { board, card, created, service, emit } = await setup(async () => []);
  emit({ type: "pr.dirty", task: card });
  emit({ type: "pr.dirty", task: card }); // the same event replayed
  await service.settle();
  expect(created).toHaveLength(1);
  const mf = created[0]!;
  expect(mf.title).toBe(`Merge forward PR #7: ${card.id}`);
  expect(mf.labels).toEqual(["merge", "conflict"]);
  expect(mf.parentTaskId).toBe(card.id);
  expect(mf.repo).toBe("/r");
  expect(mf.mergeTarget).toBe("main");
  expect(mf.body).toContain("Merge main into feat/ABC-1-a4-x");
  expect(await mergeForwardCards(board, card.pr!, "/r")).toHaveLength(1);

  // A later look at the same head: still one.
  emit({ type: "pr.dirty", task: (await board.get(card.id))! });
  await service.settle();
  expect(created).toHaveLength(1);

  // A push moved the head and it is DIRTY again: that is a new conflict, so a new card.
  const pushed = await board.updateFields(card.id, { pr: prOf("def456") });
  emit({ type: "pr.dirty", task: pushed });
  await service.settle();
  expect(created).toHaveLength(2);
  expect(created[1]!.body).toContain("merge-forward: /r#7@def456");
  service.stop();
  emit({ type: "pr.dirty", task: await board.updateFields(card.id, { pr: prOf("fff999") }) });
  await service.settle();
  expect(created).toHaveLength(2);
});

test("a finished merge-forward starts one narrow re-review when product code was touched, none for docs or tests only", async () => {
  let files: string[] | undefined = ["docs/x.md", "test/y.test.ts"];
  const { board, card, created, service, emit } = await setup(async () => files);
  emit({ type: "pr.dirty", task: card });
  await service.settle();
  const mf = created[0]!;
  await board.recordResult({ taskId: mf.id, agentId: "integrator", ok: true, summary: "resolved", worktree: { path: "/wt", branch: "b" } } satisfies TaskResult);

  // Docs and tests only: no re-review.
  const done = await board.move(mf.id, "done");
  emit({ type: "task.moved", task: done });
  await service.settle();
  expect(created).toHaveLength(1);

  // Product code touched: one re-review, and a replay of the same move adds none.
  files = ["src/services/board.ts", "docs/x.md"];
  emit({ type: "task.moved", task: done });
  emit({ type: "task.moved", task: done });
  await service.settle();
  expect(created).toHaveLength(2);
  const review = created[1]!;
  expect(review.title).toBe(`Re-review merge-forward of PR #7: ${card.id}`);
  expect(review.labels).toEqual(["review"]);
  expect(review.parentTaskId).toBe(mf.id);
  expect(review.body).toContain(`re-review: ${mf.id}`);
  expect(review.body).toContain("src/services/board.ts");
  expect(review.body).not.toContain("- docs/x.md");

  // A card that is not a merge-forward, or one that is still running, is ignored.
  emit({ type: "task.moved", task: await board.move(card.id, "running") });
  emit({ type: "task.moved", task: { ...done, status: "running" } });
  await service.settle();
  expect(created).toHaveLength(2);
  service.stop();
});
