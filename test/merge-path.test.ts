// The merge path (mergeTaskWorktree, docs/SDD-worktree-isolation.md
// §7), against real git in temp repos: gate in the worktree,
// fast-forward-only landing, the per-repo lock, the recorded merge sha.
// No LLM, no network; every gate command is a real `sh` process.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { mergeTask } from "../src/services/board-actions.ts";
import { Registry } from "../src/core/registry.ts";
import { conflictIntegratorHead, finishResult, MAX_CONFLICT_INTEGRATORS, MAX_PUSHBACKS } from "../src/core/orchestrator.ts";
import { Router } from "../src/core/router.ts";
import { reconcileLandedMerges } from "../src/core/crash-recovery.ts";
import {
  createTaskWorktree,
  determineWorktreeMergeState,
  findConflictMarkers,
  looksBinary,
  mergeTaskWorktree,
  parseUnmergedZ,
  unresolvedFiles,
  type MergeContext,
  type TaskWorktree,
} from "../src/services/worktree.ts";
import type { TelemetryEvent } from "../src/services/telemetry.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

function gitOk(args: string[], cwd: string): boolean {
  return Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}

let root: string;
let repo: string;
let home: string;
let board: SqliteBoard;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wissel-merge-path-"));
  repo = join(root, "repo");
  home = join(root, "home");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "wissel-test@example.com"], repo);
  git(["config", "user.name", "wissel test"], repo);
  writeFileSync(join(repo, "shared.txt"), "line 1\nline 2\nline 3\n");
  writeFileSync(join(repo, "other.txt"), "other\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "start"], repo);
  board = new SqliteBoard();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A card with a real worktree, `files` written into it uncommitted (as
 *  an implementer leaves it), and a recorded result pointing at it. */
async function cardWithWork(files: Record<string, string>, extra: Partial<TaskCard> = {}): Promise<{ task: TaskCard; worktree: TaskWorktree }> {
  const task = await board.create({ title: extra.title ?? "Do the thing", body: "Body.", labels: [], repo, ...extra });
  const wt = await createTaskWorktree(repo, task.id, { runner: runViaBun, homeDir: home });
  if ("error" in wt) throw new Error(wt.error);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(wt.path, name), content);
  await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "done", worktree: wt });
  return { task: (await board.get(task.id))!, worktree: wt };
}

function commitOnMain(name: string, content: string, message = `human edit ${name}`): string {
  writeFileSync(join(repo, name), content);
  git(["add", name], repo);
  git(["commit", "-q", "-m", message], repo);
  return git(["rev-parse", "HEAD"], repo);
}

function telemetrySink(): { events: TelemetryEvent[]; sink: { record(e: TelemetryEvent): Promise<void> } } {
  const events: TelemetryEvent[] = [];
  return { events, sink: { record: async (e) => void events.push(e) } };
}

const PASS = [["sh", "-c", "echo checks ok"]];
const failGate = (marker: string) => [["sh", "-c", `echo before; echo ${marker} >&2; exit 3`]];

function ctx(gate: string[][] | undefined, extra: Partial<MergeContext> = {}): MergeContext & { events: TelemetryEvent[] } {
  const { events, sink } = telemetrySink();
  return { runner: runViaBun, gateFor: async () => (gate ? { commands: gate } : undefined), telemetry: sink, events, ...extra };
}

const mergeEvents = (events: TelemetryEvent[]) => events.filter((e): e is Extract<TelemetryEvent, { type: "merge" }> => e.type === "merge");

// ---------- 1. gate pass -> ff landing ----------

test("gate pass: lands by fast-forward, the user's checkout never gets MERGE_HEAD, and the result records mergedSha", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "new feature\n" });
  const base = git(["rev-parse", "HEAD"], repo);
  const c = ctx(PASS);

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  const head = git(["rev-parse", "HEAD"], repo);
  // HEAD is the landing commit: parents [old HEAD, branch tip], the
  // subject every digest counts by.
  expect(git(["log", "-1", "--format=%s", head], repo)).toBe(`Merge ${worktree.branch}: Do the thing`);
  expect(git(["log", "-1", "--format=%P", head], repo).split(" ")[0]).toBe(base);
  expect(git(["log", "-1", "--format=%P", head], repo).split(" ")).toHaveLength(2);
  expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("new feature\n");
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  // The reflog shows a fast-forward, never a merge, in the user's checkout.
  expect(git(["reflog", "-1", "--format=%gs"], repo)).toContain("Fast-forward");

  const result = await board.getResult(task.id);
  expect(result!.mergedSha).toBe(head);
  expect(result!.mergedAt).toBeString();
  expect((await board.get(task.id))!.status).toBe("done");
  expect(existsSync(worktree.path)).toBe(false);
  expect(gitOk(["rev-parse", "--verify", worktree.branch], repo)).toBe(false);

  const [ev] = mergeEvents(c.events);
  expect(ev).toMatchObject({ taskId: task.id, repo, outcome: "landed", gate: "passed", landedSha: head });
  expect(ev!.gateRuns).toEqual([{ argv: PASS[0]!, exitCode: 0, durationMs: expect.any(Number), timedOut: false }]);
  expect(ev!.lockWaitMs).toBeGreaterThanOrEqual(0);
  expect(ev!.lockHoldMs).toBeGreaterThanOrEqual(0);
});

test("the gate runs in the worktree on the merged result: it sees both main's new commit and the branch's work", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  commitOnMain("main-only.txt", "m\n");
  const gate = [["sh", "-c", "test -f feature.txt && test -f main-only.txt && ! test -e .git/MERGE_HEAD"]];

  const out = await mergeTask(board, task.id, ctx(gate));

  expect(out.ok).toBe(true);
  expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("f\n");
  expect(readFileSync(join(repo, "main-only.txt"), "utf8")).toBe("m\n");
});

// ---------- 2. gate fail -> pushback ----------

test("gate fail: nothing lands, the card goes back as a pushback carrying the gate output, and the count increments", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "broken\n" });
  const before = git(["rev-parse", "HEAD"], repo);
  const c = ctx(failGate("TEST-FAILED-MARKER"));

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (out.ok) return;
  expect(out.status).toBe(409);
  expect(out.error).toContain("Merge gate failed");
  expect(out.error).toContain("exited 3");
  expect(git(["rev-parse", "HEAD"], repo)).toBe(before);
  expect(existsSync(join(repo, "feature.txt"))).toBe(false);
  expect((await board.getResult(task.id))!.mergedSha).toBeUndefined();
  // The worktree is back on its branch, untouched, for the re-attempt.
  expect(git(["rev-parse", "--abbrev-ref", "HEAD"], worktree.path)).toBe(worktree.branch);
  expect(readFileSync(join(worktree.path, "feature.txt"), "utf8")).toBe("broken\n");

  const original = (await board.get(task.id))!;
  expect(original.supersededBy).toBeString();
  const next = (await board.get(original.supersededBy!))!;
  expect(next.pushbackCount).toBe(1);
  expect(next.reviewLineageId).toBe(task.id);
  expect(next.body).toContain("Merge gate feedback (attempt 1)");
  expect(next.body).toContain("TEST-FAILED-MARKER");
  expect(next.body).toContain("before");
  expect(next.body).toContain("sh -c");

  expect(mergeEvents(c.events)[0]).toMatchObject({ outcome: "gate-failed", gate: "failed" });
  expect(mergeEvents(c.events)[0]!.gateRuns[0]!.exitCode).toBe(3);
});

test("gate fail at the pushback cap escalates instead of spawning another attempt", async () => {
  const { task } = await cardWithWork({ "feature.txt": "broken\n" }, { pushbackCount: MAX_PUSHBACKS, reviewLineageId: undefined });

  const out = await mergeTask(board, task.id, ctx(failGate("STILL-BROKEN")));

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("Escalated");
  const after = (await board.get(task.id))!;
  expect(after.status).toBe("escalated");
  expect(after.supersededBy).toBeUndefined();
  expect(after.escalationContext).toContain("STILL-BROKEN");
  expect((await board.list()).filter((t) => t.id !== task.id)).toHaveLength(0);
});

test("the gate output given back is the last 200 lines, not the whole log", async () => {
  const { task } = await cardWithWork({ "feature.txt": "x\n" });
  const gate = [["sh", "-c", "i=1; while [ $i -le 500 ]; do echo line-$i; i=$((i+1)); done; exit 1"]];

  await mergeTask(board, task.id, ctx(gate));

  const next = (await board.get((await board.get(task.id))!.supersededBy!))!;
  expect(next.body).toContain("line-500");
  expect(next.body).toContain("line-301");
  expect(next.body).not.toContain("line-300\n");
});

test("a gate command that runs past its timeout is killed and counts as a failure", async () => {
  const { task } = await cardWithWork({ "feature.txt": "x\n" });
  const c: MergeContext & { events: TelemetryEvent[] } = { ...ctx(undefined), gateFor: async () => ({ commands: [["sh", "-c", "echo started; sleep 30"]], timeoutMs: 300 }) };
  const t0 = Date.now();

  const out = await mergeTaskWorktree(repo, (await board.getResult(task.id))!.worktree!, task, c);

  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(out.outcome).toBe("gate-failed");
  expect(out.gate.runs[0]).toMatchObject({ timedOut: true, exitCode: null });
  expect(out.message).toContain("timed out");
  expect(out.message).toContain("started");
});

test("a gate failure on the auto-merge path goes through the same pushback loop as a reviewer's changes_requested", async () => {
  const agent: AgentDef = {
    id: "trusted-auto",
    name: "Trusted auto",
    kind: "agent",
    tier: "write",
    description: "d",
    whenToUse: "w",
    tags: [],
    executor: "handoff",
    inputs: [],
    outputs: [],
    trustLevel: "high",
    toolAccess: [],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.1 },
    autoMerge: true,
  };
  const registry = Registry.from([agent]);
  const task = await board.create({ title: "Auto thing", body: "B", labels: [], repo });
  await board.move(task.id, "running");
  const wt = await createTaskWorktree(repo, task.id, { runner: runViaBun, homeDir: home });
  if ("error" in wt) throw new Error(wt.error);
  writeFileSync(join(wt.path, "auto.txt"), "auto\n");

  await finishResult(board, registry, { taskId: task.id, agentId: "trusted-auto", ok: true, summary: "done", worktree: wt }, undefined, ctx(failGate("AUTO-GATE")));

  const after = (await board.get(task.id))!;
  expect(after.status).toBe("review");
  const next = (await board.get(after.supersededBy!))!;
  expect(next.pushbackCount).toBe(1);
  expect(next.body).toContain("AUTO-GATE");
  expect(existsSync(join(repo, "auto.txt"))).toBe(false);
});

// ---------- 3. conflict with main ----------

test("conflict with main: merged in the worktree only, the user's checkout untouched, one integrator spawned", async () => {
  const registry = await Registry.load();
  const { task, worktree } = await cardWithWork({ "shared.txt": "line 1\nbranch edit\nline 3\n" });
  commitOnMain("shared.txt", "line 1\nmain edit\nline 3\n");
  const headBefore = git(["rev-parse", "HEAD"], repo);
  const bytesBefore = readFileSync(join(repo, "shared.txt"));
  const c = ctx(PASS);

  const first = await mergeTask(board, task.id, c, registry);
  const second = await mergeTask(board, task.id, c, registry);

  expect(first.ok).toBe(false);
  if (!first.ok) expect(first.error).toContain("conflict");
  expect(second.ok).toBe(false);
  // The user's checkout: same HEAD, same bytes, no merge in progress.
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
  expect(readFileSync(join(repo, "shared.txt")).equals(bytesBefore)).toBe(true);
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  expect(git(["status", "--porcelain"], repo)).toBe("");
  // The conflict is in the worktree, waiting.
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
  expect(readFileSync(join(worktree.path, "shared.txt"), "utf8")).toContain("<<<<<<<");

  const integrators = (await board.list()).filter((t) => t.labels.includes("conflict"));
  expect(integrators).toHaveLength(1);
  expect(integrators[0]!.title).toBe(`Resolve merge conflict: ${task.id}`);
  expect(integrators[0]!.extraAllowedDirs).toEqual([worktree.path]);
  // Read-only git grants: the sandbox denies add/commit in the worktree
  // (the repo's .git holds its gitdir), so Wissel commits the resolution.
  expect(integrators[0]!.extraAllowedTools).toEqual([`Bash(git -C ${worktree.path} status:*)`, `Bash(git -C ${worktree.path} diff:*)`]);
  expect(integrators[0]!.body).toContain("You cannot commit");
  expect(integrators[0]!.body).toContain("Wissel finishes the merge itself");
  expect(integrators[0]!.body).not.toContain(`git -C ${worktree.path} commit`);
  expect(integrators[0]!.body).not.toContain(`git -C ${worktree.path} add`);
  expect(integrators[0]!.body).toContain(worktree.path);
  expect(mergeEvents(c.events).map((e) => e.outcome)).toEqual(["conflict", "conflict"]);
});

test("a conflict resolved in the worktree with --no-edit lands as exactly one landing commit", async () => {
  const { task, worktree } = await cardWithWork({ "shared.txt": "line 1\nbranch edit\nline 3\n" });
  commitOnMain("shared.txt", "line 1\nmain edit\nline 3\n");
  await mergeTask(board, task.id, ctx(PASS));

  // What the integrator does: resolve, add, commit --no-edit, in the worktree.
  writeFileSync(join(worktree.path, "shared.txt"), "line 1\nmain edit\nbranch edit\nline 3\n");
  git(["add", "shared.txt"], worktree.path);
  git(["commit", "-q", "--no-edit"], worktree.path);

  const out = await mergeTask(board, task.id, ctx(PASS));

  expect(out.ok).toBe(true);
  expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("line 1\nmain edit\nbranch edit\nline 3\n");
  const landings = git(["log", "--merges", "--format=%s"], repo).split("\n").filter((s) => s.startsWith(`Merge ${worktree.branch}:`));
  expect(landings).toHaveLength(1);
});

// ---------- 3b. Wissel finishes a resolved conflict merge ----------

const RESOLVED = "line 1\nmain edit\nbranch edit\nline 3\n";

/** A card whose merge conflicted with main, its integrator card spawned
 *  (real registry), the conflict left in the worktree as git made it. */
async function conflictedCard(c: MergeContext, registry = Registry.load()): Promise<{ task: TaskCard; worktree: TaskWorktree; integrator: TaskCard }> {
  const { task, worktree } = await cardWithWork({ "shared.txt": "line 1\nbranch edit\nline 3\n" });
  commitOnMain("shared.txt", "line 1\nmain edit\nline 3\n");
  const first = await mergeTask(board, task.id, c, await registry);
  expect(first.ok).toBe(false);
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
  const integrator = (await board.list()).find((t) => t.title === `Resolve merge conflict: ${task.id}`)!;
  expect(integrator).toBeDefined();
  return { task, worktree, integrator };
}

const landingSubject = (branch: string) => git(["log", "--merges", "--format=%s"], repo).split("\n").filter((s) => s.startsWith(`Merge ${branch}:`));

test("resolved, uncommitted merge with a finished integrator: Wissel commits it with the prepared message, gates it, and lands it", async () => {
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c);
  const headBefore = git(["rev-parse", "HEAD"], repo);
  // What the integrator can do in its sandbox: edit the file. No git add, no commit.
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  await board.move(integrator.id, "review");

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  if (out.ok) {
    expect(out.value.message).toContain(`finished the conflict merge resolved by card ${integrator.id}`);
    expect(out.value.message).toContain("gate passed");
  }
  expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(RESOLVED);
  // The commit git prepared in the worktree: parents are the branch tip
  // and the repo's old HEAD (in that order, as `git merge` in the
  // worktree makes them; the same shape a human's --no-edit produces).
  const parents = git(["log", "-1", "--format=%P", "HEAD"], repo).split(" ");
  expect(parents).toHaveLength(2);
  expect(parents).toContain(headBefore);
  // The prepared MERGE_MSG is the landing message, free of git's
  // "# Conflicts:" comment lines, and it landed exactly once.
  expect(git(["log", "-1", "--format=%B", "HEAD"], repo)).toBe(`Merge ${worktree.branch}: Do the thing`);
  expect(landingSubject(worktree.branch)).toHaveLength(1);
  expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
  expect((await board.get(task.id))!.status).toBe("done");
  expect((await board.getResult(task.id))!.mergedSha).toBe(git(["rev-parse", "HEAD"], repo));
  expect(existsSync(worktree.path)).toBe(false);
  // One merge event per attempt, the second carrying the trace.
  const events = mergeEvents(c.events);
  expect(events.map((e) => e.outcome)).toEqual(["conflict", "landed"]);
  expect(events[1]!.resolvedConflictBy).toBe(integrator.id);
  expect(events[1]!.gate).toBe("passed");
  expect(events[0]!.resolvedConflictBy).toBeUndefined();
});

test("regression (card 32c60ba0, 2026-10-19): the resolved worktree is no longer refused with 'has an unfinished merge ... git commit --no-edit'", async () => {
  // Card 32c60ba0: the integrator resolved shared.txt in the worktree,
  // could not commit (sandbox), finished on done; Merge then answered
  // the message below and a human had to run git by hand.
  const c = ctx(undefined);
  const { task, worktree, integrator } = await conflictedCard(c);
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  await board.move(integrator.id, "done");
  const oldRefusal = `${worktree.path} has an unfinished merge of ${repo}'s HEAD into ${worktree.branch}. Resolve the conflicts there, then \`git commit --no-edit\`, then merge again.`;

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  if (!out.ok) expect(out.error).not.toBe(oldRefusal);
  expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(RESOLVED);
  expect(landingSubject(worktree.branch)).toHaveLength(1);
  expect(mergeEvents(c.events).map((e) => e.outcome)).toEqual(["conflict", "landed"]);
});

test("markers left in a file: refused, naming the file and lines, nothing committed, no duplicate integrator", async () => {
  const registry = await Registry.load();
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c, Promise.resolve(registry));
  const headBefore = git(["rev-parse", "HEAD"], repo);
  const branchBefore = git(["rev-parse", worktree.branch], repo);
  // The integrator "finished" but left the file exactly as git made it.
  await board.move(integrator.id, "review");
  expect(readFileSync(join(worktree.path, "shared.txt"), "utf8")).toContain("<<<<<<<");

  const out = await mergeTask(board, task.id, c, registry);

  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.status).toBe(409);
    expect(out.error).toContain(`${worktree.path} has an unfinished merge of ${repo}'s HEAD (${headBefore.slice(0, 12)}) into ${worktree.branch}:`);
    expect(out.error).toContain("conflict markers are still in shared.txt:2,4,6");
  }
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
  expect(git(["rev-parse", worktree.branch], repo)).toBe(branchBefore);
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
  expect((await board.list()).filter((t) => t.labels.includes("conflict"))).toHaveLength(1);
  expect(mergeEvents(c.events).map((e) => e.outcome)).toEqual(["conflict", "conflict"]);
  expect(mergeEvents(c.events)[1]!.message).toContain("shared.txt:2,4,6");
});

test("a partial resolve (one marker line left) is refused the same way", async () => {
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c);
  writeFileSync(join(worktree.path, "shared.txt"), "line 1\nmain edit\n=======\nbranch edit\nline 3\n");
  await board.move(integrator.id, "done");

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("shared.txt:3");
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
});

test("no finished integrator: refused, saying which card and status, even with every marker gone", async () => {
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c);
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  // Still inbox: a human may be mid-resolve in that worktree.
  expect(integrator.status).toBe("inbox");

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toContain(`the conflict integrator card ${integrator.id} is inbox, not finished (review or done)`);
    expect(out.error).toContain("git add -A && git commit --no-edit");
  }
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
  expect(readFileSync(join(worktree.path, "shared.txt"), "utf8")).toBe(RESOLVED);
  expect(mergeEvents(c.events).map((e) => e.outcome)).toEqual(["conflict", "conflict"]);

  // The old way still works: a human finishes it by hand.
  git(["add", "-A"], worktree.path);
  git(["commit", "-q", "--no-edit"], worktree.path);
  const again = await mergeTask(board, task.id, c);
  expect(again.ok).toBe(true);
  expect(landingSubject(worktree.branch)).toHaveLength(1);
});

test("no integrator card at all (none registered): refused, saying so", async () => {
  const noIntegrator = Registry.from([]);
  const c = ctx(PASS);
  const { task, worktree } = await cardWithWork({ "shared.txt": "line 1\nbranch edit\nline 3\n" });
  commitOnMain("shared.txt", "line 1\nmain edit\nline 3\n");
  expect((await mergeTask(board, task.id, c, noIntegrator)).ok).toBe(false);
  expect((await board.list()).filter((t) => t.labels.includes("conflict"))).toHaveLength(0);
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);

  const out = await mergeTask(board, task.id, c, noIntegrator);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain(`no conflict integrator card ("Resolve merge conflict: ${task.id}") exists for this task`);
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
});

test("a bare CommandRunner (no board) never commits an unfinished merge", async () => {
  const { task, worktree, integrator } = await conflictedCard(ctx(PASS));
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  await board.move(integrator.id, "done");

  const res = await mergeTaskWorktree(repo, worktree, task, runViaBun);

  expect(res.outcome).toBe("conflict");
  expect(res.message).toContain("no board to check the conflict integrator against");
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
});

test("a finished resolution that fails the gate goes back through pushback; the resolution commit stays on the branch", async () => {
  const c = ctx(failGate("RESOLUTION-BROKE-IT"));
  const { task, worktree, integrator } = await conflictedCard(c);
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  await board.move(integrator.id, "review");
  const headBefore = git(["rev-parse", "HEAD"], repo);

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("Merge gate failed");
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
  // Committed in the worktree (no merge in progress), not landed.
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(false);
  expect(git(["log", "-1", "--format=%s", worktree.branch], repo)).toBe(`Merge ${worktree.branch}: Do the thing`);
  const next = (await board.get((await board.get(task.id))!.supersededBy!))!;
  expect(next.pushbackCount).toBe(1);
  expect(next.body).toContain("RESOLUTION-BROKE-IT");
  const [, second] = mergeEvents(c.events);
  expect(second).toMatchObject({ outcome: "gate-failed", resolvedConflictBy: integrator.id });
});

test("a binary file still unmerged is refused: nothing in it says whether it was resolved", async () => {
  const c = ctx(PASS);
  const { task, worktree } = await cardWithWork({});
  writeFileSync(join(worktree.path, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x09, 0x08]));
  git(["add", "blob.bin"], repo);
  git(["commit", "-q", "-m", "blob on main"], repo);
  expect((await mergeTask(board, task.id, c, await Registry.load())).ok).toBe(false);
  const integrator = (await board.list()).find((t) => t.labels.includes("conflict"))!;
  await board.move(integrator.id, "done");

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("blob.bin (binary, unmerged)");
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
});

test("a binary file the merge brought in cleanly is not a reason to refuse", async () => {
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c);
  // Main also added a binary; it reached the worktree staged, unconflicted.
  expect(readFileSync(join(worktree.path, "shared.txt"), "utf8")).toContain("<<<<<<<");
  writeFileSync(join(worktree.path, "shared.txt"), RESOLVED);
  writeFileSync(join(worktree.path, "icon.bin"), Buffer.from([0x00, 0x01]));
  git(["add", "icon.bin"], worktree.path);
  await board.move(integrator.id, "done");

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  expect(existsSync(join(repo, "icon.bin"))).toBe(true);
});

test("a modify/delete conflict resolved by deleting the file is committed as the deletion", async () => {
  const registry = await Registry.load();
  const c = ctx(PASS);
  const { task, worktree } = await cardWithWork({});
  rmSync(join(worktree.path, "shared.txt"));
  commitOnMain("shared.txt", "line 1\nmain edit\nline 3\n");
  expect((await mergeTask(board, task.id, c, registry)).ok).toBe(false);
  // git leaves main's version in the worktree for a modify/delete; the
  // integrator decides the deletion stands and removes it.
  expect(existsSync(join(worktree.path, "shared.txt"))).toBe(true);
  rmSync(join(worktree.path, "shared.txt"));
  const integrator = (await board.list()).find((t) => t.labels.includes("conflict"))!;
  await board.move(integrator.id, "review");

  const out = await mergeTask(board, task.id, c, registry);

  expect(out.ok).toBe(true);
  expect(existsSync(join(repo, "shared.txt"))).toBe(false);
  expect(landingSubject(worktree.branch)).toHaveLength(1);
});

test("a clean worktree lands exactly as before: no conflict finishing, no trace of it", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  const c = ctx(PASS);
  let asked = 0;
  c.conflictIntegrator = async () => (asked++, { finished: false, reason: "never asked" });

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  if (out.ok) expect(out.value.message).not.toContain("conflict");
  expect(asked).toBe(0);
  const [ev] = mergeEvents(c.events);
  expect(ev!.outcome).toBe("landed");
  expect(ev!.resolvedConflictBy).toBeUndefined();
  expect(mergeEvents(c.events)).toHaveLength(1);
});

test("findConflictMarkers: the three git markers and diff3's, by line, CRLF included; look-alikes are not markers", () => {
  const text = ["a", "<<<<<<< HEAD", "ours", "||||||| base", "orig", "=======", "theirs", ">>>>>>> abc123 (main)", "z"].join("\n");
  expect(findConflictMarkers(text)).toEqual([2, 4, 6, 8]);
  expect(findConflictMarkers("a\r\n=======\r\nb\r\n")).toEqual([2]);
  expect(findConflictMarkers("<<<<<<<\n>>>>>>>\n")).toEqual([1, 2]);
  expect(findConflictMarkers("Title\n========\n")).toEqual([]);
  expect(findConflictMarkers("======= not alone\n<<<<<<<< eight\n >>>>>>> indented\nconst s = '<<<<<<< x';\n")).toEqual([]);
  expect(findConflictMarkers("")).toEqual([]);
});

test("parseUnmergedZ and looksBinary", () => {
  const z = ["100644 aaaa 1\tshared.txt", "100644 bbbb 2\tshared.txt", "100644 cccc 3\tshared.txt", "100644 dddd 2\tdir/with space.txt", ""].join("\0");
  expect(parseUnmergedZ(z)).toEqual(["shared.txt", "dir/with space.txt"]);
  expect(parseUnmergedZ("")).toEqual([]);
  expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e]))).toBe(false);
  expect(looksBinary(new Uint8Array([0x41, 0x00]))).toBe(true);
  expect(looksBinary(new Uint8Array(0))).toBe(false);
  // A NUL past the first 8000 bytes doesn't count, as in git.
  const late = new Uint8Array(8001);
  late.fill(0x41);
  late[8000] = 0;
  expect(looksBinary(late)).toBe(false);
});

test("unresolvedFiles: markers in unmerged or changed files, binary only when unmerged, missing files skipped", () => {
  const dir = join(root, "scan");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "ok.txt"), "fine\n");
  writeFileSync(join(dir, "sub", "bad.txt"), "x\n<<<<<<< HEAD\ny\n");
  writeFileSync(join(dir, "pic.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(dir, "logo.bin"), Buffer.from([0, 3]));
  expect(unresolvedFiles(dir, ["ok.txt", "pic.bin", "gone.txt"], ["sub/bad.txt", "logo.bin", "sub"])).toEqual(["pic.bin (binary, unmerged)", "sub/bad.txt:2"]);
  expect(unresolvedFiles(dir, [], ["ok.txt", "logo.bin"])).toEqual([]);
});

// ---------- 3c. another attempt when the repo moves again (§7.9) ----------

const integratorsOf = async (taskId: string) => (await board.list()).filter((t) => t.title === `Resolve merge conflict: ${taskId}` && t.labels.includes("conflict"));

/** What the integrator leaves: the file edited in the worktree, nothing
 *  committed, its card finished. */
async function integratorResolves(worktree: TaskWorktree, integrator: TaskCard, content: string): Promise<void> {
  writeFileSync(join(worktree.path, "shared.txt"), content);
  await board.move(integrator.id, "done");
}

/** Round `i` of main moving under the card: main rewrites line 2 (the
 *  line every resolution so far also rewrote), so the next merge of
 *  HEAD into the branch conflicts again on it. Returns the new HEAD. */
const mainMovesAgain = (i: number) => commitOnMain("shared.txt", `line 1\nmain edit ${i}\nline 3\n`, `other card lands ${i}`);
const resolvedWith = (i: number) => `line 1\nmain edit ${i} + branch edit\nline 3\n`;

test("regression (card 42d2bbfb, 2026-10-19): the repo moves again after the first conflict is resolved; the second conflict gets its own integrator, keyed on the new HEAD, and the first card is untouched", async () => {
  const registry = await Registry.load();
  const c = ctx(PASS);
  const { task, worktree, integrator: first } = await conflictedCard(c, Promise.resolve(registry));
  const headA = git(["rev-parse", "HEAD"], repo);
  expect(conflictIntegratorHead(first)).toBe(headA);
  expect(first.body.startsWith(`conflict-head: ${headA}\n`)).toBe(true);
  expect(first.body).toContain(`current HEAD (${headA.slice(0, 12)})`);
  expect(first.body).not.toContain("conflict 1 of");
  await integratorResolves(worktree, first, resolvedWith(1));
  const firstAfter = (await board.get(first.id))!;
  // Another card lands first: HEAD moves on, on the same line.
  const headB = mainMovesAgain(2);

  const out = await mergeTask(board, task.id, c, registry);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain(`conflict merging ${repo}'s HEAD (${headB.slice(0, 12)})`);
  // The first resolution was committed (MERGE_HEAD is now the new one)
  // and the new conflict sits in the worktree.
  expect(git(["rev-parse", "MERGE_HEAD"], worktree.path)).toBe(headB);
  expect(readFileSync(join(worktree.path, "shared.txt"), "utf8")).toContain("<<<<<<<");
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headB);

  const integrators = await integratorsOf(task.id);
  expect(integrators).toHaveLength(2);
  const second = integrators.find((t) => t.id !== first.id)!;
  expect(second.title).toBe(`Resolve merge conflict: ${task.id}`);
  expect(second.labels).toEqual(["conflict"]);
  expect(second.status).toBe("inbox");
  expect(conflictIntegratorHead(second)).toBe(headB);
  expect(second.body.startsWith(`conflict-head: ${headB}\n`)).toBe(true);
  // Names the current conflict only: the new HEAD, this merge's output,
  // the attempt number and the earlier card's id; never the old HEAD.
  expect(second.body).toContain(`conflict 2 of at most ${MAX_CONFLICT_INTEGRATORS}`);
  expect(second.body).toContain(`an earlier integrator card`);
  expect(second.body).toContain(`(${first.id})`);
  expect(second.body).toContain("Only the\nconflict described below is open");
  expect(second.body).toContain("CONFLICT (content): Merge conflict in shared.txt");
  expect(second.body).not.toContain(headA);
  expect(second.body).not.toContain(headA.slice(0, 12));
  expect(second.extraAllowedDirs).toEqual([worktree.path]);
  expect(second.extraAllowedTools).toEqual([`Bash(git -C ${worktree.path} status:*)`, `Bash(git -C ${worktree.path} diff:*)`]);
  // The first card is exactly as it was: not reopened, not rewritten.
  expect(await board.get(first.id)).toEqual(firstAfter);
  // The label routes the new card to the integrator, through the real
  // Router (what `wissel why <id>` shows).
  const decision = await new Router(registry).route(second);
  expect(decision.selected).toBe("integrator");
  expect(decision.confident).toBe(true);
  // The trace: one event per attempt, each carrying the HEAD it conflicted
  // against; the second also committed the first resolution.
  const events = mergeEvents(c.events);
  expect(events.map((e) => e.outcome)).toEqual(["conflict", "conflict"]);
  expect(events[0]!.conflictHead).toBe(headA);
  expect(events[1]!.conflictHead).toBe(headB);
  expect(events[0]!.resolvedConflictBy).toBeUndefined();
  expect(events[1]!.resolvedConflictBy).toBe(first.id);

  // The second integrator resolves; Wissel commits and lands it.
  await integratorResolves(worktree, second, resolvedWith(2));
  const landed = await mergeTask(board, task.id, c, registry);
  expect(landed.ok).toBe(true);
  if (landed.ok) expect(landed.value.message).toContain(`finished the conflict merge resolved by card ${second.id}`);
  expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(resolvedWith(2));
  expect((await board.get(task.id))!.status).toBe("done");
  expect(await integratorsOf(task.id)).toHaveLength(2);
});

test("repeated Merge clicks on the same HEAD spawn nothing, whatever the integrator's status: one conflict, one card", async () => {
  const registry = await Registry.load();
  const c = ctx(PASS);
  const { task, worktree, integrator } = await conflictedCard(c, Promise.resolve(registry));
  const headA = git(["rev-parse", "HEAD"], repo);

  for (const status of ["inbox", "running", "review"] as const) {
    if (status !== "inbox") await board.move(integrator.id, status);
    const out = await mergeTask(board, task.id, c, registry);
    expect(out.ok).toBe(false);
    expect(await integratorsOf(task.id)).toHaveLength(1);
  }
  // Finished with the markers still in: still the same conflict, still no second card.
  await board.move(integrator.id, "done");
  const out = await mergeTask(board, task.id, c, registry);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("conflict markers are still in shared.txt");
  expect(await integratorsOf(task.id)).toHaveLength(1);
  expect((await board.get(task.id))!.status).not.toBe("escalated");
  // Every attempt was against the one HEAD.
  const events = mergeEvents(c.events);
  expect(events).toHaveLength(5);
  expect(events.every((e) => e.outcome === "conflict" && e.conflictHead === headA)).toBe(true);
  // A fresh conflict's MergeResult carries the HEAD too.
  expect((await mergeTaskWorktree(repo, worktree, task, c)).conflictHead).toBe(headA);
});

test("an integrator that finished an earlier conflict does not vouch for a later one: the refusal says no card is for this HEAD", async () => {
  const c = ctx(PASS);
  const { task, worktree, integrator: first } = await conflictedCard(c);
  await integratorResolves(worktree, first, resolvedWith(1));
  const headB = mainMovesAgain(2);
  // No integrator agent registered for this attempt: the second conflict
  // gets no card, as happened live before 2026-10-19.
  expect((await mergeTask(board, task.id, c, Registry.from([]))).ok).toBe(false);
  expect(await integratorsOf(task.id)).toHaveLength(1);
  // A resolution appears in the worktree, with only the old card finished.
  writeFileSync(join(worktree.path, "shared.txt"), resolvedWith(2));

  const out = await mergeTask(board, task.id, c, Registry.from([]));

  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.error).toContain(`no conflict integrator card is for this conflict (HEAD ${headB.slice(0, 12)}); the earlier one (${first.id}) handled another HEAD`);
    expect(out.error).toContain("git add -A && git commit --no-edit");
  }
  expect(gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], worktree.path)).toBe(true);
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headB);
});

test(`cap: ${MAX_CONFLICT_INTEGRATORS} conflicts get ${MAX_CONFLICT_INTEGRATORS} integrators; the next escalates the card to a human and spawns none; a manual resolve still lands`, async () => {
  const registry = await Registry.load();
  const c = ctx(PASS);
  const { task, worktree, integrator: first } = await conflictedCard(c, Promise.resolve(registry));
  const heads = [git(["rev-parse", "HEAD"], repo)];
  let latest = first;
  for (let i = 2; i <= MAX_CONFLICT_INTEGRATORS; i++) {
    await integratorResolves(worktree, latest, resolvedWith(i - 1));
    heads.push(mainMovesAgain(i));
    expect((await mergeTask(board, task.id, c, registry)).ok).toBe(false);
    const cards = await integratorsOf(task.id);
    expect(cards).toHaveLength(i);
    latest = cards[cards.length - 1]!;
    expect(conflictIntegratorHead(latest)).toBe(heads[i - 1]!);
    expect(latest.body).toContain(`conflict ${i} of at most ${MAX_CONFLICT_INTEGRATORS}`);
  }
  const cards = await integratorsOf(task.id);
  expect(new Set(cards.map(conflictIntegratorHead))).toEqual(new Set(heads));

  // One more: the fourth conflict.
  await integratorResolves(worktree, latest, resolvedWith(MAX_CONFLICT_INTEGRATORS));
  const headD = mainMovesAgain(MAX_CONFLICT_INTEGRATORS + 1);
  const out = await mergeTask(board, task.id, c, registry);

  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.status).toBe(409);
    expect(out.error).toContain(`conflict merging ${repo}'s HEAD (${headD.slice(0, 12)})`);
    expect(out.error).toContain(`Escalated: ${MAX_CONFLICT_INTEGRATORS} integrator cards have already been spawned for this card's conflicts`);
  }
  expect(await integratorsOf(task.id)).toHaveLength(MAX_CONFLICT_INTEGRATORS);
  const escalated = (await board.get(task.id))!;
  expect(escalated.status).toBe("escalated");
  expect(escalated.escalationContext).toContain(`${MAX_CONFLICT_INTEGRATORS} conflict integrator cards (${cards.map((t) => t.id).join(", ")}) have already been spawned`);
  expect(escalated.escalationContext).toContain(`A human must resolve this conflict in the worktree ${worktree.path}`);
  expect(escalated.escalationContext).toContain("CONFLICT (content): Merge conflict in shared.txt");
  expect(escalated.supersededBy).toBeUndefined();
  expect(git(["rev-parse", "MERGE_HEAD"], worktree.path)).toBe(headD);
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headD);
  // The earlier cards are as they were: three, all done, none reopened.
  expect((await integratorsOf(task.id)).every((t) => t.status === "done")).toBe(true);
  // Clicking Merge again on the same HEAD: no card, no change.
  expect((await mergeTask(board, task.id, c, registry)).ok).toBe(false);
  expect(await integratorsOf(task.id)).toHaveLength(MAX_CONFLICT_INTEGRATORS);
  expect((await board.get(task.id))!.status).toBe("escalated");
  const last = mergeEvents(c.events).at(-1)!;
  expect(last).toMatchObject({ outcome: "conflict", conflictHead: headD });

  // The human does what the context says.
  writeFileSync(join(worktree.path, "shared.txt"), resolvedWith(MAX_CONFLICT_INTEGRATORS + 1));
  git(["add", "-A"], worktree.path);
  git(["commit", "-q", "--no-edit"], worktree.path);
  const landed = await mergeTask(board, task.id, c, registry);
  expect(landed.ok).toBe(true);
  expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe(resolvedWith(MAX_CONFLICT_INTEGRATORS + 1));
  expect((await board.get(task.id))!.status).toBe("done");
});

// ---------- 4/5. the user's own uncommitted edits ----------

test("dirty user checkout overlapping the branch's files: blocked-local-changes, no integrator, edits intact byte for byte", async () => {
  const registry = await Registry.load();
  const { task } = await cardWithWork({ "shared.txt": "line 1\nbranch edit\nline 3\n", "brand-new.txt": "from branch\n" });
  // A tracked edit and an untracked file, both ones the landing would write.
  const myEdit = Buffer.from("line 1\nMY UNSAVED WORK\nline 3\né\u0000binary-ish\n");
  writeFileSync(join(repo, "shared.txt"), myEdit);
  const myUntracked = Buffer.from("my own new file\n");
  writeFileSync(join(repo, "brand-new.txt"), myUntracked);
  const headBefore = git(["rev-parse", "HEAD"], repo);
  const c = ctx(PASS);

  const out = await mergeTask(board, task.id, c, registry);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toBe(
    `blocked by uncommitted local changes in: brand-new.txt, shared.txt. Commit or move those edits in ${repo}, then merge again. Nothing landed and your edits are untouched.`,
  );
  expect(readFileSync(join(repo, "shared.txt")).equals(myEdit)).toBe(true);
  expect(readFileSync(join(repo, "brand-new.txt")).equals(myUntracked)).toBe(true);
  expect(git(["rev-parse", "HEAD"], repo)).toBe(headBefore);
  expect((await board.list()).filter((t) => t.labels.includes("conflict"))).toHaveLength(0);
  expect((await board.get(task.id))!.status).not.toBe("done");
  expect(mergeEvents(c.events)[0]).toMatchObject({ outcome: "blocked-local-changes", blockedFiles: ["brand-new.txt", "shared.txt"] });
});

test("dirty user checkout on unrelated files: lands, and the local edits are still there", async () => {
  const { task } = await cardWithWork({ "feature.txt": "feature\n" });
  const myEdit = "other\nmy local tweak\n";
  writeFileSync(join(repo, "other.txt"), myEdit);
  writeFileSync(join(repo, "scratch.txt"), "notes\n");

  const out = await mergeTask(board, task.id, ctx(PASS));

  expect(out.ok).toBe(true);
  expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("feature\n");
  expect(readFileSync(join(repo, "other.txt"), "utf8")).toBe(myEdit);
  expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("notes\n");
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8");
  expect(status.split("\n").filter(Boolean).sort()).toEqual([" M other.txt", "?? scratch.txt"]);
});

// ---------- 6. HEAD moves between gate and land ----------

test("HEAD moves once between gate and land: re-merges against the new HEAD, re-gates, lands", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  let gates = 0;
  let moved = false;
  const c = ctx(undefined, {
    gateFor: async () => ({ commands: [["sh", "-c", "exit 0"]] }),
    gateRunner: async () => (gates++, { exitCode: 0, output: "", timedOut: false }),
    beforeLand: async () => {
      if (moved) return;
      moved = true;
      commitOnMain("human.txt", "human\n");
    },
  });

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  expect(gates).toBe(2);
  expect(readFileSync(join(repo, "human.txt"), "utf8")).toBe("human\n");
  expect(readFileSync(join(repo, "feature.txt"), "utf8")).toBe("f\n");
  expect(git(["log", "--merges", "--format=%s"], repo).split("\n").filter((s) => s.startsWith("Merge wissel/"))).toHaveLength(1);
});

test("HEAD moves twice: fails as head-moved, nothing lands, the card isn't done", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  let n = 0;
  const c = ctx(PASS, { beforeLand: async () => void commitOnMain(`human-${++n}.txt`, "h\n") });

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.error).toContain("HEAD moved twice");
  expect(existsSync(join(repo, "feature.txt"))).toBe(false);
  expect((await board.get(task.id))!.status).not.toBe("done");
  expect(mergeEvents(c.events)[0]!.outcome).toBe("head-moved");
  expect((await board.list()).filter((t) => t.labels.includes("conflict"))).toHaveLength(0);
});

// ---------- 7. the per-repo lock ----------

test("two concurrent merges into the same repo are serialized: both land, no index.lock error", async () => {
  const a = await cardWithWork({ "a.txt": "a\n" }, { title: "Card A" });
  const b = await cardWithWork({ "b.txt": "b\n" }, { title: "Card B" });
  const spans: { start: number; end: number }[] = [];
  const slowGate: MergeContext["gateRunner"] = async () => {
    const start = performance.now();
    await Bun.sleep(150);
    spans.push({ start, end: performance.now() });
    return { exitCode: 0, output: "", timedOut: false };
  };
  const c = ctx(PASS, { gateRunner: slowGate });

  const [ra, rb] = await Promise.all([mergeTask(board, a.task.id, c), mergeTask(board, b.task.id, c)]);

  expect(ra.ok).toBe(true);
  expect(rb.ok).toBe(true);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("a\n");
  expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b\n");
  // Gates never overlapped: the second waited for the first to finish.
  spans.sort((x, y) => x.start - y.start);
  expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.end);
  const events = mergeEvents(c.events);
  expect(events.map((e) => e.outcome)).toEqual(["landed", "landed"]);
  expect(Math.max(...events.map((e) => e.lockWaitMs))).toBeGreaterThan(100);
  const subjects = git(["log", "--merges", "--format=%s"], repo).split("\n");
  expect(subjects.filter((s) => s.startsWith("Merge wissel/"))).toHaveLength(2);
});

test("two Merge clicks on the same card: the first lands, the second waits its turn and answers instead of throwing", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  const c = ctx(PASS);

  const [one, two] = await Promise.all([mergeTask(board, task.id, c), mergeTask(board, task.id, c)]);

  expect(one.ok).toBe(true);
  expect(two.ok).toBe(false);
  if (!two.ok) expect(two.error).toContain("already merged or discarded");
  expect(git(["log", "--merges", "--format=%s"], repo).split("\n").filter((s) => s.startsWith("Merge wissel/"))).toHaveLength(1);
  expect((await board.get(task.id))!.status).toBe("done");
});

// ---------- 8/9. crash recovery and the stored sha ----------

test("crash after landing, before board.move: startup reconciliation moves the card to done from mergedSha", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "f\n" });
  await board.move(task.id, "pending-review");
  // The merge lands and records its sha; the process "dies" before the
  // caller's board.move (mergeTaskWorktree itself never moves cards).
  const res = await mergeTaskWorktree(repo, worktree, task, ctx(PASS), (sha) => board.recordMerge(task.id, sha));
  expect(res.outcome).toBe("landed");
  expect((await board.get(task.id))!.status).toBe("pending-review");

  const moved = await reconcileLandedMerges(board, runViaBun);

  expect(moved).toBe(1);
  expect((await board.get(task.id))!.status).toBe("done");
  expect(await reconcileLandedMerges(board, runViaBun)).toBe(0);
});

test("reconciliation leaves a card whose recorded sha isn't in HEAD exactly as found", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  await board.move(task.id, "review");
  // A sha that exists but isn't HEAD's ancestor: a commit on a side branch.
  git(["checkout", "-q", "-b", "side"], repo);
  const side = commitOnMain("side.txt", "s\n");
  git(["checkout", "-q", "main"], repo);
  await board.recordMerge(task.id, side);

  expect(await reconcileLandedMerges(board, runViaBun)).toBe(0);
  expect((await board.get(task.id))!.status).toBe("review");
});

test("determineWorktreeMergeState: a stored mergedSha in HEAD proves merged even with the worktree and branch gone", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "f\n" });
  const res = await mergeTaskWorktree(repo, worktree, { ...task, title: "renamed later" }, ctx(PASS));
  // Title changed after landing: the legacy grep can't find it, the sha can.
  expect(await determineWorktreeMergeState(repo, worktree, task, runViaBun)).toBe("unknown");
  expect(await determineWorktreeMergeState(repo, worktree, task, runViaBun, res.mergedSha)).toBe("merged");
});

test("legacy row without mergedSha still resolves through the commit-log search", async () => {
  // History as the old merge path wrote it: `git merge --no-ff` in the
  // user's checkout, then cleanup, and no sha recorded anywhere.
  const { task, worktree } = await cardWithWork({ "feature.txt": "f\n" });
  git(["add", "-A"], worktree.path);
  git(["commit", "-q", "-m", "work"], worktree.path);
  git(["merge", "-q", "--no-ff", worktree.branch, "-m", `Merge ${worktree.branch}: ${task.title}`], repo);
  git(["worktree", "remove", "--force", worktree.path], repo);
  git(["branch", "-D", worktree.branch], repo);

  expect((await board.getResult(task.id))!.mergedSha).toBeUndefined();
  expect(await determineWorktreeMergeState(repo, worktree, task, runViaBun)).toBe("merged");
});

// ---------- 10. no gate configured ----------

test("repo with no mergeGate: lands, and telemetry says gate none", async () => {
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  const c = ctx(undefined);

  const out = await mergeTask(board, task.id, c);

  expect(out.ok).toBe(true);
  if (out.ok) expect(out.value.message).toContain("no merge gate configured");
  expect(mergeEvents(c.events)[0]).toMatchObject({ outcome: "landed", gate: "none", gateRuns: [], gateMs: 0 });
});

test("a bare CommandRunner (no context) still merges: no gate, no telemetry", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "f\n" });
  const res = await mergeTaskWorktree(repo, worktree, task, runViaBun);
  expect(res).toMatchObject({ ok: true, outcome: "landed", gate: { status: "none" } });
  expect(git(["rev-parse", "HEAD"], repo)).toBe(res.mergedSha!);
});

test("a branch with nothing new lands as a no-op without running the gate", async () => {
  const { task, worktree } = await cardWithWork({});
  let ran = false;
  const res = await mergeTaskWorktree(repo, worktree, task, ctx(PASS, { gateRunner: async () => ((ran = true), { exitCode: 0, output: "", timedOut: false }) }));
  expect(res).toMatchObject({ ok: true, outcome: "landed", gate: { status: "skipped" } });
  expect(ran).toBe(false);
  expect(git(["log", "--merges", "--format=%s"], repo)).toBe("");
});

test("a gate lookup that throws refuses the merge instead of landing ungated", async () => {
  const { task, worktree } = await cardWithWork({ "feature.txt": "f\n" });
  const res = await mergeTaskWorktree(repo, worktree, task, { runner: runViaBun, gateFor: async () => { throw new Error("db closed"); } });
  expect(res.outcome).toBe("error");
  expect(res.message).toContain("db closed");
  expect(existsSync(join(repo, "feature.txt"))).toBe(false);
});

test("the gate can run the repo's own tooling: nested package node_modules are linked into the worktree", async () => {
  mkdirSync(join(repo, "app"), { recursive: true });
  writeFileSync(join(repo, "app", "package.json"), "{}\n");
  git(["add", "app/package.json"], repo);
  git(["commit", "-q", "-m", "app"], repo);
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(repo, "app", "node_modules", "react"), { recursive: true });
  const { task } = await cardWithWork({ "feature.txt": "f\n" });
  const gate = [["sh", "-c", "test -d node_modules/dep && test -d app/node_modules/react"]];

  const out = await mergeTask(board, task.id, ctx(gate));

  expect(out.ok).toBe(true);
});
