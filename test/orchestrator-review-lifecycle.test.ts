import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { AgentDef, ReviewVerdict } from "../src/core/types.ts";

/**
 * Subtask C's whole point — automatic implementer -> reviewer handoff,
 * approve/push-back/escalation — hinges on one specific real-world
 * mechanism: a pushback re-attempt reuses the exact same git worktree
 * the reviewer just looked at (see createTaskWorktree's `worktreeKey`
 * doc comment). A mocked git runner would happily "reuse" a worktree
 * that was never really created, hiding exactly the bug this feature is
 * for. Every test below runs real `git` (via runViaBun) for every git
 * command; only the `claude` subprocess itself is faked, since spawning
 * a real one would be non-deterministic and paid.
 */
function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function realRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-review-lifecycle-repo-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-test@example.com"], dir);
  git(["config", "user.name", "wissel test"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "seed"], dir);
  return dir;
}

/**
 * Fakes only the `claude` subprocess. Every `git` command (worktree
 * add/list, merge, branch -D, ...) is forwarded to the real `runViaBun`
 * so worktree creation/reuse/merge all happen against real on-disk git
 * state. Distinguishes a reviewer call from an implementer call by
 * `--permission-mode` (readonly always passes "plan", write always
 * passes "acceptEdits" — see ReadOnlyExecutor/WriteExecutor), and hands
 * back the next scripted verdict for a reviewer call. Throws if the
 * reviewer is invoked more times than a test scripted for — a silent
 * extra "approve" default would mask a test driving the lineage further
 * than intended.
 */
function realGitFakeClaude(verdicts: ReviewVerdict[]): CommandRunner & { worktreeAddCount(): number } {
  let reviewerCalls = 0;
  let worktreeAdds = 0;
  const runner: CommandRunner = async (cmd, opts) => {
    if (cmd[0] === "git") {
      if (cmd[1] === "worktree" && cmd[2] === "add") worktreeAdds++;
      return runViaBun(cmd, opts);
    }
    const mode = cmd[cmd.indexOf("--permission-mode") + 1];
    if (mode === "plan") {
      const v = verdicts[reviewerCalls++];
      if (!v) throw new Error(`reviewer invoked a ${reviewerCalls}th time — test only scripted ${verdicts.length} verdict(s)`);
      const result = `Reviewed the diff.\n\n\`\`\`review-verdict\n${JSON.stringify(v)}\n\`\`\``;
      return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result }), stderr: "", exitCode: 0 };
    }
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "implemented" }), stderr: "", exitCode: 0 };
  };
  return Object.assign(runner, { worktreeAddCount: () => worktreeAdds });
}

interface Fixture {
  repo: string;
  home: string;
  runner: CommandRunner & { worktreeAddCount(): number };
  board: SqliteBoard;
  orchestrator: Orchestrator;
}

async function setup(verdicts: ReviewVerdict[], agents?: AgentDef[]): Promise<Fixture> {
  const repo = await realRepo();
  const home = await mkdtemp(join(tmpdir(), "wissel-review-lifecycle-home-"));
  const runner = realGitFakeClaude(verdicts);
  const board = new SqliteBoard();
  const registry = agents ? Registry.from(agents) : await Registry.load();
  const executors = [new WriteExecutor({ runner, homeDir: home }), new ReadOnlyExecutor({ runner })];
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, { executeWriteTier: true });
  return { repo, home, runner, board, orchestrator };
}

async function cleanup(fixture: Pick<Fixture, "repo" | "home">): Promise<void> {
  await rm(fixture.repo, { recursive: true, force: true });
  await rm(fixture.home, { recursive: true, force: true });
}

/** One full round = the pending implementer attempt runs (spawning its
 *  reviewer, unrouted), then that reviewer runs (reporting its verdict).
 *  Each round consumes exactly one scripted verdict — callers size
 *  `verdicts` to exactly the number of rounds they drive. */
async function driveRounds(orchestrator: Orchestrator, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await orchestrator.sweep();
    await orchestrator.sweep();
  }
}

test("implementer success -> pending-review, with a reviewer task auto-created within one sweep, correct parentTaskId/reviewLineageId/worktree", async () => {
  const fixture = await setup([]);
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await fixture.orchestrator.sweep();

    expect((await fixture.board.get(task.id))!.status).toBe("pending-review");

    const implResult = await fixture.board.getResult(task.id);
    expect(implResult!.worktree).toBeDefined();

    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask).toBeDefined();
    expect(reviewerTask!.reviewLineageId).toBe(task.id);
    expect(reviewerTask!.labels).toEqual(["review"]);
    expect(reviewerTask!.pushbackCount).toBe(0);
    // The reviewer's own cwd is the implementer's real worktree — proof
    // it actually reviews the diff under review, not task.repo's own
    // unrelated working tree.
    expect(reviewerTask!.repo).toBe(implResult!.worktree!.path);
    expect(existsSync(implResult!.worktree!.path)).toBe(true);
  } finally {
    await cleanup(fixture);
  }
});

test("regression: a write-tier agent with no reviewer handoff keeps the original review gate unchanged", async () => {
  // "fixer" (real manifest) never declares handoffs — unlike "implementer",
  // which now does. Its success must land straight on plain `review`,
  // with no reviewer task spawned, exactly as before this feature existed.
  const fixture = await setup([]);
  try {
    const task = await fixture.board.create({ title: "make CI green", body: "", labels: ["ci"], repo: fixture.repo });

    await fixture.orchestrator.sweep();

    const updated = await fixture.board.get(task.id);
    expect(updated!.routedTo).toBe("fixer");
    expect(updated!.status).toBe("review");
    expect((await fixture.board.list()).some((t) => t.parentTaskId === task.id)).toBe(false);
  } finally {
    await cleanup(fixture);
  }
});

test("approve verdict, real implementer (autoMerge:true) resumes straight to done with a real git merge, and marks the reviewer task done", async () => {
  // Uses the real, manifest-loaded implementer (Registry.load(), setup's
  // default) rather than a synthetic stand-in — confirms the actual
  // agents/manifest.yaml `autoMerge: true` entry behaves as configured,
  // not just a hypothetical AgentDef shape. See the synthetic-agent test
  // directly below for the no-autoMerge fallback path this used to cover.
  const fixture = await setup([{ verdict: "approve", feedback: "looks good" }]);
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 1);

    expect((await fixture.board.get(task.id))!.status).toBe("done");
    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask!.status).toBe("done");

    // The merge actually happened for real, same evidence the synthetic
    // autoMerge test below checks: worktree gone, branch gone.
    const worktreePath = (await fixture.board.getResult(task.id))!.worktree!.path;
    expect(existsSync(worktreePath)).toBe(false);
    const branches = Bun.spawnSync(["git", "branch", "--list"], { cwd: fixture.repo, stdout: "pipe" }).stdout.toString("utf8");
    expect(branches).not.toContain(`wissel/${task.id}`);
  } finally {
    await cleanup(fixture);
  }
});

test("approve verdict, trustLevel:high but no autoMerge, still resumes the implementer to review (human gate unchanged for an agent that didn't opt in)", async () => {
  const realReviewer = (await Registry.load()).get("reviewer")!;
  const noAutoMergeImplementer: AgentDef = {
    id: "no-automerge-implementer",
    name: "No-automerge implementer",
    kind: "agent",
    tier: "write",
    description: "d",
    whenToUse: "w",
    tags: ["code"],
    executor: "handoff",
    handoffs: ["reviewer"],
    inputs: [],
    outputs: [],
    trustLevel: "high",
    toolAccess: [],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.5 },
    // autoMerge deliberately omitted.
  };
  const fixture = await setup([{ verdict: "approve", feedback: "looks good" }], [noAutoMergeImplementer, realReviewer]);
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 1);

    expect((await fixture.board.get(task.id))!.status).toBe("review");
    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask!.status).toBe("done");
  } finally {
    await cleanup(fixture);
  }
});

test("approve verdict + autoMerge/trustLevel:high resumes the implementer straight to done, with a real git merge", async () => {
  const realReviewer = (await Registry.load()).get("reviewer")!;
  const autoImplementer: AgentDef = {
    id: "auto-implementer",
    name: "Auto implementer",
    kind: "agent",
    tier: "write",
    description: "d",
    whenToUse: "w",
    tags: ["code"],
    executor: "handoff",
    handoffs: ["reviewer"],
    inputs: [],
    outputs: [],
    trustLevel: "high",
    toolAccess: [],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.5 },
    autoMerge: true,
  };
  const fixture = await setup([{ verdict: "approve", feedback: "ship it" }], [autoImplementer, realReviewer]);
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 1);

    const updated = await fixture.board.get(task.id);
    expect(updated!.routedTo).toBe("auto-implementer");
    expect(updated!.status).toBe("done");

    // The merge actually happened for real: the worktree's branch is
    // gone (removeTaskWorktree ran) and its directory was removed, not
    // just a status flip pretending it was.
    const worktreePath = (await fixture.board.getResult(task.id))!.worktree!.path;
    expect(existsSync(worktreePath)).toBe(false);
    const branches = Bun.spawnSync(["git", "branch", "--list"], { cwd: fixture.repo, stdout: "pipe" }).stdout.toString("utf8");
    expect(branches).not.toContain(`wissel/${task.id}`);
  } finally {
    await cleanup(fixture);
  }
});

test("changes_requested spawns a pushback implementer with feedback in its body, and reuses the exact same real worktree/branch", async () => {
  const fixture = await setup([{ verdict: "changes_requested", feedback: "missing error handling on the empty-input path" }]);
  try {
    const original = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 1);

    const supersededOriginal = await fixture.board.get(original.id);
    expect(supersededOriginal!.supersededBy).toBeDefined();
    const reattempt = await fixture.board.get(supersededOriginal!.supersededBy!);
    expect(reattempt).toBeDefined();
    expect(reattempt!.pushbackCount).toBe(1);
    expect(reattempt!.reviewLineageId).toBe(original.id);
    expect(reattempt!.body).toContain("missing error handling on the empty-input path");
    expect(reattempt!.body).toContain(original.body);

    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === original.id);
    expect(reviewerTask!.status).toBe("done");

    // Run the re-attempt for real and confirm the worktree is reused,
    // not re-cloned — the one behavior a mocked runner could hide.
    await fixture.orchestrator.sweep();
    const reattemptResult = await fixture.board.getResult(reattempt!.id);
    const originalResult = await fixture.board.getResult(original.id);
    expect(reattemptResult!.worktree).toEqual(originalResult!.worktree);
    expect(fixture.runner.worktreeAddCount()).toBe(1);
  } finally {
    await cleanup(fixture);
  }
});

test("5 consecutive rejections create exactly 5 pushback implementer tasks (pushbackCount 1..5), reusing the same real worktree every time", async () => {
  const verdicts: ReviewVerdict[] = Array.from({ length: 5 }, (_, i) => ({
    verdict: "changes_requested",
    feedback: `round ${i + 1}: still not right`,
  }));
  const fixture = await setup(verdicts);
  try {
    const original = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 5);

    const lineage = await fixture.board.getLineage(original.id);
    const implementerAttempts = lineage.filter((t) => !t.labels.includes("review"));
    expect(implementerAttempts.map((t) => t.pushbackCount)).toEqual([1, 2, 3, 4, 5]);

    const reviewerTasks = lineage.filter((t) => t.labels.includes("review"));
    expect(reviewerTasks).toHaveLength(5);
    expect(reviewerTasks.every((t) => t.status === "done")).toBe(true);

    // Only the very first attempt ever created a real worktree — every
    // pushback re-attempt after it reused that same one.
    expect(fixture.runner.worktreeAddCount()).toBe(1);

    // The 5th pushback attempt (pushbackCount 5) was just spawned by
    // round 5's rejection — driveRounds only runs what each round
    // produces, so this one hasn't run yet.
    const latest = implementerAttempts[implementerAttempts.length - 1]!;
    expect(latest.status).toBe("inbox");
    expect(latest.routedTo).toBeUndefined();
    // The very first attempt's own status is set once (pending-review,
    // from its own successful run) and never touched again by later
    // pushback rounds — only its supersededBy chain changes.
    expect((await fixture.board.get(original.id))!.status).toBe("pending-review");
  } finally {
    await cleanup(fixture);
  }
});

test("6 consecutive rejections escalate instead of spawning a 7th implementer task, with the full ordered feedback history", async () => {
  const verdicts: ReviewVerdict[] = Array.from({ length: 6 }, (_, i) => ({
    verdict: "changes_requested",
    feedback: `round ${i + 1}: still not right`,
  }));
  const fixture = await setup(verdicts);
  try {
    const original = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 6);

    const lineage = await fixture.board.getLineage(original.id);
    const implementerAttempts = lineage.filter((t) => !t.labels.includes("review"));
    // Exactly 5 pushback attempts (2..6) — the 6th rejection escalates
    // the last of those instead of spawning a 7th.
    expect(implementerAttempts).toHaveLength(5);
    expect(implementerAttempts.map((t) => t.pushbackCount)).toEqual([1, 2, 3, 4, 5]);

    const escalated = implementerAttempts[implementerAttempts.length - 1]!;
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalationContext).toBeDefined();

    const entries = escalated.escalationContext!.split("\n\n");
    expect(entries).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      expect(entries[i]).toBe(`Attempt ${i + 1}: round ${i + 1}: still not right`);
    }

    // No 7th implementer task exists anywhere on the board.
    expect((await fixture.board.list()).filter((t) => !t.labels.includes("review") && t.title === original.title)).toHaveLength(6);

    // Escalated tasks are queryable via the board's status filter — the
    // same filter GET /tasks?status=escalated applies (see src/api/server.ts).
    const escalatedList = await fixture.board.list({ status: "escalated" });
    expect(escalatedList.map((t) => t.id)).toEqual([escalated.id]);

    expect(fixture.runner.worktreeAddCount()).toBe(1);
  } finally {
    await cleanup(fixture);
  }
});

test("a dependent task's dependsOn follows a pushback's supersededBy chain to the live re-attempt, not the permanently-stuck original", async () => {
  const fixture = await setup([{ verdict: "changes_requested", feedback: "missing error handling" }]);
  try {
    const original = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });
    const dependent = await fixture.board.create({
      title: "Build on top of it",
      body: "",
      labels: ["code"],
      repo: fixture.repo,
      dependsOn: [original.id],
    });

    await driveRounds(fixture.orchestrator, 1);

    const supersededOriginal = await fixture.board.get(original.id);
    // Frozen forever by design (TaskCard.supersededBy) — the dependent
    // must never be evaluated against this status again.
    expect(supersededOriginal!.status).toBe("pending-review");
    const reattemptId = supersededOriginal!.supersededBy!;

    // The dependent stays blocked — the re-attempt exists but isn't done
    // yet. Before the fix, this dep would have blocked forever even once
    // the re-attempt finished, since the old check only ever looked at
    // original's own (now permanently pending-review) status.
    await fixture.orchestrator.sweep();
    expect((await fixture.board.get(dependent.id))!.status).toBe("inbox");
    expect((await fixture.board.get(dependent.id))!.routedTo).toBeUndefined();

    // The re-attempt reaches "done" for real — same path a human's
    // POST /tasks/:id/merge takes (Board.move, per its own doc comment:
    // every "became done" transition goes through it).
    await fixture.board.move(reattemptId, "done");

    await fixture.orchestrator.sweep();
    const dependentAfter = await fixture.board.get(dependent.id);
    expect(dependentAfter!.status).not.toBe("inbox");
    expect(dependentAfter!.routedTo).toBeDefined();
  } finally {
    await cleanup(fixture);
  }
});

test("runNow rejects a click on a superseded task instead of resurrecting its abandoned worktree", async () => {
  const fixture = await setup([{ verdict: "changes_requested", feedback: "not quite" }]);
  try {
    const original = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await driveRounds(fixture.orchestrator, 1);
    const reattemptId = (await fixture.board.get(original.id))!.supersededBy!;

    await expect(fixture.orchestrator.runNow(original.id, [])).rejects.toThrow(
      `task ${original.id} was superseded by ${reattemptId} — run that task instead`,
    );
  } finally {
    await cleanup(fixture);
  }
});
