// Host actions (docs/SDD-coordinator.md §4.3, §4.5, §4.7): pr.open, branch.push
// and pr.arm against a real git repository whose origin is a local bare
// repository, with `gh` faked. Nothing here reaches a real remote.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, TaskCard } from "../src/core/types.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import type { ExecutableAction } from "../src/services/coordinator-executor.ts";
import { hostHandlers } from "../src/services/host-actions.ts";
import type { GateCommandRunner } from "../src/services/merge-gate.ts";

let dir = "", repo = "", origin = "";
const savedHome = process.env.WISSEL_HOME;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-host-actions-"));
  repo = join(dir, "repo");
  origin = join(dir, "origin.git");
  process.env.WISSEL_HOME = join(dir, "home"); // the orchestrator's delivery path reads it; never ~/.wissel
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.WISSEL_HOME;
  else process.env.WISSEL_HOME = savedHome;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const originTip = (branch: string) => git(origin, "rev-parse", branch);

/** A repo on `main` with a bare origin, a PR branch `feat/a4` pushed there, a fix-round card worktree off that branch with
 *  uncommitted work, a card worktree off main for pr.open, and a later commit on main. */
async function fixture() {
  await runViaBun(["git", "init", "-q", "--bare", "-b", "main", origin], { cwd: dir });
  await runViaBun(["git", "init", "-q", "-b", "main", repo], { cwd: dir });
  await git(repo, "config", "user.email", "t@example.invalid");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "-u", "origin", "main");
  await git(repo, "checkout", "-q", "-b", "feat/a4");
  writeFileSync(join(repo, "a.txt"), "a from card\n");
  await git(repo, "commit", "-q", "-am", "A4 add the index");
  await git(repo, "push", "-q", "-u", "origin", "feat/a4");
  await git(repo, "checkout", "-q", "main");
  const fix = join(dir, "fix-wt");
  await git(repo, "worktree", "add", "-q", "-b", "wissel/fix", fix, "feat/a4");
  writeFileSync(join(fix, "hello.txt"), "hello\n");
  const card = join(dir, "card-wt");
  await git(repo, "worktree", "add", "-q", "-b", "wissel/t1", card);
  writeFileSync(join(card, "new.txt"), "new\n");
  writeFileSync(join(repo, "b.txt"), "b from main\n");
  await git(repo, "commit", "-q", "-am", "main moved");
  return { fix: { path: fix, branch: "wissel/fix" }, card: { path: card, branch: "wissel/t1" } };
}

const SHA = "1234567890abcdef1234567890abcdef12345678";
const project: Project = { id: "p1", name: "p", path: "", createdAt: "2026-01-01T00:00:00.000Z", ticketPatterns: ["WS-\\d+"], cardTemplates: { "fix-round": "Round {round} of {key}\n\n{review}\n\nticket {ticket} files {files}" }, delivery: { mode: "pull-request", branchPattern: "feat/{ticket}-{key}-{slug}", hostGates: [["make", "e2e"]], gateRetries: 0, draft: true } } as Project;

function setup(gh: { view?: Record<string, unknown>; failing?: string[] } = {}) {
  const board = new SqliteBoard();
  const calls: string[][] = [];
  const host: CommandRunner = async (cmd, opts) => {
    calls.push(cmd);
    if (cmd[0] !== "gh") return runViaBun(cmd, opts); // real git, against the local bare origin only
    if (cmd[1] === "pr" && cmd[2] === "create") return { exitCode: 0, stdout: "https://github.com/acme/repo/pull/42\n", stderr: "" };
    if (cmd[1] === "pr" && cmd[2] === "view") return { exitCode: 0, stdout: JSON.stringify({ headRefOid: SHA, baseRefName: "main", state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], ...gh.view }), stderr: "" };
    if (cmd[1] === "pr" && cmd[2] === "merge") return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected host command: ${cmd.join(" ")}`);
  };
  const gateRunner: GateCommandRunner = async (argv) => {
    const red = gh.failing?.includes(argv.join(" ")) ?? false;
    return { exitCode: red ? 1 : 0, output: red ? "FAIL: 1 test failed" : "ok", timedOut: false };
  };
  const executed: ExecutableAction[] = [];
  const p = { ...project, path: repo };
  const actions = hostHandlers({
    board, projects: { list: async () => [p] }, settingsFor: async (path) => (path === repo ? p : undefined),
    merge: { runner: runViaBun, host, gateRunner, gateFor: async () => ({ commands: [["bun", "test"]], timeoutMs: 5000 }) },
    execute: async (a) => { executed.push(a); return { outcome: "done", verdict: { verdict: "allow", rule: "test", mode: "live" }, result: undefined }; },
    homeDir: dir, log: () => {},
  });
  const act = (kind: string, payload: Record<string, unknown>, more: Partial<ExecutableAction> = {}): ExecutableAction => ({ kind, workstreamId: "ws-1", projectId: "p1", base: "main", repo, payload, ...more });
  return { board, calls, executed, actions, act };
}

/** No force push anywhere: not `--force`, `-f`, `--force-with-lease`, nor a `+refspec`. */
const forcePushes = (calls: string[][]) => calls.filter((c) => c[0] === "git" && c[1] === "push" && c.some((a) => /^(-f|--force.*)$/.test(a) || a.startsWith("+")));

async function fixRoundCard(board: SqliteBoard, worktree: { path: string; branch: string }): Promise<TaskCard> {
  const card = await board.create({ title: "Fix round 1: A4 add the index (WS-7)", body: "", labels: ["fix-round"], dependsOn: [], repo, key: "A4", round: 1 });
  await board.updateFields(card.id, { pr: { number: 12, url: "https://github.com/acme/repo/pull/12", head: "feat/a4", reviewedSha: SHA } });
  await board.recordResult({ taskId: card.id, agentId: "coder", ok: true, summary: "fixed", worktree });
  return (await board.get(card.id))!;
}

test("branch.push: a green fix round lands on the PR branch at origin with main merged forward, and is never force-pushed", async () => {
  const { fix } = await fixture();
  const { board, calls, executed, actions, act } = setup();
  const card = await fixRoundCard(board, fix);
  const before = await originTip("feat/a4");
  const res = await actions.handlers["branch.push"]!(act("branch.push", { taskId: card.id }));
  expect(res).toMatchObject({ outcome: "pushed", branch: "feat/a4" });
  expect(await originTip("feat/a4")).not.toBe(before);
  expect(await git(origin, "show", "feat/a4:hello.txt")).toBe("hello");
  expect(await git(origin, "show", "feat/a4:b.txt")).toBe("b from main");
  expect(await git(origin, "show", "feat/a4:a.txt")).toBe("a from card");
  expect(await originTip("main")).not.toBe(await originTip("feat/a4")); // main itself was not pushed
  expect(calls.filter((c) => c[1] === "push")).toEqual([["git", "push", "origin", "HEAD:refs/heads/feat/a4"]]);
  expect(forcePushes(calls)).toEqual([]);
  expect(executed).toEqual([]);
});

test("branch.push: a red gate never pushes and starts a fix round through card.start; pushStillGreen says so without pushing", async () => {
  const { fix } = await fixture();
  const { board, calls, executed, actions, act } = setup({ failing: ["make e2e"] });
  const card = await fixRoundCard(board, fix);
  const before = await originTip("feat/a4");
  const check = await actions.pushStillGreen(act("branch.push", { taskId: card.id }));
  expect(check.green).toBe(false);
  expect(check.reason).toContain("FAIL: 1 test failed");
  const res = await actions.handlers["branch.push"]!(act("branch.push", { taskId: card.id }));
  expect(res).toMatchObject({ outcome: "gate-failed", pushed: false });
  expect(await originTip("feat/a4")).toBe(before);
  expect(calls.filter((c) => c[1] === "push")).toEqual([]);
  expect(executed).toHaveLength(1);
  expect(executed[0]).toMatchObject({ kind: "card.start", workstreamId: "ws-1", projectId: "p1", payload: { template: "fix-round", key: "A4", round: 2, labels: ["fix-round"], title: expect.stringContaining("Fix round 2"), optional: ["key", "ticket", "files"] } });
  expect((executed[0]!.payload!.vars as Record<string, string>).review).toContain("FAIL: 1 test failed");
  expect((executed[0]!.payload!.vars as Record<string, string>).ticket).toBe("WS-7");
  // Green again: the re-check passes and pushes nothing by itself.
  const green = setup();
  const card2 = await fixRoundCard(green.board, fix);
  expect(await green.actions.pushStillGreen(green.act("branch.push", { taskId: card2.id }))).toEqual({ green: true });
  expect(await originTip("feat/a4")).toBe(before);
  expect(forcePushes([...calls, ...green.calls])).toEqual([]);
});

test("pr.arm: refuses when the head sha moved past the reviewed one, refuses red checks, arms with --auto --squash when both hold", async () => {
  await fixture();
  const moved = setup({ view: { headRefOid: "feedfacefeedfacefeedfacefeedfacefeedface" } });
  const card = await fixRoundCard(moved.board, { path: join(dir, "fix-wt"), branch: "wissel/fix" });
  const arm = { taskId: card.id, pr: 12, url: card.pr!.url };
  await expect(moved.actions.handlers["pr.arm"]!(moved.act("pr.arm", arm, { checks: "green", own: true }))).rejects.toThrow(/head .*feedface.* is not the reviewed .*12345678/);
  expect(moved.calls.some((c) => c[0] === "gh" && c[2] === "merge")).toBe(false);

  const red = setup({ view: { statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }] } });
  const card2 = await fixRoundCard(red.board, { path: join(dir, "fix-wt"), branch: "wissel/fix" });
  await expect(red.actions.handlers["pr.arm"]!(red.act("pr.arm", { ...arm, taskId: card2.id }))).rejects.toThrow(/checks are failing \(ci\)/);
  expect(red.calls.some((c) => c[0] === "gh" && c[2] === "merge")).toBe(false);

  const ok = setup();
  const card3 = await fixRoundCard(ok.board, { path: join(dir, "fix-wt"), branch: "wissel/fix" });
  expect(await ok.actions.handlers["pr.arm"]!(ok.act("pr.arm", { ...arm, taskId: card3.id }))).toEqual({ armed: true, number: 12, sha: SHA });
  expect(ok.calls.filter((c) => c[0] === "gh")).toEqual([["gh", "pr", "view", "12", "--json", "headRefOid,baseRefName,state,statusCheckRollup"], ["gh", "pr", "merge", "12", "--auto", "--squash"]]);
  // A card whose review never recorded a sha has nothing to compare against.
  const bare = setup();
  const card4 = await bare.board.create({ title: "x", body: "", labels: [], dependsOn: [], repo });
  await bare.board.updateFields(card4.id, { pr: { number: 12, url: "u", head: "feat/a4" } });
  await expect(bare.actions.handlers["pr.arm"]!(bare.act("pr.arm", { taskId: card4.id, pr: 12 }))).rejects.toThrow(/no reviewed sha/);
});

test("pr.open delivers the card's worktree through the orchestrator's pull-request path and records TaskCard.pr; local-merge projects are refused", async () => {
  const { card: wt } = await fixture();
  const { board, calls, actions, act } = setup();
  const card = await board.create({ title: "WS-7 Add the new file", body: "Add it.", labels: [], dependsOn: [], repo, key: "A5" });
  await board.recordResult({ taskId: card.id, agentId: "coder", ok: true, summary: "done", worktree: wt });
  expect(await actions.handlers["pr.open"]!(act("pr.open", { taskId: card.id }))).toEqual({ outcome: "landed", pr: { number: 42, url: "https://github.com/acme/repo/pull/42", head: "feat/WS-7-A5-add-the-new-file" } });
  expect((await board.get(card.id))!.pr).toEqual({ number: 42, url: "https://github.com/acme/repo/pull/42", head: "feat/WS-7-A5-add-the-new-file" });
  expect(await git(origin, "show", "feat/WS-7-A5-add-the-new-file:new.txt")).toBe("new");
  expect(calls.filter((c) => c[0] === "gh").map((c) => c.slice(0, 3))).toEqual([["gh", "pr", "create"]]);
  expect(forcePushes(calls)).toEqual([]);

  const local = setup();
  const p = { ...project, path: repo, delivery: { mode: "local-merge" as const } };
  const localActions = hostHandlers({ board: local.board, projects: { list: async () => [p] }, settingsFor: async () => p, merge: { runner: runViaBun }, execute: async () => { throw new Error("unused"); }, log: () => {} });
  const card2 = await local.board.create({ title: "y", body: "", labels: [], dependsOn: [], repo });
  await local.board.recordResult({ taskId: card2.id, agentId: "coder", ok: true, summary: "done", worktree: wt });
  await expect(localActions.handlers["pr.open"]!(act("pr.open", { taskId: card2.id }))).rejects.toThrow(/delivery is not pull-request/);
});
