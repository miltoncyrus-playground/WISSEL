#!/usr/bin/env bun
/**
 * Decision-card quality (docs/SDD-coordinator.md §8): the real `decider`
 * agent answers the fixed cases in eval/decision-quality-cases.ts, each
 * through the same brief a live decision card gets (decisionBrief) and
 * the same strict parser (parseDecision, in the executor). Real `claude`
 * calls, real cost: not run by `bun test`. Invoke it with
 * `bun run eval:decision-quality` before a ship, or nightly.
 *
 * Judged in code (judgeDecision): schema validity and agreement with the
 * case's known good answer. Pass: at least 9 of 10 valid and 8 of 10
 * agreeing. Each run's scores are appended to
 * eval/history/decision-quality.jsonl (git-ignored), so they can be
 * tracked over time; the full answers go to
 * /tmp/wissel-eval-decision-quality/results.json.
 *
 * `--case "<name>"` (repeatable) re-runs only those cases as a spot check:
 * never a ship verdict, and not added to the history. Exits 2 without
 * spending when no claude-cli harness is enabled.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { DECISION_LABEL, decisionBrief } from "../src/services/decisions.ts";
import type { TaskCard } from "../src/core/types.ts";
import { DECISION_CASES, judgeDecision } from "./decision-quality-cases.ts";
import { evalHarness } from "./eval-harness.ts";

const VALID_THRESHOLD = 0.9;
const AGREE_THRESHOLD = 0.8;
const RESULTS_DIR = "/tmp/wissel-eval-decision-quality";
const HISTORY = new URL("./history/decision-quality.jsonl", import.meta.url).pathname;

function picked(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--case" && argv[i + 1]) out.push(argv[++i]!);
  return out;
}

async function main() {
  const only = picked(process.argv.slice(2));
  const cases = only.length ? DECISION_CASES.filter((c) => only.includes(c.name)) : DECISION_CASES;
  if (only.length && cases.length !== only.length) {
    console.error(`unknown case(s): ${only.filter((n) => !DECISION_CASES.some((c) => c.name === n)).join(", ")}`);
    process.exit(1);
  }
  const registry = await Registry.load();
  const decider = registry.get("decider");
  if (!decider) {
    console.error("FAIL  agents/manifest.yaml has no decider entry");
    process.exit(1);
  }
  let run: Awaited<ReturnType<typeof evalHarness>>;
  try {
    run = await evalHarness("claude-cli", decider.harnesses);
  } catch (e) {
    console.error(`SKIP  ${(e as Error).message}`);
    process.exit(2);
  }

  const dir = await mkdtemp(join(tmpdir(), "wissel-decision-eval-"));
  const rows: { name: string; kind: string; valid: boolean; agrees: boolean; why: string; cost: number; answer: unknown; summary: string }[] = [];
  try {
    const executor = new ReadOnlyExecutor({ memoryPath: join(dir, "lessons.md") });
    for (const c of cases) {
      const task: TaskCard = { id: `eval-decision-${rows.length + 1}`, title: `Decide ${c.kind}`, body: decisionBrief(c.kind, c.context), labels: [DECISION_LABEL, `decision:${c.kind}`], repo: dir, status: "ready" };
      const result = await executor.run(task, decider, run.harness);
      const j = judgeDecision(c, result.ok ? result.decision : null);
      rows.push({ name: c.name, kind: c.kind, ...j, cost: result.actualCost ?? 0, answer: result.decision ?? null, summary: result.summary.slice(0, 2000) });
      console.log(`${j.agrees ? "AGREE  " : j.valid ? "DIFFER " : "INVALID"}  ${c.name}: ${j.why}`);
    }
  } finally {
    run.release();
    await rm(dir, { recursive: true, force: true });
  }

  const valid = rows.filter((r) => r.valid).length;
  const agree = rows.filter((r) => r.agrees).length;
  const cost = rows.reduce((n, r) => n + r.cost, 0);
  const pass = valid / rows.length >= VALID_THRESHOLD && agree / rows.length >= AGREE_THRESHOLD;
  console.log(`\nValid: ${valid}/${rows.length} (threshold ${VALID_THRESHOLD * 100}%)`);
  console.log(`Agree: ${agree}/${rows.length} (threshold ${AGREE_THRESHOLD * 100}%)`);
  console.log(`Real cost this run: $${cost.toFixed(4)}`);

  await mkdir(RESULTS_DIR, { recursive: true });
  await writeFile(join(RESULTS_DIR, only.length ? "spot-check.json" : "results.json"), JSON.stringify({ at: new Date().toISOString(), model: decider.costProfile?.model, valid, agree, total: rows.length, cost, rows }, null, 2));
  if (only.length) {
    console.log("\nSpot check: not a ship verdict, not added to the history.");
    return;
  }
  await mkdir(new URL("./history/", import.meta.url).pathname, { recursive: true });
  await appendFile(HISTORY, `${JSON.stringify({ at: new Date().toISOString(), model: decider.costProfile?.model, valid, agree, total: rows.length, cost, differ: rows.filter((r) => !r.agrees).map((r) => r.name) })}\n`);
  console.log(`\nOVERALL: ${pass ? "PASS" : "FAIL"}  (history: ${HISTORY})`);
  if (!pass) process.exit(1);
}

await main();
