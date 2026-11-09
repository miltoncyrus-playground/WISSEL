// Delivery as a pull request (docs/SDD-coordinator.md §4.5): a real git
// fixture, a fake code host (push + gh) and a fake gate runner.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import type { GateCommandRunner } from "../src/services/merge-gate.ts";
import { deliverAsPullRequest, deliveryBranchName, renderPrBody, validateDelivery } from "../src/services/pr-delivery.ts";
import { validateProjectSettings } from "../src/services/project-settings.ts";
import type { PullRequestDelivery, TaskCard } from "../src/core/types.ts";
import type { TaskWorktree } from "../src/services/worktree.ts";

let dir = "", repo = "";
beforeEach(() => void ((dir = mkdtempSync(join(tmpdir(), "wissel-pr-delivery-"))), (repo = join(dir, "repo"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

const task = { id: "t1", title: "ABC-123 Add the greeting", body: "Say hello.", labels: [], status: "running", createdAt: "2026-01-01T00:00:00.000Z", key: "A4" } as unknown as TaskCard;
const HEAD = "feat/ABC-123-A4-add-the-greeting";
const hostPath = () => join(dir, ".wissel", "deliveries", "t1");

/** A repo on `main`, a card worktree with uncommitted work, and a later commit on main (conflicting if asked). */
async function fixture(conflict = false): Promise<TaskWorktree> {
  await runViaBun(["git", "init", "-q", "-b", "main", repo], { cwd: dir });
  await git(repo, "config", "user.email", "t@example.invalid");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  const path = join(dir, "card-wt");
  await git(repo, "worktree", "add", "-q", "-b", "wissel/t1", path);
  writeFileSync(join(path, "a.txt"), "a from card\n");
  writeFileSync(join(path, "hello.txt"), "hello\n");
  writeFileSync(join(path, ".bashrc"), ""); // sandbox stub: must never land
  writeFileSync(join(repo, conflict ? "a.txt" : "b.txt"), "b from main\n");
  await git(repo, "commit", "-q", "-am", "main moved");
  return { path, branch: "wissel/t1" };
}

function fakeHost(pushFails = false): { calls: string[][]; runner: CommandRunner } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "git" && cmd[1] === "push") return { exitCode: pushFails ? 1 : 0, stdout: "", stderr: pushFails ? "remote: denied" : "" };
    if (cmd[0] === "gh") return { exitCode: 0, stdout: "https://github.com/acme/repo/pull/42\n", stderr: "" };
    throw new Error(`unexpected host command: ${cmd.join(" ")}`);
  };
  return { calls, runner };
}

function fakeGates(verdicts: Record<string, number[]> = {}): { runs: { argv: string[]; cwd: string; timeoutMs: number }[]; runner: GateCommandRunner } {
  const runs: { argv: string[]; cwd: string; timeoutMs: number }[] = [];
  const runner: GateCommandRunner = async (argv, { cwd, timeoutMs }) => {
    runs.push({ argv, cwd, timeoutMs });
    const exitCode = verdicts[argv.join(" ")]?.shift() ?? 0;
    return { exitCode, output: exitCode === 0 ? "ok" : "FAIL: 1 test failed", timedOut: false };
  };
  return { runs, runner };
}

const delivery: PullRequestDelivery = { mode: "pull-request", branchPattern: "feat/{ticket}-{key}-{slug}", prTemplate: "Card {id}: {title}\n\n{body}", hostGates: [["make", "e2e"]], gateRetries: 0, draft: true };

test("green: branches from the base, lands only the card's paths, merges main, gates, pushes, opens a draft PR", async () => {
  const worktree = await fixture();
  const host = fakeHost();
  const gates = fakeGates();
  const res = await deliverAsPullRequest(repo, worktree, task, delivery, { runner: runViaBun, host: host.runner, gateRunner: gates.runner, mergeGate: { commands: [["bun", "test"]], timeoutMs: 1234 }, homeDir: dir });
  expect([res.ok, res.outcome, res.gate.status, res.hostGate.status]).toEqual([true, "opened", "passed", "passed"]);
  expect(res.pr).toEqual({ number: 42, url: "https://github.com/acme/repo/pull/42", head: HEAD });
  // The merge gate ran before the host gates, each in the host worktree under the gate's timeout.
  expect(gates.runs.map((r) => r.argv.join(" "))).toEqual(["bun test", "make e2e"]);
  expect(gates.runs.every((r) => r.cwd === hostPath() && r.timeoutMs === 1234)).toBe(true);
  // Push, then gh with the rendered body onto main; draft requested.
  const [push, gh] = host.calls as [string[], string[]];
  expect(push).toEqual(["git", "push", "-u", "origin", HEAD]);
  expect(gh.slice(0, 3)).toEqual(["gh", "pr", "create"]);
  expect(gh).toContain("--draft");
  expect(gh[gh.indexOf("--body") + 1]).toBe("Card t1: ABC-123 Add the greeting\n\nSay hello.");
  expect(gh[gh.indexOf("--base") + 1]).toBe("main");
  // The PR branch holds the card's work merged with main's later commit; the stub never landed.
  expect(await git(repo, "show", `${HEAD}:a.txt`)).toBe("a from card");
  expect(await git(repo, "show", `${HEAD}:b.txt`)).toBe("b from main");
  expect(await git(repo, "show", `${HEAD}:hello.txt`)).toBe("hello");
  expect((await runViaBun(["git", "cat-file", "-e", `${HEAD}:.bashrc`], { cwd: repo })).exitCode).not.toBe(0);
  expect(await git(repo, "merge-base", "--is-ancestor", "main", HEAD)).toBe("");
  // The host worktree is gone once the PR is open; the card's own worktree is untouched.
  expect([existsSync(hostPath()), existsSync(join(worktree.path, ".bashrc"))]).toEqual([false, true]);
});

test("a red gate after its retry never pushes; gateRetries 0 runs once; a retry that passes pushes", async () => {
  const worktree = await fixture();
  const host = fakeHost();
  const gates = fakeGates({ "bun test": [1, 1] });
  const res = await deliverAsPullRequest(repo, worktree, task, { ...delivery, gateRetries: 1 }, { runner: runViaBun, host: host.runner, gateRunner: gates.runner, mergeGate: { commands: [["bun", "test"]] }, homeDir: dir });
  expect([res.ok, res.outcome, res.pushed, res.pr]).toEqual([false, "gate-failed", false, undefined]);
  expect(host.calls).toEqual([]);
  expect(gates.runs.map((r) => r.argv.join(" "))).toEqual(["bun test", "bun test"]); // retried once, host gates never ran
  expect(existsSync(hostPath())).toBe(false);
  expect((await runViaBun(["git", "rev-parse", "--verify", "-q", `refs/heads/${HEAD}`], { cwd: repo })).exitCode).not.toBe(0);

  const once = fakeGates({ "make e2e": [1, 1] });
  const noRetry = await deliverAsPullRequest(repo, worktree, task, delivery, { runner: runViaBun, host: host.runner, gateRunner: once.runner, homeDir: dir });
  expect([noRetry.outcome, noRetry.gate.status]).toEqual(["gate-failed", "none"]);
  expect(once.runs.map((r) => r.argv.join(" "))).toEqual(["make e2e"]);
  expect(host.calls).toEqual([]);

  const flaky = fakeGates({ "make e2e": [1, 0] });
  const passed = await deliverAsPullRequest(repo, worktree, task, { ...delivery, gateRetries: 1, draft: false }, { runner: runViaBun, host: host.runner, gateRunner: flaky.runner, homeDir: dir });
  expect(passed.outcome).toBe("opened");
  expect(passed.hostGate.runs).toHaveLength(2);
  expect(host.calls[1]).not.toContain("--draft");
});

test("a conflict with main stops before any gate, push or PR; a failed push is an error with no PR", async () => {
  const worktree = await fixture(true);
  const host = fakeHost();
  const gates = fakeGates();
  const res = await deliverAsPullRequest(repo, worktree, task, delivery, { runner: runViaBun, host: host.runner, gateRunner: gates.runner, homeDir: dir });
  expect(res.outcome).toBe("conflict");
  expect(res.message).toContain("a.txt");
  expect([gates.runs, host.calls]).toEqual([[], []]);
  expect(existsSync(hostPath())).toBe(false);

  await git(repo, "checkout", "-q", "HEAD~1", "--", "a.txt"); // main's side undone: no conflict left
  await git(repo, "commit", "-q", "-am", "undo");
  const denied = fakeHost(true);
  const pushFailed = await deliverAsPullRequest(repo, worktree, task, { ...delivery, hostGates: [] }, { runner: runViaBun, host: denied.runner, homeDir: dir });
  expect([pushFailed.outcome, pushFailed.pr]).toEqual(["error", undefined]);
  expect(pushFailed.message).toContain("remote: denied");
  expect(denied.calls).toHaveLength(1);
});

test("branch names and PR bodies render placeholders; a name git would refuse falls back to the card's", () => {
  expect(deliveryBranchName("feat/{ticket}-{key}-{slug}", task)).toBe(HEAD);
  expect(deliveryBranchName("wissel/{id}/{slug}", { ...task, title: "No ticket here!!", key: undefined })).toBe("wissel/t1/no-ticket-here");
  expect(deliveryBranchName("{ticket}-{key}", { ...task, title: "plain", key: undefined })).toBe("wissel/t1");
  expect(deliveryBranchName("wissel/{id}/{nope}", task)).toBe("wissel/t1"); // `{nope}` stays literal, and braces aren't a branch name
  expect(renderPrBody(undefined, task)).toBe("Say hello.\n\ntask: t1");
  expect(renderPrBody("{title} / {key} / {ticket}", task)).toBe("ABC-123 Add the greeting / A4 / ABC-123");
});

test("validateDelivery and the project settings accept both modes and refuse the rest", () => {
  expect(validateDelivery({ mode: "local-merge" })).toEqual({ ok: true, delivery: { mode: "local-merge" } });
  expect(validateDelivery(delivery)).toEqual({ ok: true, delivery });
  const bad = [null, { mode: "email" }, { mode: "pull-request" }, { ...delivery, branchPattern: "../x" }, { ...delivery, hostGates: [[]] }, { ...delivery, gateRetries: 2 }, { ...delivery, draft: "yes" }, { ...delivery, extra: 1 }];
  expect(bad.map((b) => validateDelivery(b).ok)).toEqual(bad.map(() => false));
  expect(validateProjectSettings({ delivery })).toEqual({ ok: true, patch: { delivery } });
  expect(validateProjectSettings({ delivery: null })).toEqual({ ok: true, patch: { delivery: null } });
  expect(validateProjectSettings({ delivery: { mode: "pull-request" } }).ok).toBe(false);
});

test("a pre-existing branch of the rendered name is refused and never deleted; the card's own branch name gets a -pr suffix", async () => {
  const worktree = await fixture();
  await git(repo, "branch", HEAD); // the user's own branch of that name
  const before = await git(repo, "rev-parse", HEAD);
  const res = await deliverAsPullRequest(repo, worktree, task, delivery, { runner: runViaBun, host: fakeHost().runner, gateRunner: fakeGates().runner, homeDir: dir });
  expect([res.ok, res.outcome, res.pushed]).toEqual([false, "error", false]);
  expect(res.message).toContain("already exists");
  expect(await git(repo, "rev-parse", HEAD)).toBe(before); // still there, untouched

  // A pattern that renders to the card's own branch (the fallback) must not collide with the card worktree's checkout.
  await git(repo, "branch", "-D", HEAD);
  const own = await deliverAsPullRequest(repo, worktree, task, { ...delivery, branchPattern: "wissel/{id}" }, { runner: runViaBun, host: fakeHost().runner, gateRunner: fakeGates().runner, homeDir: dir });
  expect([own.ok, own.branch, own.pr?.head]).toEqual([true, "wissel/t1-pr", "wissel/t1-pr"]);
});

test("a card's mergeTarget is the PR base when that branch exists", async () => {
  const worktree = await fixture();
  await git(repo, "branch", "release", "main");
  const host = fakeHost();
  const res = await deliverAsPullRequest(repo, worktree, { ...task, mergeTarget: "release" } as TaskCard, delivery, { runner: runViaBun, host: host.runner, gateRunner: fakeGates().runner, homeDir: dir });
  expect(res.ok).toBe(true);
  const create = host.calls.find((c) => c[0] === "gh")!;
  expect(create[create.indexOf("--base") + 1]).toBe("release");
});
