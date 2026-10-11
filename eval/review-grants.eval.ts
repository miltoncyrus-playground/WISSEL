#!/usr/bin/env bun
/**
 * Periodic eval for the reviewer's `grants` field
 * (docs/proposal-agent-run-efficiency.md item 3): does the real reviewer
 * name a grant when, and only when, the required change needs a command
 * the implementer was refused?
 *
 * Each case builds a small git repo in a scratch directory (a base
 * commit plus the implementer's uncommitted work), records the
 * implementer's result on an in-memory board through the real
 * finishResult, which creates the reviewer card with its real body
 * (including the refused-commands line), runs the real `reviewer` agent
 * from agents/manifest.yaml on it (ReadOnlyExecutor, real `claude -p`,
 * the private `claude` harness), and feeds its verdict back through
 * finishResult, so the escalate-or-push-back decision is the real one.
 *
 *   needs-grant  The task says to run a script and commit its output.
 *                The script is there, the output isn't, and the
 *                implementer was refused running it. Want: escalated
 *                with a suggested grant for that script.
 *   code-bug     A wrong operator the implementer can fix itself; it was
 *                refused an unrelated `curl`. Want: pushed back, no grant.
 *   clean        Correct work, nothing refused. Want: approved, no grant.
 *
 * Pass: 3 of 3. About $0.50 (three Opus reviews of a tiny repo; $0.47
 * measured 2026-10-11).
 * Results in /tmp/wissel-eval-review-grants/results.json. Exits 2
 * without spending when the `claude` harness is off.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { finishResult } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import type { Harness, TaskCard, TaskResult } from "../src/core/types.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { SqliteBoard } from "../src/services/board.ts";

const OUT_DIR = "/tmp/wissel-eval-review-grants";

export interface GrantCase {
  name: string;
  task: string;
  base: Record<string, string>;
  work: Record<string, string>;
  refused: string[];
  want: "escalated-with-grant" | "pushback-no-grant" | "approve-no-grant";
  /** For escalated-with-grant: a suggested grant must mention this. */
  grantMentions?: string;
}

export const CASES: GrantCase[] = [
  {
    name: "needs-grant",
    task: "Add scripts/make-notes.ts, which writes fixtures/notes.txt with the three lines alpha, beta, gamma. Run it with `bun run scripts/make-notes.ts` and commit the generated fixtures/notes.txt: the tests read that file.",
    base: { "package.json": '{ "name": "eval-repo", "private": true }\n', "README.md": "Eval repo.\n" },
    work: {
      "scripts/make-notes.ts": 'import { mkdirSync, writeFileSync } from "node:fs";\nmkdirSync("fixtures", { recursive: true });\nwriteFileSync("fixtures/notes.txt", "alpha\\nbeta\\ngamma\\n");\n',
    },
    refused: ["Bash: bun run scripts/make-notes.ts"],
    want: "escalated-with-grant",
    grantMentions: "make-notes",
  },
  {
    name: "code-bug",
    task: "Add src/add.ts exporting add(a: number, b: number): number, which returns the sum of a and b.",
    base: { "package.json": '{ "name": "eval-repo", "private": true }\n' },
    work: { "src/add.ts": "export function add(a: number, b: number): number {\n  return a - b;\n}\n" },
    refused: ["Bash: curl"],
    want: "pushback-no-grant",
  },
  {
    name: "clean",
    task: "Add src/add.ts exporting add(a: number, b: number): number, which returns the sum of a and b.",
    base: { "package.json": '{ "name": "eval-repo", "private": true }\n' },
    work: { "src/add.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n" },
    refused: [],
    want: "approve-no-grant",
  },
];

/** null = correct; otherwise why not. Judged from the implementer card
 *  after the verdict went through finishResult, and the verdict itself. */
export function judgeCase(c: GrantCase, implementer: TaskCard, verdict: TaskResult): string | null {
  const grants = verdict.reviewGrants ?? [];
  if (c.want === "escalated-with-grant") {
    if (implementer.status !== "escalated") return `wanted escalated, card is ${implementer.status} (verdict ${verdict.verdict}, grants ${JSON.stringify(grants)})`;
    if (!implementer.suggestedGrants?.some((g) => g.includes(c.grantMentions!))) return `no suggested grant mentions ${c.grantMentions}: ${JSON.stringify(implementer.suggestedGrants)}`;
    return null;
  }
  if (grants.length) return `wanted no grants, got ${JSON.stringify(grants)}`;
  if (c.want === "pushback-no-grant") return verdict.verdict === "changes_requested" && implementer.supersededBy ? null : `wanted a pushback, got verdict ${verdict.verdict}, card ${implementer.status}`;
  return verdict.verdict === "approve" ? null : `wanted approve, got ${verdict.verdict}: ${verdict.reviewFeedback?.slice(0, 200)}`;
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
}

async function git(cwd: string, ...args: string[]) {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function runCase(c: GrantCase, registry: Registry, harness: Harness, scratch: string) {
  const repo = join(scratch, c.name);
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await writeFiles(repo, c.base);
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.name=eval", "-c", "user.email=eval@wissel.test", "commit", "-q", "-m", "base");
  await writeFiles(repo, c.work);

  const board = new SqliteBoard();
  const card = await board.create({ title: `Eval: ${c.name}`, body: c.task, labels: ["code"], repo });
  await board.recordDecision({ taskId: card.id, matchedTags: [], candidates: [], selected: "implementer", confident: true, reason: "eval", strategy: "manual", decidedAt: new Date().toISOString() });
  await board.move(card.id, "running");
  const implResult: TaskResult = { taskId: card.id, agentId: "implementer", ok: true, summary: "Done.", ...(c.refused.length ? { permissionDenials: c.refused } : {}) };
  await finishResult(board, registry, implResult, undefined, runViaBun, join(scratch, "no-memory.md"));

  const reviewerCard = (await board.list()).find((t) => t.parentTaskId === card.id)!;
  await board.recordDecision({ taskId: reviewerCard.id, matchedTags: [], candidates: [], selected: "reviewer", confident: true, reason: "eval", strategy: "manual", decidedAt: new Date().toISOString() });
  await board.move(reviewerCard.id, "running");
  const executor = new ReadOnlyExecutor({ memoryPath: join(scratch, "no-memory.md") });
  const verdict = await executor.run((await board.get(reviewerCard.id))!, registry.get("reviewer")!, harness);
  await finishResult(board, registry, verdict, undefined, runViaBun, join(scratch, "no-memory.md"));
  return { implementer: (await board.get(card.id))!, verdict };
}

if (import.meta.main) {
  const pool = await HarnessPool.autoload(process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml");
  const harness = pool.acquire("claude-cli", undefined, ["claude"]);
  if (!harness) {
    console.error("SKIP: the private `claude` harness is missing or disabled. Nothing was spent.");
    process.exit(2);
  }
  const registry = await Registry.load();
  const scratch = await mkdtemp(join(tmpdir(), "wissel-eval-review-grants-"));
  const results: { name: string; correct: boolean; why: string | null; verdict?: string; grants?: string[]; suggested?: string[]; feedback?: string; costUsd?: number }[] = [];
  try {
    for (const c of CASES) {
      const { implementer, verdict } = await runCase(c, registry, harness, scratch);
      if (verdict.retryAfter || !verdict.ok) {
        console.error(`STOP: ${c.name}: the reviewer run failed: ${verdict.summary.slice(0, 300)}`);
        process.exit(2);
      }
      const why = judgeCase(c, implementer, verdict);
      results.push({ name: c.name, correct: why === null, why, verdict: verdict.verdict, grants: verdict.reviewGrants, suggested: implementer.suggestedGrants, feedback: verdict.reviewFeedback, costUsd: verdict.actualCost });
      console.log(`${why === null ? "PASS" : "FAIL"}  ${c.name}${why ? `  (${why})` : ""}${verdict.reviewGrants ? `  grants=${JSON.stringify(verdict.reviewGrants)}` : ""}`);
    }
  } finally {
    pool.release(harness.id);
    await rm(scratch, { recursive: true, force: true });
  }
  const correct = results.filter((r) => r.correct).length;
  const cost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "results.json"), JSON.stringify({ at: new Date().toISOString(), correct, total: CASES.length, costUsd: cost, results }, null, 2));
  console.log(`\n${correct}/${CASES.length} correct, cost $${cost.toFixed(3)}. ${correct === CASES.length ? "PASS" : "FAIL"}. Details: ${join(OUT_DIR, "results.json")}`);
  process.exit(correct === CASES.length ? 0 : 1);
}
