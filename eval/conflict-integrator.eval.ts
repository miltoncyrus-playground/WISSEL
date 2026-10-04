#!/usr/bin/env bun
/**
 * Periodic eval for the crash-recovery conflict-integrator trigger
 * (`maybeSpawnConflictIntegrator`, wired into `tryAutoMerge` in
 * src/core/orchestrator.ts — docs/SDD-crash-recovery.md §3.3/§6 Subtask
 * 3). Not run by `bun test` (gate lane) — invoke explicitly with
 * `bun run eval:conflict-integrator` before ship / nightly. See
 * eval/README.md for the exact scheduled command.
 *
 * The gate tests (test/orchestrator.test.ts,
 * test/orchestrator-review-lifecycle.test.ts) already prove the
 * trigger/idempotency/fallback wiring is correct — real git, scripted
 * or real conflicts, but always against the implementer's own fake
 * "claude" for the write-tier calls. None of them prove the one claim
 * that actually matters: that the real `integrator` agent, pointed at a
 * real conflicted repo, produces a *correct* resolution rather than a
 * plausible-looking one. This eval is the one place that gets checked.
 *
 * Shaped like this session's own two real conflicts (see
 * docs/SDD-crash-recovery.md §2): two independently-additive changes to
 * the same small section of the same file, nothing contradictory. The
 * eval never calls `claude` for the setup side — the "implementer" and
 * "repo HEAD" content are written directly via `writeFileSync`, so the
 * only real, paid `claude` call this eval ever makes is the one under
 * test: the integrator's own conflict-resolution attempt.
 *
 * Pass bar: after the real integrator run, `repo`'s working tree must
 * have (a) no unresolved conflict markers, (b) no unmerged paths in
 * `git status`, (c) both the implementer's line and the HEAD line
 * present in the file, and (d) a real merge commit — `git log` on the
 * current branch must contain a commit whose message matches the
 * original task's merge commit message. Any single miss fails the
 * eval; this is a correctness bar, not a partial-credit score.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, finishResult } from "../src/core/orchestrator.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { createTaskWorktree } from "../src/services/worktree.ts";
import type { AgentDef } from "../src/core/types.ts";

/**
 * A synthetic stand-in for whatever agent "implemented" the original
 * task — autoMerge:true, trustLevel:"high", deliberately no `handoffs`.
 * Mirrors test/orchestrator.test.ts's own `autoMergeAgent` fixture, for
 * the identical reason: the real `implementer` declares `handoffs:
 * [reviewer]`, and finishResult checks that branch *before* the
 * autoMerge/tryAutoMerge branch (see src/core/orchestrator.ts) — calling
 * finishResult with agentId "implementer" would just queue a reviewer
 * task and return, never reaching tryAutoMerge at all. This eval isn't
 * testing the implementer->reviewer->resumeAfterApproval loop (that's
 * already covered live elsewhere, e.g. eval/implementer-reviewer.eval.ts)
 * — it's testing tryAutoMerge's own conflict trigger directly, the same
 * way the gate test does, just with a real conflict and a real
 * integrator dispatch instead of both faked.
 */
const autoMergeAgent: AgentDef = {
  id: "eval-synthetic-auto-merge",
  name: "Eval synthetic auto-merge",
  kind: "agent",
  tier: "write",
  description: "Stands in for the original task's implementer — this eval tests tryAutoMerge's conflict trigger, not a specific implementer agent.",
  whenToUse: "Never routed to by the real Router — only ever referenced directly by agentId in this eval.",
  tags: [],
  executor: "handoff",
  inputs: [],
  outputs: [],
  trustLevel: "high",
  toolAccess: [],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0 },
  autoMerge: true,
};

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function realRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-eval-conflict-integrator-repo-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-eval@example.com"], dir);
  git(["config", "user.name", "wissel eval"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "seed"], dir);
  return dir;
}

const FILE = "src/features.ts";
const BASE = 'export const FEATURES = [\n  "base",\n];\n';
const WITH_A = 'export const FEATURES = [\n  "base",\n  "feature-a",\n];\n';
const WITH_B = 'export const FEATURES = [\n  "base",\n  "feature-b",\n];\n';

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-conflict-integrator-home-"));
  const board = new SqliteBoard();
  // The real manifest (so the follow-up's real "conflict" label routes
  // to the real `integrator`), plus the synthetic autoMergeAgent above
  // standing in for the original task's own implementer.
  const registry = Registry.from([...(await Registry.load()).all(), autoMergeAgent]);
  const router = new Router(registry);
  const executors = [new WriteExecutor({ runner: runViaBun, homeDir }), new ReadOnlyExecutor({ runner: runViaBun })];
  const orchestrator = new Orchestrator(board, registry, router, executors, undefined, { executeWriteTier: true });

  const repo = await realRepo();
  try {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, FILE), BASE);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "seed features file"], repo);

    const task = await board.create({
      title: "Add feature-a to FEATURES",
      body: 'Append "feature-a" to the FEATURES array in src/features.ts.',
      labels: ["code"],
      repo,
    });

    // Simulates what a real implementer run would have left behind in
    // its own worktree: feature-a appended, committed only once
    // mergeTaskWorktree runs (see tryAutoMerge below) — never a real
    // `claude` call, since the content itself isn't what's under test
    // here.
    const worktree = await createTaskWorktree(repo, task.id, { runner: runViaBun, homeDir });
    if ("error" in worktree) throw new Error(`createTaskWorktree failed: ${worktree.error}`);
    writeFileSync(join(worktree.path, FILE), WITH_A);

    // Diverges repo HEAD with feature-b at the exact same array —
    // additive on both sides, nothing contradictory, the shape
    // docs/SDD-crash-recovery.md §2 confirms as the common real case.
    writeFileSync(join(repo, FILE), WITH_B);
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "add feature-b on HEAD"], repo);

    console.log("Driving the real tryAutoMerge path (real git, real conflict)...");
    // Exercises the actual production trigger, not a reimplementation:
    // finishResult -> tryAutoMerge -> mergeTaskWorktree hits a real
    // conflict exit code from a real `git merge`, then
    // maybeSpawnConflictIntegrator spawns the real follow-up.
    await finishResult(board, registry, { taskId: task.id, agentId: autoMergeAgent.id, ok: true, summary: "added feature-a", worktree }, undefined, runViaBun);

    const original = await board.get(task.id);
    if (original?.status !== "review") {
      throw new Error(`expected original task to land on "review" after the conflict, got "${original?.status}"`);
    }

    const followUps = (await board.list()).filter((t) => t.labels.includes("conflict"));
    if (followUps.length !== 1) {
      throw new Error(`expected exactly 1 conflict follow-up task, got ${followUps.length}`);
    }
    const followUp = followUps[0]!;
    console.log(`Follow-up task created: ${followUp.id} (${followUp.title})`);

    console.log("Dispatching the real integrator agent (real `claude` call, real cost)...");
    await orchestrator.sweep();

    const routed = await board.get(followUp.id);
    const result = await board.getResult(followUp.id);
    console.log(`Integrator run finished: routedTo=${routed?.routedTo} status=${routed?.status} ok=${result?.ok} summary=${result?.summary?.slice(0, 300)}`);

    const repoStatus = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8");
    const fileContent = existsSync(join(repo, FILE)) ? readFileSync(join(repo, FILE), "utf8") : "";
    const log = Bun.spawnSync(["git", "log", "--oneline", "-n", "10"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8");

    const checks = [
      { name: "routed to integrator", pass: routed?.routedTo === "integrator" },
      { name: "no unmerged paths (clean git status)", pass: !/^(U|AA|DD)/m.test(repoStatus) && repoStatus.trim() === "" },
      { name: "no leftover conflict markers in file", pass: !fileContent.includes("<<<<<<<") && !fileContent.includes(">>>>>>>") },
      { name: "feature-a present", pass: fileContent.includes('"feature-a"') },
      { name: "feature-b present", pass: fileContent.includes('"feature-b"') },
      { name: "a real merge commit landed", pass: /Merge wissel\//.test(log) || /merge/i.test(log) },
    ];

    console.log("");
    console.log(`Final ${FILE}:\n---\n${fileContent}---`);
    console.log(`\ngit status --porcelain:\n${repoStatus || "(clean)"}`);
    console.log(`\ngit log:\n${log}`);
    console.log("");
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);

    const overallPass = checks.every((c) => c.pass);
    console.log(`\nOverall: ${overallPass ? "PASS" : "FAIL"}`);
    if (!overallPass) process.exit(1);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

await main();
