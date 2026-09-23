#!/usr/bin/env bun
/**
 * Periodic eval for the planner's structured-output contract
 * (outputContractFormat: "subtask-plan" in agents/manifest.yaml,
 * parseSubtaskPlan, spawnSubtasksFromPlan in src/core/orchestrator.ts):
 * real `claude` calls, real cost. Not run by `bun test` (gate lane) —
 * invoke explicitly with `bun run eval:planner-subtask-plan` before ship
 * / nightly.
 *
 * The gate tests (test/parse-subtask-plan.test.ts,
 * test/orchestrator.test.ts) already prove the parsing and card-spawning
 * logic is correct against a *scripted* plan fed in by hand. What they
 * can't prove is whether the real planner agent, running in real plan
 * mode against a real vague card, actually produces a well-formed
 * ```subtask-plan``` block often enough to be useful — the entire point
 * of this feature is that a human should never again have to read the
 * planner's prose and hand-create cards (see card 4428a913, done
 * manually, the reason this feature exists). If the real model regularly
 * forgets the block, or the block's `dependsOnIndex` chaining doesn't
 * hold up in the wild, this is where that shows up.
 *
 * Each fixture is a vague card exactly like the ones the planner is
 * `whenToUse`'d for. Pass bar per fixture: the run is `ok: true` (which
 * already implies parseSubtaskPlan didn't reject the block — see
 * runClaude's contract-violation branch), the plan has at least 2 items,
 * and every `dependsOnIndex` resolves to a real earlier sibling once
 * finishResult spawns the real child cards on a real board.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { finishResult } from "../src/core/orchestrator.ts";
import type { TaskCard } from "../src/core/types.ts";

interface Fixture {
  name: string;
  title: string;
  body: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "vague feature outcome",
    title: "Add rate limiting to the public API",
    body: "We're getting hammered by a few clients making way too many requests. Figure out a rate limiting approach and get it built and tested.",
  },
  {
    name: "vague migration outcome",
    title: "Move the task board off SQLite onto Postgres",
    body: "SQLite is fine for now but we'll outgrow it. Plan and execute the migration to Postgres, keeping the app working the whole time.",
  },
];

interface FixtureOutcome {
  fixture: Fixture;
  pass: boolean;
  detail: string;
  cost: number;
}

const PASS_THRESHOLD = 1.0;

async function main() {
  const registry = await Registry.load();
  const plannerAgent = registry.get("planner")!;
  const executor = new ReadOnlyExecutor();

  const outcomes: FixtureOutcome[] = [];

  for (const fixture of FIXTURES) {
    const dir = await mkdtemp(join(tmpdir(), "wissel-planner-eval-"));
    try {
      const board = new SqliteBoard();
      const plannerTask = await board.create({ title: fixture.title, body: fixture.body, labels: ["planning"], repo: dir });
      const runTask: TaskCard = { ...plannerTask };

      const result = await executor.run(runTask, plannerAgent);
      const cost = result.actualCost ?? 0;

      if (!result.ok) {
        outcomes.push({ fixture, pass: false, detail: `ok:false — ${result.summary.slice(0, 200)}`, cost });
        continue;
      }
      if (!result.subtaskPlan || result.subtaskPlan.length < 2) {
        outcomes.push({ fixture, pass: false, detail: `only ${result.subtaskPlan?.length ?? 0} subtask item(s), need >= 2`, cost });
        continue;
      }

      await finishResult(board, registry, result);

      const planned = await board.get(plannerTask.id);
      const children = (await board.list()).filter((t) => t.parentTaskId === plannerTask.id);

      const plannerDone = planned?.status === "done";
      const childCount = children.length === result.subtaskPlan.length;
      const depsResolved = result.subtaskPlan.every((item, i) => {
        if (item.dependsOnIndex === undefined) return true;
        const child = children[i];
        const predecessor = children[item.dependsOnIndex];
        return child && predecessor && child.dependsOn?.includes(predecessor.id);
      });

      const pass = plannerDone && childCount && depsResolved;
      outcomes.push({
        fixture,
        pass,
        detail: `plannerDone=${plannerDone} children=${children.length}/${result.subtaskPlan.length} depsResolved=${depsResolved} titles=${JSON.stringify(children.map((c) => c.title))}`,
        cost,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("");
  for (const o of outcomes) {
    console.log(`${o.pass ? "PASS" : "FAIL"}  ${o.fixture.name}  (${o.detail})  [$${o.cost.toFixed(4)}]`);
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const score = passed / outcomes.length;
  const totalCost = outcomes.reduce((sum, o) => sum + o.cost, 0);
  console.log(`\n${passed}/${outcomes.length} passed (${(score * 100).toFixed(0)}%), threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`Total real cost this run: $${totalCost.toFixed(4)}`);

  if (score < PASS_THRESHOLD) {
    process.exit(1);
  }
}

await main();
