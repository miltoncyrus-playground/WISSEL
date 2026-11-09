import { expect, test } from "bun:test";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { PrRef, TaskCard } from "../src/core/types.ts";
import { SqliteBoard, type BoardEvent } from "../src/services/board.ts";
import { getProjectPrs, startPrWatcher, watchPr, type ProjectPrs, type PullRequest } from "../src/services/github-status.ts";

// The PR watcher (docs/SDD-coordinator.md §4.7): every card with `pr`
// set is polled; checks, mergeability and merged/closed become persisted
// state on the card and pr.* board events. Arming is not here.

const NOW = "2026-11-09T10:00:00.000Z";

const livePr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  title: "t",
  url: "https://github.com/acme/repo/pull/7",
  branch: "feat/ABC-1-a4-x",
  state: "open",
  mergeable: "MERGEABLE",
  headSha: "aaa111",
  checks: { state: "pending", total: 2, failing: [] },
  ...over,
});

const cardWith = (pr: PrRef): Pick<TaskCard, "pr"> => ({ pr });
const base: PrRef = { number: 7, url: "https://github.com/acme/repo/pull/7", head: "feat/ABC-1-a4-x" };

test("first look at an open PR persists its state and stays landed", () => {
  const out = watchPr(cardWith(base), livePr(), NOW);
  if (!out) throw new Error("expected a change");
  expect(out.pr.lifecycle).toBe("landed");
  expect(out.pr.watch).toEqual({ sha: "aaa111", checks: "pending", mergeable: "clean", state: "open", at: NOW });
  // Pending checks are not finished: no event yet.
  expect(out.events).toEqual([]);
  // The reference fields the delivery wrote are kept as they were.
  expect(out.pr.number).toBe(7);
  expect(out.pr.head).toBe("feat/ABC-1-a4-x");
});

test("finished checks emit pr.checks with the sha they ran on; nothing changed emits nothing", () => {
  const first = watchPr(cardWith(base), livePr(), NOW)!;
  const green = watchPr(cardWith(first.pr), livePr({ checks: { state: "passing", total: 2, failing: [] } }), NOW);
  expect(green?.events).toEqual([{ kind: "pr.checks", checks: "passing", sha: "aaa111" }]);
  expect(green?.pr.lifecycle).toBe("landed"); // no review passed on this sha yet
  expect(watchPr(cardWith(green!.pr), livePr({ checks: { state: "passing", total: 2, failing: [] } }), "2026-11-09T10:01:00.000Z")).toBeUndefined();
  // A push moves the head: the same green state on a new sha is a new event.
  const pushed = watchPr(cardWith(green!.pr), livePr({ headSha: "bbb222", checks: { state: "failing", total: 2, failing: ["fast"] } }), NOW);
  expect(pushed?.events).toEqual([{ kind: "pr.checks", checks: "failing", sha: "bbb222" }]);
  expect(pushed?.pr.watch?.sha).toBe("bbb222");
});

test("ready needs the review to have passed on the head sha and green checks on that sha", () => {
  const reviewed: PrRef = { ...base, reviewedSha: "aaa111" };
  const green = livePr({ checks: { state: "passing", total: 1, failing: [] } });
  expect(watchPr(cardWith(reviewed), green, NOW)?.pr.lifecycle).toBe("ready");
  expect(watchPr(cardWith(reviewed), livePr({ checks: { state: "failing", total: 1, failing: ["x"] } }), NOW)?.pr.lifecycle).toBe("landed");
  expect(watchPr(cardWith({ ...base, reviewedSha: "old000" }), green, NOW)?.pr.lifecycle).toBe("landed");
  // Armed counts as open for readiness; a push after review drops ready.
  const ready = watchPr(cardWith(reviewed), { ...green, armed: true }, NOW)!;
  expect(ready.pr.watch?.state).toBe("armed");
  expect(ready.pr.lifecycle).toBe("ready");
  expect(watchPr(cardWith(ready.pr), { ...green, armed: true, headSha: "ccc333" }, NOW)?.pr.lifecycle).toBe("landed");
});

test("DIRTY emits pr.dirty once; merged emits pr.merged and ends the lifecycle; closed is terminal", () => {
  const first = watchPr(cardWith(base), livePr(), NOW)!;
  const dirty = watchPr(cardWith(first.pr), livePr({ mergeable: "CONFLICTING" }), NOW)!;
  expect(dirty.pr.watch?.mergeable).toBe("dirty");
  expect(dirty.events).toEqual([{ kind: "pr.dirty" }]);
  expect(watchPr(cardWith(dirty.pr), livePr({ mergeable: "CONFLICTING" }), NOW)).toBeUndefined();
  const blocked = watchPr(cardWith(dirty.pr), livePr({ mergeStateStatus: "BLOCKED" }), NOW)!;
  expect(blocked.pr.watch?.mergeable).toBe("blocked");
  expect(blocked.events).toEqual([]);

  const merged = watchPr(cardWith(blocked.pr), livePr({ state: "merged", checks: { state: "passing", total: 2, failing: [] } }), NOW)!;
  expect(merged.pr.lifecycle).toBe("merged");
  expect(merged.pr.watch?.state).toBe("merged");
  expect(merged.events).toEqual([{ kind: "pr.checks", checks: "passing", sha: "aaa111" }, { kind: "pr.merged" }]);

  const closed = watchPr(cardWith(first.pr), livePr({ state: "closed" }), NOW)!;
  expect(closed.pr.watch?.state).toBe("closed");
  expect(closed.pr.lifecycle).toBe("landed");
  expect(closed.events).toEqual([]);
});

test("gh answers carry the head sha, auto-merge and merge state", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "git") return { exitCode: 0, stdout: "git@github.com:acme/repo.git", stderr: "" };
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify([
        { number: 7, headRefName: "b", state: "OPEN", headRefOid: "deadbeef", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", autoMergeRequest: { enabledAt: NOW }, statusCheckRollup: [] },
        { number: 8, headRefName: "c", state: "OPEN", autoMergeRequest: null, statusCheckRollup: [] },
      ]),
    };
  };
  const out = await getProjectPrs("/p", runner);
  if ("error" in out) throw new Error(out.error);
  const seven = out.prs.find((p) => p.number === 7)!;
  expect(seven.headSha).toBe("deadbeef");
  expect(seven.armed).toBe(true);
  expect(seven.mergeStateStatus).toBe("BLOCKED");
  const eight = out.prs.find((p) => p.number === 8)!;
  expect(eight.armed).toBeUndefined();
  expect(eight.headSha).toBeUndefined();
  const fields = calls[1]![calls[1]!.indexOf("--json") + 1]!;
  for (const f of ["headRefOid", "autoMergeRequest", "mergeStateStatus"]) expect(fields.split(",")).toContain(f);
});

test("the watcher polls once per repo, persists changes on the card and emits pr.* board events", async () => {
  const board = new SqliteBoard();
  const a = await board.create({ title: "a", body: "", labels: [], repo: "/repo-one" });
  const b = await board.create({ title: "b", body: "", labels: [], repo: "/repo-one" });
  const other = await board.create({ title: "no pr", body: "", labels: [], repo: "/repo-one" });
  const elsewhere = await board.create({ title: "c", body: "", labels: [], repo: "/repo-two" });
  await board.updateFields(a.id, { pr: { number: 1, url: "u1", head: "h1" } });
  await board.updateFields(b.id, { pr: { number: 2, url: "u2", head: "h2", reviewedSha: "s2" } });
  await board.updateFields(elsewhere.id, { pr: { number: 3, url: "u3", head: "h3" } });

  const polled: string[] = [];
  let answer: Record<string, ProjectPrs | { error: string }> = {
    "/repo-one": { repo: "acme/one", prs: [livePr({ number: 1, headSha: "s1", checks: { state: "passing", total: 1, failing: [] } }), livePr({ number: 2, headSha: "s2", checks: { state: "passing", total: 1, failing: [] } })] },
    "/repo-two": { error: "gh: not logged in" },
  };
  const events: BoardEvent[] = [];
  board.events.on("event", (e: BoardEvent) => {
    if (e.type.startsWith("pr.")) events.push(e);
  });
  const watcher = startPrWatcher({
    board,
    prsOf: async (path) => {
      polled.push(path);
      return answer[path] ?? { error: "unknown" };
    },
    now: () => Date.parse(NOW),
    setInterval: () => 0,
    clearInterval: () => {},
    logger: { warn: () => {} },
  });
  await watcher.tick();
  expect(polled.sort()).toEqual(["/repo-one", "/repo-two"]);
  expect((await board.get(a.id))!.pr).toEqual({ number: 1, url: "u1", head: "h1", lifecycle: "landed", watch: { sha: "s1", checks: "passing", mergeable: "clean", state: "open", at: NOW } });
  expect((await board.get(b.id))!.pr?.lifecycle).toBe("ready");
  expect((await board.get(other.id))!.pr).toBeUndefined();
  // A failed read leaves the card as it was, to be retried next tick.
  expect((await board.get(elsewhere.id))!.pr?.watch).toBeUndefined();
  expect(events.map((e) => [e.type, "task" in e ? e.task.id : ""])).toEqual([["pr.checks", a.id], ["pr.checks", b.id]]);
  const checks = events[0]!;
  if (checks.type !== "pr.checks") throw new Error("expected pr.checks");
  expect(checks.sha).toBe("s1");
  expect(checks.checks).toBe("passing");

  // Nothing changed: no writes, no events.
  events.length = 0;
  await watcher.tick();
  expect(events).toEqual([]);

  // Merge of #1: pr.merged once, then #1 is no longer polled while #2 still is.
  answer = { ...answer, "/repo-one": { repo: "acme/one", prs: [livePr({ number: 1, headSha: "s1", state: "merged", checks: { state: "passing", total: 1, failing: [] } }), livePr({ number: 2, headSha: "s2", checks: { state: "passing", total: 1, failing: [] } })] } };
  await watcher.tick();
  expect(events.map((e) => e.type)).toEqual(["pr.merged"]);
  expect((await board.get(a.id))!.pr?.lifecycle).toBe("merged");
  expect((await board.get(a.id))!.status).toBe("inbox"); // the existing status is never touched
  events.length = 0;
  polled.length = 0;
  answer = { ...answer, "/repo-one": { repo: "acme/one", prs: [livePr({ number: 1, headSha: "zzz", state: "merged" }), livePr({ number: 2, headSha: "s2", mergeable: "CONFLICTING", checks: { state: "passing", total: 1, failing: [] } })] } };
  await watcher.tick();
  expect(events.map((e) => e.type)).toEqual(["pr.dirty"]);
  expect((await board.get(a.id))!.pr?.watch?.sha).toBe("s1");

  // Only terminal cards left on a repo: it is not polled at all.
  await board.updateFields(elsewhere.id, { pr: undefined });
  await board.updateFields(b.id, { pr: { number: 2, url: "u2", head: "h2", watch: { sha: "s2", checks: "passing", mergeable: "clean", state: "closed", at: NOW } } });
  polled.length = 0;
  await watcher.tick();
  expect(polled).toEqual([]);
  watcher.stop();
});
