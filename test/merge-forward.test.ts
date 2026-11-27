import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { mergeTaskWorktree, type MergeContext } from "../src/services/worktree.ts";
import { liveMergeForward, mergeForward, MERGE_FORWARD_LABEL } from "../src/services/merge-forward.ts";
import { PrWatcher } from "../src/services/pr-watcher.ts";
import type { CodeHost, PullRequestDelivery } from "../src/services/delivery.ts";
import type { TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.7, phase 2 card 10: a dirty PR gets one
// merge-forward card; a clean merge of main is pushed as a fast-forward
// to the same PR, a conflict goes to the conflict integrator first.

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const DELIVERY: PullRequestDelivery = { mode: "pull-request", branchPattern: "feat/{key}-{slug}", hostGates: [], gateRetries: 0, draft: true };
const BRANCH = "feat/A4-add-a-greeting";
const registry = await Registry.load();

let dir: string, origin: string, repo: string, other: string, wt: string;
let board: SqliteBoard;
let card: TaskCard;
let opened: number;
let ctx: MergeContext;

/** Upstream main moves on: `file` gets `text` on a commit pushed by
 *  someone else. */
function upstream(file: string, text: string) {
  git(["checkout", "-q", "main"], other);
  git(["pull", "-q", "origin", "main"], other);
  writeFileSync(join(other, file), text);
  git(["add", "--", file], other);
  git(["commit", "-q", "-m", `upstream ${file}`], other);
  git(["push", "-q", "origin", "main"], other);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "wissel-merge-forward-"));
  origin = join(dir, "origin.git");
  repo = join(dir, "repo");
  other = join(dir, "other");
  git(["init", "-q", "--bare", "-b", "main", origin], dir);
  git(["clone", "-q", origin, repo], dir);
  git(["config", "user.email", "t@x"], repo);
  git(["config", "user.name", "t"], repo);
  writeFileSync(join(repo, "hello.txt"), "base\n");
  git(["add", "--", "hello.txt"], repo);
  git(["commit", "-q", "-m", "base"], repo);
  git(["push", "-q", "origin", "main"], repo);
  git(["clone", "-q", origin, other], dir);
  wt = join(dir, "wt");
  git(["worktree", "add", "-q", "-b", "wissel/t1", wt, "HEAD"], repo);
  writeFileSync(join(wt, "hello.txt"), "hello from the card\n");

  board = new SqliteBoard();
  card = await board.create({ title: "Add a greeting", body: "Greet.", labels: [], repo, key: "A4" });
  await board.recordResult({ taskId: card.id, agentId: "implementer", ok: true, summary: "done", worktree: { path: wt, branch: "wissel/t1" } });
  opened = 0;
  let pr: { number: number; url: string } | undefined;
  const host: CodeHost = {
    findOpen: async () => pr,
    open: async () => (opened++, (pr = { number: 9, url: "https://github.com/o/r/pull/9" }), { ok: true, ...pr }),
  };
  ctx = { runner: runViaBun, deliveryFor: async () => ({ delivery: DELIVERY }), codeHost: host, recordPullRequest: async (id, p) => void (await board.setPullRequest(id, p)) };
  const first = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, card, ctx);
  expect(first.outcome).toBe("delivered");
  await board.move(card.id, "done");
  card = (await board.get(card.id))!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("re-delivery", () => {
  test("a second delivery of the same card pushes as a fast-forward to the same PR and moves its head", async () => {
    const firstHead = card.pr!.head;
    writeFileSync(join(wt, "more.txt"), "a fix round's change\n");
    const again = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, card, ctx);
    expect(again.outcome).toBe("delivered");
    const remote = git(["rev-parse", `refs/heads/${BRANCH}`], origin);
    expect(git(["merge-base", "--is-ancestor", firstHead, remote], origin)).toBe("");
    expect(opened).toBe(1);
    expect((await board.get(card.id))!.pr!.head).toBe(remote);
  });
});

describe("merge-forward", () => {
  test("main moved without conflict: one card, delivered, the PR head now has main's change", async () => {
    upstream("CHANGELOG.md", "upstream\n");
    expect(await mergeForward({ board, registry, merge: ctx, log: () => {} }, card)).toBe("delivered");
    const remote = git(["rev-parse", `refs/heads/${BRANCH}`], origin);
    expect(git(["show", `${remote}:CHANGELOG.md`], origin)).toBe("upstream");
    expect(git(["show", `${remote}:hello.txt`], origin)).toBe("hello from the card");
    const cards = (await board.list()).filter((t) => t.labels.includes(MERGE_FORWARD_LABEL));
    expect(cards.map((t) => [t.status, t.parentTaskId, t.key])).toEqual([["done", card.id, "A4"]]);
    expect(opened).toBe(1);
  });

  test("a conflict waits on the conflict integrator, starts no second card, and is delivered once it has finished", async () => {
    upstream("hello.txt", "hello from main\n");
    const deps = { board, registry, merge: ctx, log: () => {} };
    expect(await mergeForward(deps, card)).toBe("waiting");
    expect(await mergeForward(deps, card)).toBe("waiting");
    const mf = (await liveMergeForward(board, card))!;
    expect(mf.status).toBe("review");
    const integrator = (await board.list()).find((t) => t.title === `Resolve merge conflict: ${card.id}`)!;
    expect(integrator).toBeDefined();
    expect(readFileSync(join(wt, "hello.txt"), "utf8")).toContain("<<<<<<<");

    // The integrator resolves it in the worktree and finishes.
    writeFileSync(join(wt, "hello.txt"), "hello from the card and from main\n");
    await board.move(integrator.id, "done");
    expect(await mergeForward(deps, card)).toBe("delivered");
    const remote = git(["rev-parse", `refs/heads/${BRANCH}`], origin);
    expect(git(["show", `${remote}:hello.txt`], origin)).toBe("hello from the card and from main");
    expect((await board.list()).filter((t) => t.labels.includes(MERGE_FORWARD_LABEL)).map((t) => t.status)).toEqual(["done"]);
    expect((await board.get(mf.id))!.routedTo).toBe("wissel-merge-forward");
  });

  test("the watcher calls merge-forward on every look at a dirty PR, and not on a clean one", async () => {
    const seen: string[] = [];
    let state = "DIRTY";
    const runner: CommandRunner = async (cmd) => {
      if (cmd[0] === "git") return { stdout: "git@github.com:o/r.git\n", stderr: "", exitCode: 0 };
      return { stdout: JSON.stringify({ number: 9, state: "OPEN", isDraft: true, mergeable: state === "DIRTY" ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: state, headRefOid: card.pr!.head, baseRefName: "main", autoMergeRequest: null, statusCheckRollup: [] }), stderr: "", exitCode: 0 };
    };
    const watcher = new PrWatcher({ cards: () => board.list(), setPullRequest: (id, p) => board.setPullRequest(id, p), runner, mainBranchFor: async () => "main", onDirty: async (c) => void seen.push(c.id), log: () => {} });
    await watcher.tick();
    await watcher.tick();
    state = "CLEAN";
    await watcher.tick();
    expect(seen).toEqual([card.id, card.id]);
  });
});
