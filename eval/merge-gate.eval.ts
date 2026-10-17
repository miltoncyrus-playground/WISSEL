#!/usr/bin/env bun
/**
 * Periodic eval for the merge gate (mergeTaskWorktree's gate step,
 * docs/SDD-worktree-isolation.md §7). Not run by `bun test`
 * (gate lane): `bun run eval:merge-gate` before ship / nightly. Real
 * `claude` calls (implementer, then reviewer), real cost, real git.
 *
 * The gate tests (test/merge-path.test.ts) prove the mechanics against
 * scripted gate commands: a failing gate never lands, the pushback
 * carries the output, the count and cap hold. What they can't prove is
 * the claim the gate exists for: that the feedback it sends back is
 * enough for the real implementer to fix the break, so the second
 * attempt lands. That is what this checks.
 *
 * The first attempt is scripted, not a model call: a realistic bug (a
 * slug() rewrite that drops the trim and so breaks an existing test the
 * task never mentions), written straight into the card's worktree. A
 * real implementer usually runs the tests itself and would never hand
 * the gate a break to catch, so a model-written first attempt would make
 * the eval measure luck. Everything after it is real: the human Merge
 * (board-actions mergeTask) runs the gate (`bun test`) in the worktree,
 * the gate fails, the pushback attempt runs on the real implementer with
 * only the gate output to go on, the real reviewer looks at it, and the
 * second Merge lands.
 *
 * Pass bar: every check below, in one run (1/1). A correctness bar, not
 * a score: the gate either caught the break and the fix landed through
 * it, or the eval fails. ROUNDS bounds the reviewer loop; a lineage that
 * needs more than that to converge fails too.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, resolveLiveTip } from "../src/core/orchestrator.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { mergeTask } from "../src/services/board-actions.ts";
import { createTaskWorktree, type MergeContext } from "../src/services/worktree.ts";
import type { TelemetryEvent } from "../src/services/telemetry.ts";

const ROUNDS = 4;

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

const SLUG = `export function slug(s: string): string {
  return s.trim().toLowerCase().replace(/\\s+/g, "-");
}
`;
const SLUG_TEST = `import { expect, test } from "bun:test";
import { slug } from "../src/slug.ts";

test("lowercases and joins words with dashes", () => {
  expect(slug("Hello World")).toBe("hello-world");
});

test("trims surrounding whitespace", () => {
  expect(slug("  spaced   out  ")).toBe("spaced-out");
});
`;
// The scripted first attempt: strips punctuation as asked, but drops
// the trim, so "trims surrounding whitespace" fails.
const BROKEN_SLUG = `export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\\s-]/g, "").replace(/\\s+/g, "-");
}
`;

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-merge-gate-home-"));
  const repo = await mkdtemp(join(tmpdir(), "wissel-eval-merge-gate-repo-"));
  const events: TelemetryEvent[] = [];
  const merge: MergeContext = {
    runner: runViaBun,
    gateFor: async () => ({ commands: [["bun", "test"]], timeoutMs: 120_000 }),
    telemetry: { record: async (e) => void events.push(e) },
  };
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const executors = [new WriteExecutor({ runner: runViaBun, homeDir }), new ReadOnlyExecutor({ runner: runViaBun })];
  // The real harness pool, built the way the server builds it (autoload
  // validates each harness, so a stale entry is dropped): model precedence is
  // task.model ?? harness.model ?? manifest (resolveModel), so without a
  // harness the eval ran the manifest model, not what production runs.
  const harnesses = await HarnessPool.autoload();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), executors, undefined, { executeWriteTier: true, merge, harnesses });

  try {
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "wissel-eval@example.com"], repo);
    git(["config", "user.name", "wissel eval"], repo);
    mkdirSync(join(repo, "src"));
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "src", "slug.ts"), SLUG);
    writeFileSync(join(repo, "test", "slug.test.ts"), SLUG_TEST);
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    git(["add", "-A"], repo);
    git(["commit", "-q", "-m", "slug"], repo);

    const task = await board.create({
      title: "Make slug() drop punctuation",
      body: [
        "Acceptance criteria:",
        '- `slug("Hello, World!")` returns `"hello-world"`: characters other than a-z, 0-9, whitespace and "-" are removed.',
        "- Everything slug() already does keeps working.",
        "- Only edit src/slug.ts.",
      ].join("\n"),
      labels: ["code"],
      repo,
    });
    const wt = await createTaskWorktree(repo, task.id, { runner: runViaBun, homeDir });
    if ("error" in wt) throw new Error(wt.error);
    writeFileSync(join(wt.path, "src", "slug.ts"), BROKEN_SLUG);
    await board.recordResult({ taskId: task.id, agentId: "implementer", ok: true, summary: "scripted first attempt", worktree: wt });
    await board.move(task.id, "review");

    console.log("Merge 1 (scripted broken attempt): the gate should refuse it...");
    const headBefore = git(["rev-parse", "HEAD"], repo);
    const first = await mergeTask(board, task.id, merge, registry);
    const headAfterFirst = git(["rev-parse", "HEAD"], repo);
    console.log(`  -> ${first.ok ? "LANDED (wrong)" : first.error}`);
    const original = (await board.get(task.id))!;
    const pushback = original.supersededBy ? await board.get(original.supersededBy) : undefined;

    console.log("Driving the pushback through the real implementer and reviewer...");
    let tip = pushback;
    for (let round = 1; round <= ROUNDS && tip; round++) {
      await orchestrator.sweep();
      await orchestrator.sweep();
      const all = await board.list();
      tip = resolveLiveTip(await board.get(task.id), new Map(all.map((c) => [c.id, c])));
      console.log(`  round ${round}/${ROUNDS}: tip ${tip?.id.slice(0, 8)} status=${tip?.status} pushbackCount=${tip?.pushbackCount ?? 0}`);
      if (tip?.status === "done" || tip?.status === "review" || tip?.status === "escalated" || tip?.status === "failed") break;
    }
    // A failed/escalated tip says nothing on its own; print the run's own
    // summary so a FAIL below is diagnosable without rerunning.
    if (tip && (tip.status === "failed" || tip.status === "escalated")) {
      const result = await board.getResult(tip.id);
      console.log(`  tip result (ok=${result?.ok}): ${(result?.summary ?? "no result recorded").slice(0, 2000)}`);
    }

    console.log("Merge 2 (the real fix):");
    // Two legitimate ways the fix lands: the reviewer approves and the
    // orchestrator's auto-merge lands it (tip "done"), or it stops in
    // "review" and the human Merge lands it. Both must go through the gate.
    const second = tip && tip.status === "review" ? await mergeTask(board, tip.id, merge, registry) : undefined;
    const autoLanded = tip?.status === "done";
    console.log(`  -> ${autoLanded ? "landed by auto-merge after review approval" : second === undefined ? "not attempted" : second.ok ? second.value.message : second.error}`);

    const mergeEvents = events.filter((e): e is Extract<TelemetryEvent, { type: "merge" }> => e.type === "merge");
    const repoTests = Bun.spawnSync(["bun", "test"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const probe = Bun.spawnSync(["bun", "-e", `import { slug } from "./src/slug.ts"; console.log(JSON.stringify([slug("Hello, World!"), slug("  spaced   out  ")]))`], { cwd: repo, stdout: "pipe", stderr: "pipe" });

    const checks = [
      { name: "first merge refused by the gate, nothing landed", pass: !first.ok && mergeEvents[0]?.outcome === "gate-failed" && headAfterFirst === headBefore },
      { name: "pushback created with pushbackCount 1", pass: pushback?.pushbackCount === 1 && pushback.reviewLineageId === task.id },
      { name: "pushback body carries the gate output (the failing test)", pass: !!pushback?.body.includes("Merge gate feedback") && !!pushback?.body.includes("trims surrounding whitespace") },
      { name: "second merge landed through the gate", pass: (second?.ok === true || autoLanded) && mergeEvents.at(-1)?.taskId === tip?.id && mergeEvents.at(-1)?.outcome === "landed" && mergeEvents.at(-1)?.gate === "passed" },
      { name: "the repo's own tests pass on what landed", pass: repoTests.exitCode === 0 },
      { name: "the landed slug() does both", pass: probe.stdout.toString("utf8").trim() === JSON.stringify(["hello-world", "spaced-out"]) },
      { name: "the user's checkout never had a merge in progress", pass: !existsSync(join(repo, ".git", "MERGE_HEAD")) },
    ];

    let cost = 0;
    for (const c of await board.list()) cost += (await board.getResult(c.id))?.actualCost ?? 0;

    console.log("");
    for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
    console.log(`\nmerge events: ${mergeEvents.map((e) => `${e.outcome}/${e.gate}`).join(", ")}`);
    console.log(`Total real cost this run: $${cost.toFixed(4)}`);
    const pass = checks.every((c) => c.pass);
    console.log(`Overall: ${pass ? "PASS" : "FAIL"} (threshold: all ${checks.length} checks, 1/1 run)`);
    if (!pass) process.exit(1);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

await main();
