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
 * Since 2026-10-17 the conflict lives in the original card's worktree
 * (the merge path merges the repo's HEAD into the branch there, never in
 * `repo` itself), so that is where the integrator resolves it. Since
 * 2026-10-19 the integrator only edits: its sandbox denies `git add` and
 * `git commit` there (the repo's `.git`, write-denied, holds the
 * worktree's gitdir), so the merge stays open until the original card
 * is merged again (board-actions mergeTask, the Merge button) and
 * Wissel's own process commits the resolution (worktree.ts
 * finishResolvedMerge), runs the gate and lands it. No manual git
 * anywhere in this path; this eval has none either.
 *
 * Pass bar: `repo` untouched by the conflict (clean, same HEAD); after
 * the real integrator run, the worktree has (a) no conflict markers,
 * (b) both the implementer's line and the HEAD line present, (c) the
 * merge still open (the integrator did not and could not commit), and
 * the integrator card finished on review; then the second Merge commits
 * it with the prepared `Merge wissel/<id>: ...` message, passes a gate
 * that checks the merged file, lands it in `repo` as exactly one such
 * commit, and the `merge` telemetry event names the integrator card.
 * Any single miss fails the eval; this is a correctness bar, not a
 * partial-credit score.
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
import { createTaskWorktree, type MergeContext } from "../src/services/worktree.ts";
import { mergeTask } from "../src/services/board-actions.ts";
import type { AgentDef } from "../src/core/types.ts";
import type { TelemetryEvent } from "../src/services/telemetry.ts";
import { evalHarnessPool } from "./eval-harness.ts";

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
  // The server's harness pool, so every card runs its model (eval/eval-harness.ts).
  const harnesses = await evalHarnessPool();
  const orchestrator = new Orchestrator(board, registry, router, executors, undefined, { executeWriteTier: true, harnesses });

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
    // conflict merging repo HEAD into the branch in the worktree, then
    // maybeSpawnConflictIntegrator spawns the real follow-up.
    const headBefore = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim();
    await finishResult(board, registry, { taskId: task.id, agentId: autoMergeAgent.id, ok: true, summary: "added feature-a", worktree }, undefined, runViaBun);
    const repoUntouched =
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim() === headBefore &&
      Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim() === "" &&
      !existsSync(join(repo, ".git", "MERGE_HEAD"));

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

    // The resolution, where the integrator made it: the worktree. The
    // merge is still open: the integrator edits, it cannot commit.
    const wtStatus = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktree.path, stdout: "pipe" }).stdout.toString("utf8");
    const wtMerging = Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: worktree.path }).exitCode === 0;
    const wtContent = existsSync(join(worktree.path, FILE)) ? readFileSync(join(worktree.path, FILE), "utf8") : "";
    const wtMarkers = /^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(wtContent);

    // Then the original card is merged again (the Merge button): Wissel
    // commits the resolution, runs the gate on the merged tree, lands.
    // The gate reads the merged file, so a wrong resolution fails here.
    const events: TelemetryEvent[] = [];
    const mergeContext: MergeContext = {
      runner: runViaBun,
      gateFor: async () => ({ commands: [["sh", "-c", `grep -q '"feature-a"' ${FILE} && grep -q '"feature-b"' ${FILE} && ! grep -q '^<<<<<<<' ${FILE}`]] }),
      telemetry: { record: async (e) => void events.push(e) },
    };
    console.log("Merging the original card again (Wissel commits the resolution, gate checks the merged file, ff-only into repo)...");
    const landed = await mergeTask(board, task.id, mergeContext, registry);
    console.log(`  -> ${landed.ok ? landed.value.message : landed.error}`);
    const fileContent = existsSync(join(repo, FILE)) ? readFileSync(join(repo, FILE), "utf8") : "";
    const log = Bun.spawnSync(["git", "log", "--oneline", "-n", "10"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8");
    const landings = Bun.spawnSync(["git", "log", "--merges", "--format=%s"], { cwd: repo, stdout: "pipe" })
      .stdout.toString("utf8")
      .split("\n")
      .filter((s) => s.startsWith(`Merge ${worktree.branch}:`));
    const headMessage = Bun.spawnSync(["git", "log", "-1", "--format=%B"], { cwd: repo, stdout: "pipe" }).stdout.toString("utf8").trim();
    const mergeEvent = events.find((e): e is Extract<TelemetryEvent, { type: "merge" }> => e.type === "merge");

    const checks = [
      { name: "repo untouched by the conflict (same HEAD, clean, no MERGE_HEAD)", pass: repoUntouched },
      { name: "routed to integrator", pass: routed?.routedTo === "integrator" },
      { name: "integrator card finished on review", pass: routed?.status === "review" },
      { name: "worktree: no leftover conflict markers after the integrator", pass: !wtMarkers },
      { name: "worktree: both features present after the integrator", pass: wtContent.includes('"feature-a"') && wtContent.includes('"feature-b"') },
      { name: "worktree: merge still open after the integrator (it edits, Wissel commits)", pass: wtMerging && /^(UU|AA|DD|M )/m.test(wtStatus) },
      { name: "second Merge: Wissel finished the resolved merge (message names the integrator card)", pass: landed.ok && landed.value.message.includes(`finished the conflict merge resolved by card ${followUp.id}`) },
      { name: "second Merge: gate passed on the merged tree", pass: mergeEvent?.gate === "passed" },
      { name: "telemetry merge event carries resolvedConflictBy = the integrator card", pass: mergeEvent?.resolvedConflictBy === followUp.id },
      { name: "landing commit message is the prepared Merge wissel/<id>: ... (no Conflicts comment)", pass: headMessage === `Merge ${worktree.branch}: Add feature-a to FEATURES` },
      { name: "feature-a present after landing", pass: fileContent.includes('"feature-a"') },
      { name: "feature-b present after landing", pass: fileContent.includes('"feature-b"') },
      { name: "landed with exactly one Merge wissel/ commit", pass: landed.ok && landings.length === 1 },
      { name: "repo clean after landing, worktree removed", pass: !existsSync(join(repo, ".git", "MERGE_HEAD")) && !existsSync(worktree.path) },
    ];

    console.log("");
    console.log(`Final ${FILE}:\n---\n${fileContent}---`);
    console.log(`\nworktree git status --porcelain after the integrator:\n${wtStatus || "(clean)"}`);
    console.log(`worktree merge still open after the integrator: ${wtMerging}`);
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
