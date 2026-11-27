import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { mergeTaskWorktree, type MergeContext } from "../src/services/worktree.ts";
import { deliveryBranch, pullRequestText, slugOf, validateDelivery, withRetry, type CodeHost, type PullRequestDelivery } from "../src/services/delivery.ts";
import type { GateCommandRunner } from "../src/services/merge-gate.ts";
import type { TaskCard, TaskPullRequest } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.5, phase 2 card 7: a finished card in a
// pull-request project is built against the remote's main branch, gated,
// pushed to its own branch (never forced) and opened as a PR; the user's
// checkout is never touched.

const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...ENV } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const PR_DELIVERY: PullRequestDelivery = { mode: "pull-request", branchPattern: "feat/{key?}-{slug}", hostGates: [], gateRetries: 0, draft: true };

describe("settings and naming", () => {
  test("validateDelivery: local-merge reads back as none; pull-request needs a per-card branch pattern; bad fields are refused", () => {
    expect(validateDelivery({ mode: "local-merge" })).toEqual({ ok: true, delivery: null });
    expect(validateDelivery({ mode: "pull-request", branchPattern: "feat/{key?}-{slug}", hostGates: [["bun", "test"]] })).toEqual({
      ok: true,
      delivery: { mode: "pull-request", branchPattern: "feat/{key?}-{slug}", hostGates: [["bun", "test"]], gateRetries: 0, draft: true },
    });
    expect(validateDelivery({ mode: "pull-request", branchPattern: "feat/fixed" })).toMatchObject({ ok: false, error: expect.stringContaining("its own branch") });
    expect(validateDelivery({ mode: "pull-request", branchPattern: "feat/{slug}", gateRetries: 2 })).toMatchObject({ ok: false, error: expect.stringContaining("0 or 1") });
    expect(validateDelivery({ mode: "pull-request", branchPattern: "feat/{slug}", force: true })).toMatchObject({ ok: false, error: expect.stringContaining('"force"') });
    expect(validateDelivery({ mode: "pull-request", branchPattern: "feat/{slug}", hostGates: "bun test" }).ok).toBe(false);
    expect(validateDelivery({ mode: "squash" }).ok).toBe(false);
  });

  test("the branch comes from the pattern; empty optional parts close up; main and other long-lived branches are refused", () => {
    const task = { id: "1234abcd-0000", title: "Add retries to the importer!", key: "A4" };
    expect(slugOf(task.title)).toBe("add-retries-to-the-importer");
    expect(deliveryBranch(PR_DELIVERY, task, undefined, "main")).toEqual({ ok: true, branch: "feat/A4-add-retries-to-the-importer" });
    expect(deliveryBranch(PR_DELIVERY, { ...task, key: undefined }, undefined, "main")).toEqual({ ok: true, branch: "feat/add-retries-to-the-importer" });
    expect(deliveryBranch({ ...PR_DELIVERY, branchPattern: "{ticket}-{id8}" }, task, undefined, "main")).toMatchObject({ ok: false, error: expect.stringContaining("{ticket}") });
    expect(deliveryBranch({ ...PR_DELIVERY, branchPattern: "{key}" }, { ...task, key: "main" }, undefined, "trunk")).toMatchObject({ ok: false, error: expect.stringContaining("never goes to the main branch") });
    expect(deliveryBranch({ ...PR_DELIVERY, branchPattern: "{key}" }, { ...task, key: "dev" }, undefined, "dev")).toMatchObject({ ok: false });
  });

  test("the PR body ends with the attribution chain; a template renders from the card", () => {
    const task = { id: "card-1", title: "Add retries", body: "Retry the import three times.", key: "A4" };
    const plain = pullRequestText(PR_DELIVERY, task, { principalId: "owner", policyRevision: "r3", summary: "Done; tests pass." });
    expect(plain.title).toBe("A4: Add retries");
    expect(plain.body).toBe("Retry the import three times.\n\n## What the agent reported\n\nDone; tests pass.\n\n---\nWissel card card-1 (A4), authorized by owner, policy r3.");
    const templated = pullRequestText({ ...PR_DELIVERY, prTemplate: "## {key}\n{title}" }, task, { principalId: "alice" });
    expect(templated.body).toBe("## A4\nAdd retries\n\n---\nWissel card card-1 (A4), authorized by alice.");
  });

  test("withRetry re-runs a failed command once, and only when asked", async () => {
    let n = 0;
    const flaky = async () => ({ exitCode: n++ === 0 ? 1 : 0, timedOut: false });
    expect((await withRetry(flaky, 1)([], {})).exitCode).toBe(0);
    n = 0;
    expect((await withRetry(flaky, 0)([], {})).exitCode).toBe(1);
  });
});

describe("delivering through the merge path (real git)", () => {
  let dir: string;
  let origin: string;
  let repo: string;
  let wt: string;
  const task: TaskCard = { id: "t1abcdef-1111", title: "Add a greeting", body: "Write hello.txt.", labels: [], status: "review", repo: "", key: "A4", authorizedByPrincipalId: "owner" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-delivery-"));
    origin = join(dir, "origin.git");
    repo = join(dir, "repo");
    git(["init", "-q", "--bare", "-b", "main", origin], dir);
    git(["clone", "-q", origin, repo], dir);
    git(["config", "user.email", "t@x"], repo);
    git(["config", "user.name", "t"], repo);
    writeFileSync(join(repo, "README.md"), "base\n");
    git(["add", "--", "README.md"], repo);
    git(["commit", "-q", "-m", "base"], repo);
    git(["push", "-q", "origin", "main"], repo);
    wt = join(dir, "wt");
    git(["worktree", "add", "-q", "-b", "wissel/t1", wt, "HEAD"], repo);
    writeFileSync(join(wt, "hello.txt"), "hello\n");
    // Upstream moves on after the card started: the PR must contain it.
    const other = join(dir, "other");
    git(["clone", "-q", origin, other], dir);
    writeFileSync(join(other, "CHANGELOG.md"), "upstream\n");
    git(["add", "--", "CHANGELOG.md"], other);
    git(["commit", "-q", "-m", "upstream change"], other);
    git(["push", "-q", "origin", "main"], other);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function ctx(over: Partial<MergeContext> & { delivery?: PullRequestDelivery } = {}) {
    const opened: Array<{ branch: string; base: string; title: string; body: string; draft: boolean }> = [];
    const recorded: TaskPullRequest[] = [];
    const host: CodeHost = over.codeHost ?? {
      findOpen: async () => undefined,
      open: async (_repo, req) => (opened.push(req), { ok: true, number: 42, url: "https://github.com/o/r/pull/42" }),
    };
    const c: MergeContext = {
      runner: runViaBun,
      deliveryFor: async () => ({ delivery: over.delivery ?? PR_DELIVERY }),
      codeHost: host,
      prContext: async () => ({ principalId: "owner", policyRevision: "r1" }),
      recordPullRequest: async (_id, pr) => void recorded.push(pr),
      ...over,
    };
    return { c, opened, recorded };
  }

  test("delivered: built on the fetched remote main, pushed to the card's branch, opened as a draft PR, recorded; the checkout untouched and the worktree kept", async () => {
    const headBefore = git(["rev-parse", "HEAD"], repo);
    const { c, opened, recorded } = ctx();
    const res = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, c, async () => {
      throw new Error("a delivered card is not a landed merge");
    });
    expect(res).toMatchObject({ ok: true, outcome: "delivered", pr: { number: 42, url: "https://github.com/o/r/pull/42" } });
    const pushed = git(["rev-parse", "refs/heads/feat/A4-add-a-greeting"], origin);
    expect(res.pr!.head).toBe(pushed);
    expect(recorded).toEqual([res.pr!]);
    // The PR head merges upstream main and has the card's file.
    expect(git(["show", `${pushed}:CHANGELOG.md`], origin)).toBe("upstream");
    expect(git(["show", `${pushed}:hello.txt`], origin)).toBe("hello");
    expect(opened).toEqual([{ branch: "feat/A4-add-a-greeting", base: "main", title: "A4: Add a greeting", body: expect.stringContaining("Wissel card t1abcdef-1111 (A4), authorized by owner, policy r1."), draft: true }]);
    expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
    expect(existsSync(wt)).toBe(true);
    expect(git(["rev-parse", "refs/heads/main"], origin)).not.toBe(pushed);
  });

  test("an open PR for the branch is reused, not opened twice", async () => {
    let openCalls = 0;
    const { c } = ctx({ codeHost: { findOpen: async () => ({ number: 7, url: "https://github.com/o/r/pull/7" }), open: async () => (openCalls++, { ok: false, error: "x" }) } });
    const res = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, c);
    expect(res).toMatchObject({ outcome: "delivered", pr: { number: 7 } });
    expect(openCalls).toBe(0);
  });

  test("a red host gate stops before anything is pushed; gateRetries 1 re-runs it once", async () => {
    let calls = 0;
    const gateRunner: GateCommandRunner = async () => ({ exitCode: calls++ === 0 ? 1 : 0, output: "flaky", timedOut: false });
    const red = ctx({ delivery: { ...PR_DELIVERY, hostGates: [["bun", "test"]] }, gateRunner });
    const failed = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, red.c);
    expect(failed.outcome).toBe("gate-failed");
    expect(red.opened).toEqual([]);
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "refs/heads/feat/A4-add-a-greeting"], { cwd: origin }).exitCode).not.toBe(0);

    calls = 0;
    const retried = ctx({ delivery: { ...PR_DELIVERY, hostGates: [["bun", "test"]], gateRetries: 1 }, gateRunner });
    const ok = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, retried.c);
    expect(ok.outcome).toBe("delivered");
    expect(calls).toBe(2);
  });

  test("a rejected push stops and reports: nothing is forced and no PR is opened", async () => {
    // Someone else's commit already sits on the card's branch upstream.
    const other = join(dir, "other");
    git(["checkout", "-q", "-b", "feat/A4-add-a-greeting"], other);
    writeFileSync(join(other, "theirs.txt"), "theirs\n");
    git(["add", "--", "theirs.txt"], other);
    git(["commit", "-q", "-m", "theirs"], other);
    git(["push", "-q", "origin", "feat/A4-add-a-greeting"], other);
    const theirs = git(["rev-parse", "refs/heads/feat/A4-add-a-greeting"], origin);
    const { c, opened } = ctx();
    const res = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, c);
    expect(res).toMatchObject({ ok: false, outcome: "error", message: expect.stringContaining("never forces a push") });
    expect(opened).toEqual([]);
    expect(git(["rev-parse", "refs/heads/feat/A4-add-a-greeting"], origin)).toBe(theirs);
  });

  test("with no delivery setting the card lands in the checkout as before", async () => {
    const res = await mergeTaskWorktree(repo, { path: wt, branch: "wissel/t1" }, { ...task, repo }, { runner: runViaBun, deliveryFor: async () => undefined });
    expect(res.outcome).toBe("landed");
    expect(existsSync(join(repo, "hello.txt"))).toBe(true);
  });
});

test("delivery is a project setting: stored through POST /projects/:id/settings' validation, local-merge clears it", async () => {
  const { validateProjectSettings } = await import("../src/services/project-settings.ts");
  expect(validateProjectSettings({ delivery: { mode: "pull-request", branchPattern: "feat/{slug}" } })).toEqual({
    ok: true,
    patch: { delivery: { mode: "pull-request", branchPattern: "feat/{slug}", hostGates: [], gateRetries: 0, draft: true } },
  });
  expect(validateProjectSettings({ delivery: { mode: "local-merge" } })).toEqual({ ok: true, patch: { delivery: null } });
  expect(validateProjectSettings({ delivery: { mode: "pull-request" } }).ok).toBe(false);
});
