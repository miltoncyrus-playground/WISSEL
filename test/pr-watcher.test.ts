import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { prChanges, PrWatcher, readPrWatch, watchedCards, type PrChangedEvent } from "../src/services/pr-watcher.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { PrWatch } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.7, phase 2 card 9: watch every delivered
// card's PR (checks on which head, mergeable, armed, merged), keep it on
// the card, turn each change into an event, and say when it may be armed.

const REVIEWED = "a".repeat(40);
const NOW = new Date("2026-11-27T12:00:00Z");
const pass = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];
const fail = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }];
const open = (over: Record<string, unknown> = {}) => ({ number: 12, state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: REVIEWED, baseRefName: "main", autoMergeRequest: null, statusCheckRollup: pass, ...over });

describe("reading a PR", () => {
  test("ready only when it is the reviewed head on main, every check green, clean, open and not a draft", () => {
    const w = readPrWatch(open(), { head: REVIEWED }, "main", NOW)!;
    expect(w).toEqual({ lifecycle: "ready", checks: { state: "passing", headSha: REVIEWED, failing: [] }, mergeable: "clean", armed: false, draft: false, base: "main", armBlockedBy: null, observedAt: NOW.toISOString() });
    const why = (over: Record<string, unknown>) => readPrWatch(open(over), { head: REVIEWED }, "main", NOW)!;
    expect(why({ headRefOid: "b".repeat(40) })).toMatchObject({ lifecycle: "landed", armBlockedBy: expect.stringContaining("is not the reviewed") });
    expect(why({ statusCheckRollup: fail })).toMatchObject({ lifecycle: "landed", armBlockedBy: "checks are failing (test)" });
    expect(why({ statusCheckRollup: [] }).armBlockedBy).toBe("no check has run on it");
    expect(why({ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" })).toMatchObject({ mergeable: "dirty", armBlockedBy: "it is dirty, not clean" });
    expect(why({ mergeStateStatus: "BEHIND" }).mergeable).toBe("behind");
    expect(why({ isDraft: true }).armBlockedBy).toBe("the PR is a draft");
    expect(why({ baseRefName: "release" }).armBlockedBy).toBe("its base is release, not main");
    expect(why({ autoMergeRequest: { enabledAt: "x" } }).armed).toBe(true);
  });

  test("merged and closed are final; an unreadable answer is nothing", () => {
    expect(readPrWatch(open({ state: "MERGED" }), { head: REVIEWED }, "main", NOW)!.lifecycle).toBe("merged");
    expect(readPrWatch(open({ state: "CLOSED" }), { head: REVIEWED }, "main", NOW)).toMatchObject({ lifecycle: "closed", armBlockedBy: "the PR is closed" });
    expect(readPrWatch({ state: "OPEN" }, { head: REVIEWED }, "main", NOW)).toBeUndefined();
  });

  test("prChanges names what moved, and nothing when only the time of the look did", () => {
    const a = readPrWatch(open({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS" }] }), { head: REVIEWED }, "main", NOW)!;
    const b = readPrWatch(open(), { head: REVIEWED }, "main", new Date(NOW.getTime() + 60_000))!;
    expect(prChanges(undefined, a)).toEqual(["first look: landed, checks pending, clean"]);
    expect(prChanges(a, b)).toEqual(["landed -> ready", "checks pending -> passing"]);
    expect(prChanges(b, { ...b, observedAt: "later" } as PrWatch)).toEqual([]);
  });
});

describe("the watcher", () => {
  function fakeGh(answer: () => Record<string, unknown> | "fail") {
    const calls: string[][] = [];
    const runner: CommandRunner = async (cmd) => {
      calls.push(cmd);
      if (cmd[0] === "git" && cmd[1] === "remote") return { stdout: "git@github.com:o/r.git\n", stderr: "", exitCode: 0 };
      if (cmd[0] === "gh") {
        const a = answer();
        return a === "fail" ? { stdout: "", stderr: "gh: not logged in", exitCode: 1 } : { stdout: JSON.stringify(a), stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 1 };
    };
    return { runner, calls };
  }

  async function setup(answer: () => Record<string, unknown> | "fail") {
    const board = new SqliteBoard();
    const card = await board.create({ title: "Add retries", body: "", labels: [], repo: "/repo", key: "A4" });
    await board.setPullRequest(card.id, { number: 12, url: "https://github.com/o/r/pull/12", head: REVIEWED });
    await board.move(card.id, "done");
    const events: PrChangedEvent[] = [];
    const gh = fakeGh(answer);
    const watcher = new PrWatcher({ cards: () => board.list(), setPullRequest: (id, pr) => board.setPullRequest(id, pr), runner: gh.runner, mainBranchFor: async () => "main", record: async (e) => void events.push(e), log: () => {}, now: () => NOW });
    return { board, card, watcher, events, gh };
  }

  test("a first look records the PR on the card and one event; an unchanged look records nothing; merged stops the watching", async () => {
    let answer: Record<string, unknown> = open({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "QUEUED" }] });
    const { board, card, watcher, events, gh } = await setup(() => answer);
    expect(await watcher.tick()).toBe(1);
    expect((await board.get(card.id))!.pr!.watch).toMatchObject({ lifecycle: "landed", checks: { state: "pending" } });
    expect(gh.calls.find((c) => c[0] === "gh")).toEqual(["gh", "pr", "view", "12", "--repo", "o/r", "--json", "number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,autoMergeRequest,statusCheckRollup"]);
    expect(await watcher.tick()).toBe(0);
    answer = open();
    expect(await watcher.tick()).toBe(1);
    expect(events.map((e) => [e.lifecycle, e.changes])).toEqual([
      ["landed", ["first look: landed, checks pending, clean"]],
      ["ready", ["landed -> ready", "checks pending -> passing"]],
    ]);
    answer = open({ state: "MERGED" });
    await watcher.tick();
    expect((await board.get(card.id))!.pr!.watch!.lifecycle).toBe("merged");
    expect(watchedCards(await board.list())).toEqual([]);
    const ghCalls = gh.calls.filter((c) => c[0] === "gh").length;
    await watcher.tick();
    expect(gh.calls.filter((c) => c[0] === "gh").length).toBe(ghCalls);
  });

  test("a PR gh can't read is skipped, not marked", async () => {
    const { board, card, watcher, events } = await setup(() => "fail");
    expect(await watcher.tick()).toBe(0);
    expect((await board.get(card.id))!.pr!.watch).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("GET /admin/pr-watch lists watched cards; POST looks again now", async () => {
    const board = new SqliteBoard();
    const card = await board.create({ title: "Add retries", body: "", labels: [], repo: "/repo" });
    await board.setPullRequest(card.id, { number: 12, url: "https://github.com/o/r/pull/12", head: REVIEWED });
    const gh = fakeGh(() => open());
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), prWatchRunner: gh.runner });
    const before = (await (await app(new Request("http://x/admin/pr-watch"))).json()) as Array<{ pr: { watch?: unknown } }>;
    expect(before[0]!.pr.watch).toBeUndefined();
    const after = (await (await app(new Request("http://x/admin/pr-watch", { method: "POST" }))).json()) as Array<{ pr: { watch?: { lifecycle: string } } }>;
    expect(after[0]!.pr.watch?.lifecycle).toBe("ready");
  });
});
