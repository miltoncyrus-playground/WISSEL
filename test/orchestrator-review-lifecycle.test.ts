import { existsSync, writeFileSync } from "node:fs";
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
import type { AgentDef, ReviewVerdict, TaskCard } from "../src/core/types.ts";
import { McpServerPool } from "../src/core/mcp-server-pool.ts";
import { formatMcpTranscript } from "../src/services/mcp-transcript.ts";

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

/**
 * Same as `realGitFakeClaude`, except the write-tier ("acceptEdits")
 * branch also writes `relPath`/`content` into the worktree it's handed
 * (`opts.cwd` — WriteExecutor.run overrides `task.repo` to
 * `worktree.path` before calling runClaude, see write.ts) instead of
 * leaving the worktree untouched. Needed because `Orchestrator.process`
 * always calls `finishResult` with `runner` left as its default
 * (`runViaBun`, see orchestrator.ts's own `finishResult` calls) —
 * `tryAutoMerge`'s own `git merge` always runs for real, never through
 * whatever CommandRunner the executors were given, so the only way to
 * script a *real* conflict is a real divergent commit on each side, not
 * a faked exit code on the merge call itself. Every `realGitFakeClaude`
 * test elsewhere never needed this because none of them exercise an
 * actual content conflict — their merges are genuine no-ops (no file
 * was ever written), which is also real git, just never conflicting
 * git.
 */
function realGitFakeClaudeWritingFile(
  verdicts: ReviewVerdict[],
  relPath: string,
  content: string,
): CommandRunner & { worktreeAddCount(): number; writeCmds(): string[][] } {
  let reviewerCalls = 0;
  let worktreeAdds = 0;
  const writeCmds: string[][] = [];
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
    writeCmds.push(cmd);
    writeFileSync(join(opts.cwd, relPath), content);
    return { stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "implemented" }), stderr: "", exitCode: 0 };
  };
  return Object.assign(runner, { worktreeAddCount: () => worktreeAdds, writeCmds: () => writeCmds });
}

interface Fixture {
  repo: string;
  home: string;
  runner: CommandRunner & { worktreeAddCount(): number; writeCmds?(): string[][] };
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

/** Same as `setup`, except the implementer's fake "claude" call writes
 *  real content into its worktree (see realGitFakeClaudeWritingFile) —
 *  needed to set up a real conflict later. Always uses the real,
 *  manifest-loaded registry (never a synthetic `agents` override) so
 *  the real `implementer` (autoMerge:true) and the real `integrator`
 *  are both present, the same way the "approve verdict, real
 *  implementer" test above does. */
async function setupWritingFile(verdicts: ReviewVerdict[], relPath: string, content: string): Promise<Fixture> {
  const repo = await realRepo();
  const home = await mkdtemp(join(tmpdir(), "wissel-review-lifecycle-home-"));
  const runner = realGitFakeClaudeWritingFile(verdicts, relPath, content);
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const executors = [new WriteExecutor({ runner, homeDir: home }), new ReadOnlyExecutor({ runner })];
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, { executeWriteTier: true });
  return { repo, home, runner, board, orchestrator };
}

async function cleanup(fixture: Pick<Fixture, "repo" | "home">): Promise<void> {
  await rm(fixture.repo, { recursive: true, force: true });
  await rm(fixture.home, { recursive: true, force: true });
}

/** `runNow` returns once the run is in flight, not once it's done (see
 *  its own doc comment, src/core/orchestrator.ts) — needed only for the
 *  idempotency test below, which re-runs an already-approved task via
 *  `runNow` rather than the sweep-driven `driveRounds`. Mirrors
 *  `waitForStatus` in test/orchestrator.test.ts. */
async function waitForStatus(board: SqliteBoard, taskId: string, status: TaskCard["status"]): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if ((await board.get(taskId))!.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} never reached status ${status}`);
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

test("regression: a reviewTarget:'diff'-or-undefined implementer's reviewer task body is byte-identical to the implementer's own body", async () => {
  // The exact regression the subtask 4 card calls out as the most
  // important to avoid: embedding a transcript must never alter the
  // plain-diff path's reviewer task body, not even whitespace.
  const fixture = await setup([]);
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.\nWith two lines.", labels: ["code"], repo: fixture.repo });

    await fixture.orchestrator.sweep();

    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask!.body).toBe(task.body);
  } finally {
    await cleanup(fixture);
  }
});

test("a reviewTarget:'tool-calls' implementer's reviewer task body embeds the formatted MCP transcript instead of relying on a diff", async () => {
  const realReviewer = (await Registry.load()).get("reviewer")!;
  const mcpImplementer: AgentDef = {
    id: "mcp-implementer",
    name: "MCP implementer",
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
    reviewTarget: "tool-calls",
    mcpAccess: [{ server: "test-server", tools: ["echo"] }],
  };
  const pool = McpServerPool.from([
    {
      id: "test-server",
      label: "Test server",
      transport: { kind: "stdio", command: "/bin/true", args: [] },
      // trust: "auto" — otherwise subtask 3's trust gate (splitGrantsByTrust,
      // mcp-config.ts) correctly treats an undeclared/non-"auto" tool as
      // approval-required and excludes it from --allowedTools entirely,
      // which isn't what this test is about: it's checking mcpCalls gets
      // embedded in the reviewer body, not trust-gating behavior.
      tools: [{ name: "echo", trust: "auto" }],
      enabled: true,
    },
  ]);

  const repo = await realRepo();
  const home = await mkdtemp(join(tmpdir(), "wissel-review-lifecycle-home-"));
  const runner: CommandRunner = async (cmd, opts) => {
    if (cmd[0] === "git") return runViaBun(cmd, opts);
    const mode = cmd[cmd.indexOf("--permission-mode") + 1];
    if (mode === "acceptEdits") {
      const stdout = [
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__test-server__echo", input: { text: "hi" } }] } }),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "hi", is_error: false }] } }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "called echo" }),
      ].join("\n");
      return { stdout, stderr: "", exitCode: 0 };
    }
    throw new Error("reviewer should not run in this test — only the implementer pass is driven");
  };

  const board = new SqliteBoard();
  const registry = Registry.from([mcpImplementer, realReviewer]);
  const executors = [new WriteExecutor({ runner, homeDir: home, mcpServers: pool }), new ReadOnlyExecutor({ runner })];
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, { executeWriteTier: true });

  try {
    const task = await board.create({ title: "Call the echo tool", body: "Use the echo tool and report back.", labels: ["code"], repo });

    await orchestrator.sweep();

    const implResult = await board.getResult(task.id);
    expect(implResult!.mcpCalls).toEqual([{ server: "test-server", tool: "echo", args: { text: "hi" }, result: "hi", ok: true }]);

    const reviewerTask = (await board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask).toBeDefined();
    expect(reviewerTask!.body).toBe(`${task.body}\n\n---\nTool calls made:\n${formatMcpTranscript(implResult!.mcpCalls!)}`);
    expect(reviewerTask!.body).not.toBe(task.body);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
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

test("a fresh merge conflict on approve auto-spawns exactly one integrator-routed follow-up, with the existing review fallback unchanged — real git, real divergent commits, real sweep, real implementer/integrator", async () => {
  const relPath = "feature.txt";
  const fixture = await setupWritingFile([{ verdict: "approve", feedback: "looks good" }], relPath, "line from implementer\n");
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    // Round 1, sweep 1: the implementer runs, writes feature.txt into
    // its own worktree (uncommitted so far — mergeTaskWorktree commits
    // it later, at merge time), spawns its reviewer task.
    await fixture.orchestrator.sweep();

    // Diverges fixture.repo's own checked-out branch on the exact same
    // file *after* the worktree already branched off it — the one
    // thing that turns the later merge into a real conflict instead of
    // a clean fast-forward: both sides independently created the same
    // file with different content, from the same common ancestor.
    writeFileSync(join(fixture.repo, relPath), "line from repo HEAD\n");
    git(["add", "-A"], fixture.repo);
    git(["commit", "-q", "-m", "diverge on repo HEAD"], fixture.repo);

    // Round 1, sweep 2: the reviewer approves -> resumeAfterApproval ->
    // tryAutoMerge -> mergeTaskWorktree commits the worktree's own
    // feature.txt for real, then a real `git merge --no-ff` into
    // fixture.repo genuinely conflicts.
    await fixture.orchestrator.sweep();

    // The existing fallback is completely unchanged: a conflicted
    // auto-merge still lands the original task on "review" for a
    // human, exactly as it did before this feature existed (see the
    // synthetic-agent conflict test in test/orchestrator.test.ts).
    expect((await fixture.board.get(task.id))!.status).toBe("review");
    const reviewerTask = (await fixture.board.list()).find((t) => t.parentTaskId === task.id);
    expect(reviewerTask!.status).toBe("done");

    // The worktree is untouched (removeTaskWorktree only ever runs on a
    // successful merge) — the conflict sits in fixture.repo's own
    // working tree, left exactly as git produced it.
    const worktreePath = (await fixture.board.getResult(task.id))!.worktree!.path;
    expect(existsSync(worktreePath)).toBe(true);
    const repoStatus = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: fixture.repo, stdout: "pipe" }).stdout.toString("utf8");
    expect(repoStatus).toContain("feature.txt");

    // Exactly one integrator-routed follow-up, carrying the repo, the
    // worktree branch, and the real conflict output.
    const followUps = (await fixture.board.list()).filter((t) => t.labels.includes("conflict"));
    expect(followUps).toHaveLength(1);
    const followUp = followUps[0]!;
    expect(followUp.title).toBe(`Resolve merge conflict: ${task.id}`);
    expect(followUp.repo).toBe(fixture.repo);
    expect(followUp.body).toContain(`wissel/${task.id}`);
    expect(followUp.body).toContain("CONFLICT");
    expect(followUp.body).toContain("feature.txt");
    // Grants the follow-up's own write-tier run (a fresh worktree of
    // its own, a different absolute path from fixture.repo) access to
    // fixture.repo directly — without this, claude's own sandbox denies
    // the out-of-worktree access the body above instructs it to use.
    expect(followUp.extraAllowedDirs).toEqual([fixture.repo]);
    // extraAllowedDirs alone only grants file-system access (--add-dir);
    // it does not make acceptEdits' own Bash gating allow the git
    // commands the body above instructs — extraAllowedTools is the
    // separate grant for that (see TaskCard.extraAllowedTools).
    expect(followUp.extraAllowedTools).toEqual([
      `Bash(git -C ${fixture.repo} status:*)`,
      `Bash(git -C ${fixture.repo} diff:*)`,
      `Bash(git -C ${fixture.repo} add:*)`,
      `Bash(git -C ${fixture.repo} commit:*)`,
    ]);

    // Routed to "integrator" for real, through the orchestrator's own
    // sweep (not a Router.route() call made in isolation) — and its own
    // run lands on the same human review gate every other write-tier
    // success without a reviewer handoff gets.
    await fixture.orchestrator.sweep();
    const routed = await fixture.board.get(followUp.id);
    expect(routed!.routedTo).toBe("integrator");
    expect(routed!.status).toBe("review");

    // The integrator's own real dispatch (the 2nd write-tier call this
    // fixture makes — the implementer's own call is the 1st) actually
    // carried --add-dir <fixture.repo>, not just that the task field was
    // set — proves the wiring reaches all the way to the spawned
    // command, through a real sweep(), not just through WriteExecutor's
    // own isolated unit tests.
    const integratorCmd = fixture.runner.writeCmds!()[1]!;
    const addDirIdx = integratorCmd.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThan(-1);
    expect(integratorCmd[addDirIdx + 1]).toBe(fixture.repo);
    // Same proof for --allowedTools: the git grants reach the real
    // spawned command, not just the task field.
    const allowedToolsIdx = integratorCmd.indexOf("--allowedTools");
    expect(allowedToolsIdx).toBeGreaterThan(-1);
    expect(integratorCmd.slice(allowedToolsIdx + 1, addDirIdx)).toEqual([
      "Bash(bun test:*)",
      "Bash(bun run typecheck:*)",
      `Bash(git -C ${fixture.repo} status:*)`,
      `Bash(git -C ${fixture.repo} diff:*)`,
      `Bash(git -C ${fixture.repo} add:*)`,
      `Bash(git -C ${fixture.repo} commit:*)`,
    ]);
  } finally {
    await cleanup(fixture);
  }
});

test("a second conflict for the same task, driven through a second real approve-resume, creates no duplicate follow-up", async () => {
  // Reuses the exact same lineage's worktree across two separate
  // conflicted merge attempts — the realistic version of "a second
  // conflict event for a task that already has a follow-up integrator
  // task": a human (or a failed integrator attempt) leaves the task in
  // "review" with the repo still genuinely diverged from the worktree,
  // and a later retry hits the exact same conflict again.
  const relPath = "feature.txt";
  const fixture = await setupWritingFile(
    [
      { verdict: "approve", feedback: "ship it" },
      { verdict: "approve", feedback: "ship it, second look" },
    ],
    relPath,
    "line from implementer\n",
  );
  try {
    const task = await fixture.board.create({ title: "Add a feature", body: "Implement X.", labels: ["code"], repo: fixture.repo });

    await fixture.orchestrator.sweep();
    writeFileSync(join(fixture.repo, relPath), "line from repo HEAD\n");
    git(["add", "-A"], fixture.repo);
    git(["commit", "-q", "-m", "diverge on repo HEAD"], fixture.repo);
    await fixture.orchestrator.sweep();

    expect((await fixture.board.get(task.id))!.status).toBe("review");
    expect((await fixture.board.list()).filter((t) => t.labels.includes("conflict"))).toHaveLength(1);

    // Re-run the same implementer task for real (runNow bypasses the
    // sweep's "already routed" skip — same escape hatch "a human's
    // per-task decision overrides the blanket gate" in
    // test/orchestrator.test.ts exercises). Reuses the exact same
    // worktree/branch (createTaskWorktree's own idempotent reuse, keyed
    // off task.id since this task was never pushed back) and feature.txt
    // ends up with byte-identical content again, so there's nothing new
    // to commit — the worktree branch and fixture.repo's own branch are
    // exactly as diverged as they were a moment ago, and a second
    // reviewer pass hits the exact same real conflict again.
    await fixture.orchestrator.runNow(task.id, [new WriteExecutor({ runner: fixture.runner, homeDir: fixture.home }), new ReadOnlyExecutor({ runner: fixture.runner })]);
    await waitForStatus(fixture.board, task.id, "pending-review");
    await fixture.orchestrator.sweep();

    expect((await fixture.board.get(task.id))!.status).toBe("review");
    const followUps = (await fixture.board.list()).filter((t) => t.labels.includes("conflict"));
    expect(followUps).toHaveLength(1);
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
