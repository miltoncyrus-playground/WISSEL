#!/usr/bin/env bun
/**
 * Live smoke test for the full task lifecycle recreated as a real
 * PipelineDef (src/core/full-lifecycle-pipeline.ts) — the same review-handoff
 * loop eval/pipeline-review-handoff.eval.ts already proves, with one more
 * real `claude -p` call in front of it: `triager`, turning the fixture's
 * raw input into a structured card before the implementer/reviewer loop
 * ever starts. Real `claude -p` calls (triager + implementer +
 * pipeline-reviewer), real git worktrees, real (tiny) Anthropic API calls
 * for the terminal notice step — nothing scripted or mocked. Not run by
 * `bun test` (gate lane) — invoke explicitly with
 * `bun run eval:pipeline-full-lifecycle` before ship / nightly, same as
 * this project's other evals (see eval/README.md).
 *
 * test/full-lifecycle-pipeline.test.ts (gate lane) already proves the
 * graph's *shape* against a scripted claude/Anthropic stand-in: triage is
 * the pipeline's only entry step, it runs before the implementer loop, and
 * the loop itself is byte-identical to review-handoff-pipeline.ts's own
 * (same attempt cap, same fail-closed behavior). What that can't prove is
 * whether the real `triager` agent actually produces a usable structured
 * card that the real implementer/reviewer loop then converges through —
 * that's what this eval checks, with the same two fixtures
 * eval/pipeline-review-handoff.eval.ts uses (chosen to exercise both
 * terminal outcomes), now fed through `triager` first instead of handed
 * to the implementer directly:
 *
 *   - "trivial-sum": expected to reach `done` via "approved" after exactly
 *     1 triage pass and 1 implementer attempt.
 *   - "contradictory-parity": acceptance criteria that directly contradict
 *     each other — no implementation can satisfy all four, so
 *     `pipeline-reviewer` must request changes every time, reaching `done`
 *     via "escalated" after exactly 1 triage pass and
 *     REVIEW_HANDOFF_PUSHBACK_LIMIT + 1 implementer attempts.
 *
 * Pass bar: both fixtures land on `done`, with exactly one "triage" step
 * card, "trivial-sum" via "approved" with exactly 1 implementer attempt,
 * "contradictory-parity" via "escalated" with exactly
 * REVIEW_HANDOFF_PUSHBACK_LIMIT + 1 implementer attempts. Either fixture
 * landing on `failed`, or triage running more than once, is a real finding
 * about this pipeline, not something to paper over by loosening the bar.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { startPipelineRun, type PipelineRunnerContext } from "../src/core/pipeline-runner.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { ApiExecutor } from "../src/executors/anthropic-api.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
import {
  FULL_LIFECYCLE_PIPELINE_DESCRIPTION,
  FULL_LIFECYCLE_PIPELINE_NAME,
  buildFullLifecyclePipelineGraph,
} from "../src/core/full-lifecycle-pipeline.ts";
import { REVIEW_HANDOFF_PUSHBACK_LIMIT } from "../src/core/review-handoff-pipeline.ts";
import type { TaskCard } from "../src/core/types.ts";

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

async function realRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `wissel-eval-${prefix}-`));
  git(["init", "-q"], dir);
  git(["config", "user.email", "wissel-eval@example.com"], dir);
  git(["config", "user.name", "wissel eval"], dir);
  git(["commit", "--allow-empty", "-q", "-m", "seed"], dir);
  return dir;
}

interface Fixture {
  name: string;
  expected: "approved" | "escalated";
  input: string;
}

const FIXTURES: Fixture[] = [
  {
    name: "trivial-sum",
    expected: "approved",
    input: [
      "Add sum(a, b) to src/math.ts",
      "",
      "Acceptance criteria:",
      "- Export a function `sum(a: number, b: number): number` from `src/math.ts` that returns `a + b`.",
      "- Do not modify or create any other files.",
      "- Keep the implementation to just this one function — no extra helpers, no extra exports.",
    ].join("\n"),
  },
  {
    name: "contradictory-parity",
    expected: "escalated",
    input: [
      "Add isEvenSpecial(n) to src/parity.ts",
      "",
      "Acceptance criteria (all four are mandatory and must hold simultaneously — none is an exception to another):",
      "1. Export a function `isEvenSpecial(n: number): boolean` from `src/parity.ts`.",
      "2. For every even integer `n`, `isEvenSpecial(n)` must return `true`.",
      "3. For every odd integer `n`, `isEvenSpecial(n)` must return `false`.",
      "4. `isEvenSpecial(7)` must return `true`.",
      "",
      "Note: 7 is odd, so criteria 3 and 4 both apply to it. Implement your best attempt at satisfying all four criteria" +
        " and submit it for review — do not ask clarifying questions instead of submitting a diff.",
    ].join("\n"),
  },
];

interface FixtureOutcome {
  fixture: Fixture;
  finalStatus: TaskCard["status"];
  terminalStep: string | undefined;
  triageAttempts: number;
  implementerAttempts: number;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-pipeline-full-lifecycle-home-"));
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  const runner = runViaBun;
  const executors = [new WriteExecutor({ runner, homeDir }), new ReadOnlyExecutor({ runner }), new ApiExecutor()];
  const ctx: PipelineRunnerContext = { executors, pipelines };
  const pipelineDef = await pipelines.create({
    name: FULL_LIFECYCLE_PIPELINE_NAME,
    description: FULL_LIFECYCLE_PIPELINE_DESCRIPTION,
    graph: buildFullLifecyclePipelineGraph(),
  });

  const repos: string[] = [];
  try {
    const outcomes: FixtureOutcome[] = [];
    let totalCost = 0;

    for (const fixture of FIXTURES) {
      const repo = await realRepo(fixture.name);
      repos.push(repo);

      console.log(`Running "${fixture.name}" through startPipelineRun (real claude, real worktree)...`);
      const root = await startPipelineRun(board, registry, pipelineDef, repo, fixture.input, ctx);

      const stepCards = (await board.list()).filter((t) => t.pipelineRunId === root.id);
      const triageCards = stepCards.filter((t) => t.pipelineStepId === "triage");
      const implCards = stepCards.filter((t) => t.pipelineStepId?.startsWith("impl-"));
      const terminalCard = stepCards.find((t) => t.pipelineStepId === "approved" || t.pipelineStepId === "escalated");

      for (const card of [...stepCards, root]) {
        const result = await board.getResult(card.id);
        if (result?.actualCost) totalCost += result.actualCost;
      }

      const pass =
        root.status === "done" &&
        triageCards.length === 1 &&
        terminalCard?.pipelineStepId === fixture.expected &&
        implCards.length === (fixture.expected === "approved" ? 1 : REVIEW_HANDOFF_PUSHBACK_LIMIT + 1);

      outcomes.push({
        fixture,
        finalStatus: root.status,
        terminalStep: terminalCard?.pipelineStepId,
        triageAttempts: triageCards.length,
        implementerAttempts: implCards.length,
        pass,
        detail: `root=${root.status}, terminal=${terminalCard?.pipelineStepId ?? "(none)"}, triage attempts=${triageCards.length}, implementer attempts=${implCards.length} (expected ${fixture.expected}, 1 triage, ${fixture.expected === "approved" ? 1 : REVIEW_HANDOFF_PUSHBACK_LIMIT + 1} implementer)`,
      });
    }

    console.log("");
    for (const o of outcomes) {
      console.log(`${o.pass ? "PASS" : "FAIL"}  ${o.fixture.name}  (${o.detail})`);
    }
    console.log(`\nTotal real cost this run: $${totalCost.toFixed(4)}`);

    const overallPass = outcomes.every((o) => o.pass);
    if (!overallPass) {
      process.exit(1);
    }
  } finally {
    for (const repo of repos) {
      await rm(repo, { recursive: true, force: true });
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}

await main();
