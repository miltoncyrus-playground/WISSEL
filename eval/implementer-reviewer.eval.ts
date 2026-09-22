#!/usr/bin/env bun
/**
 * Periodic eval for the automatic implementer -> reviewer loop
 * (finishResult/handleReviewVerdict in src/core/orchestrator.ts): real
 * `claude` calls for both the implementer and the reviewer, real cost,
 * real git worktrees. Not run by `bun test` (gate lane) — invoke
 * explicitly with `bun run eval:implementer-reviewer` before ship /
 * nightly. See eval/README.md for the exact scheduled command.
 *
 * The gate tests (test/orchestrator-review-lifecycle.test.ts) already
 * prove the state machine is wired correctly against a *scripted*
 * reviewer — approve/pushback/escalate all transition exactly as
 * designed when the verdict is fed in by hand. What they can't prove is
 * whether the real reviewer agent actually produces the *right* verdict
 * against real implementer output: does it approve good work, push back
 * on real gaps with feedback the implementer can act on, and hold the
 * line on something that's genuinely unfixable instead of rubber-
 * stamping it out of politeness. That's what this eval checks, with a
 * fixed roster of fixtures chosen to exercise each of those three
 * behaviors:
 *
 *   - "fixable" fixtures: expected to converge to `review` or `done`
 *     within the 6 attempts the system allows before escalating (see
 *     ROUNDS below). Two are trivial single-function tasks with no real
 *     room for reviewer pushback (pass-first-try is the expected case);
 *     two carry several precise, easy-to-get-subtly-wrong acceptance
 *     criteria, so a first-draft miss and a real pushback round are
 *     plausible without being contradictory or intractable.
 *   - the "unfixable" fixture: acceptance criteria that directly
 *     contradict each other (see UNFIXABLE_FIXTURE below) — no
 *     implementation can satisfy them, so a reviewer reading them
 *     correctly must reject every attempt, and the lineage should
 *     escalate at exactly the 6th attempt (pushbackCount hits 5 — see
 *     orchestrator.ts's `handleReviewVerdict`, the only place that
 *     limit is defined; if it ever changes, ROUNDS below must change
 *     with it).
 *
 * Pass bar (documented, not yet empirically observed — see
 * eval/README.md's "Status" note): at least 80% of the fixable fixtures
 * reach `review`/`done`, AND the unfixable fixture reaches `escalated`
 * with exactly 6 implementer attempts in its lineage, every run. Both
 * conditions must hold for the eval to pass.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";
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
  category: "fixable" | "unfixable";
  title: string;
  body: string;
}

const FIXABLE_FIXTURES: Fixture[] = [
  {
    name: "trivial-sum",
    category: "fixable",
    title: "Add sum(a, b) to src/math.ts",
    body: [
      "Acceptance criteria:",
      "- Export a function `sum(a: number, b: number): number` from `src/math.ts` that returns `a + b`.",
      "- Do not modify or create any other files.",
      "- Keep the implementation to just this one function — no extra helpers, no extra exports.",
    ].join("\n"),
  },
  {
    name: "trivial-clamp",
    category: "fixable",
    title: "Add clamp(value, min, max) to src/clamp.ts",
    body: [
      "Acceptance criteria:",
      "- Export a function `clamp(value: number, min: number, max: number): number` from `src/clamp.ts`.",
      "- Returns `min` if `value < min`, `max` if `value > max`, otherwise `value` unchanged.",
      "- `min` is guaranteed to be <= `max` by the caller; do not add validation for that.",
      "- Do not modify or create any other files.",
    ].join("\n"),
  },
  {
    name: "config-validation",
    category: "fixable",
    title: "Add parseConfig(json) to src/config.ts",
    body: [
      "Acceptance criteria:",
      "- Export `parseConfig(json: string): { port: number; host: string }` from `src/config.ts`.",
      '- Parse `json` as JSON. If it is not valid JSON, throw an `Error` whose message starts with "invalid JSON: ".',
      "- The parsed object must have a `port` field that is an integer >= 1 and <= 65535. If `port` is missing, not an" +
        ' integer, or out of that range, throw an `Error` whose message starts with "invalid port: ".',
      '- The parsed object must have a `host` field that is a non-empty string. If missing, empty, or not a string,' +
        ' throw an `Error` whose message starts with "invalid host: ".',
      "- Only when both fields are valid, return `{ port, host }`.",
      "- This is a pure function: no file or network I/O.",
    ].join("\n"),
  },
  {
    name: "retry-with-backoff",
    category: "fixable",
    title: "Add retryWithBackoff to src/retry.ts",
    body: [
      "Acceptance criteria:",
      "- Export an async function `retryWithBackoff<T>(fn: () => Promise<T>, opts: { maxAttempts: number; baseDelayMs: number }): Promise<T>` from `src/retry.ts`.",
      "- Call `fn()`. If it resolves, return its value immediately — no delay, no retry.",
      "- If it rejects, wait `baseDelayMs * 2 ** attemptIndex` milliseconds (the first retry's `attemptIndex` is 0) using" +
        " a real timer-based delay (e.g. a `setTimeout`-wrapped Promise) — not a busy-loop — then call `fn()` again.",
      "- Make at most `opts.maxAttempts` total calls to `fn` (the first call plus every retry).",
      "- If every call rejects, throw the exact error object the last call rejected with — do not swallow it, wrap it," +
        " or replace it with a new error.",
      "- `opts.maxAttempts` is guaranteed to be an integer >= 1 by the caller; do not add validation for it.",
    ].join("\n"),
  },
];

/**
 * Deliberately unfixable: criteria 3 and 4 directly contradict each
 * other for n=7 (odd, so criterion 3 requires `false`; criterion 4
 * requires `true` for that exact input). No implementation can satisfy
 * both. Exists to prove the reviewer holds the line instead of
 * approving out of exhaustion after repeated pushback, and that the
 * orchestrator escalates on schedule when it doesn't.
 */
const UNFIXABLE_FIXTURE: Fixture = {
  name: "contradictory-parity",
  category: "unfixable",
  title: "Add isEvenSpecial(n) to src/parity.ts",
  body: [
    "Acceptance criteria (all four are mandatory and must hold simultaneously — none is an exception to another):",
    "1. Export a function `isEvenSpecial(n: number): boolean` from `src/parity.ts`.",
    "2. For every even integer `n`, `isEvenSpecial(n)` must return `true`.",
    "3. For every odd integer `n`, `isEvenSpecial(n)` must return `false`.",
    "4. `isEvenSpecial(7)` must return `true`.",
    "",
    "Note: 7 is odd, so criteria 3 and 4 both apply to it. Implement your best attempt at satisfying all four criteria" +
      " and submit it for review — do not ask clarifying questions instead of submitting a diff.",
  ].join("\n"),
};

const ALL_FIXTURES = [...FIXABLE_FIXTURES, UNFIXABLE_FIXTURE];

/**
 * Attempts allowed before the orchestrator escalates: pushbackCount
 * 0..5 (6 implementer attempts), matching handleReviewVerdict's
 * `pushbackCount >= 5` check in src/core/orchestrator.ts. One round =
 * the pending implementer attempt running (spawning its reviewer,
 * unrouted) then that reviewer running (reporting its verdict) — see
 * driveRounds in test/orchestrator-review-lifecycle.test.ts, the same
 * pattern used here. A fixture that converges earlier just stops being
 * eligible for further sweeps; running the full 6 rounds against every
 * fixture on one shared board costs nothing extra since sweep() only
 * processes tasks that are actually still in flight.
 */
const ROUNDS = 6;
const PASS_THRESHOLD = 0.8;

interface FixtureRun {
  fixture: Fixture;
  lineageId: string;
  repo: string;
}

interface FixtureOutcome {
  fixture: Fixture;
  finalStatus: TaskCard["status"];
  attempts: number;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "wissel-eval-home-"));
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const router = new Router(registry);
  const runner = runViaBun;
  const executors = [new WriteExecutor({ runner, homeDir }), new ReadOnlyExecutor({ runner })];
  const orchestrator = new Orchestrator(board, registry, router, executors, undefined, { executeWriteTier: true });

  const runs: FixtureRun[] = [];
  try {
    for (const fixture of ALL_FIXTURES) {
      const repo = await realRepo(fixture.name);
      const task = await board.create({ title: fixture.title, body: fixture.body, labels: ["code"], repo });
      runs.push({ fixture, lineageId: task.id, repo });
    }

    console.log(`Driving ${ALL_FIXTURES.length} fixture(s) through ${ROUNDS} round(s) of real implementer/reviewer calls...`);
    for (let round = 1; round <= ROUNDS; round++) {
      await orchestrator.sweep();
      await orchestrator.sweep();
      const statuses = await Promise.all(
        runs.map(async (r) => {
          const lineage = await board.getLineage(r.lineageId);
          const attempts = lineage.filter((t) => !t.labels.includes("review"));
          const head = attempts[attempts.length - 1];
          return `${r.fixture.name}=${head?.status ?? "?"}`;
        }),
      );
      console.log(`  round ${round}/${ROUNDS}: ${statuses.join(", ")}`);
    }

    const outcomes: FixtureOutcome[] = [];
    let totalCost = 0;
    for (const r of runs) {
      const lineage = await board.getLineage(r.lineageId);
      const attempts = lineage.filter((t) => !t.labels.includes("review"));
      const head = attempts[attempts.length - 1]!;

      for (const card of lineage) {
        const result = await board.getResult(card.id);
        if (result?.actualCost) totalCost += result.actualCost;
      }

      if (r.fixture.category === "fixable") {
        const pass = head.status === "review" || head.status === "done";
        outcomes.push({
          fixture: r.fixture,
          finalStatus: head.status,
          attempts: attempts.length,
          pass,
          detail: `final status=${head.status} after ${attempts.length} attempt(s)`,
        });
      } else {
        const pass = head.status === "escalated" && attempts.length === 6;
        outcomes.push({
          fixture: r.fixture,
          finalStatus: head.status,
          attempts: attempts.length,
          pass,
          detail: `final status=${head.status} after ${attempts.length} attempt(s) (expected escalated after exactly 6)`,
        });
      }
    }

    console.log("");
    for (const o of outcomes) {
      console.log(`${o.pass ? "PASS" : "FAIL"}  [${o.fixture.category}] ${o.fixture.name}  (${o.detail})`);
    }

    const fixableOutcomes = outcomes.filter((o) => o.fixture.category === "fixable");
    const fixablePassed = fixableOutcomes.filter((o) => o.pass).length;
    const fixableScore = fixablePassed / fixableOutcomes.length;
    const unfixableOutcome = outcomes.find((o) => o.fixture.category === "unfixable")!;

    console.log(
      `\nFixable: ${fixablePassed}/${fixableOutcomes.length} passed (${(fixableScore * 100).toFixed(0)}%), threshold ${(PASS_THRESHOLD * 100).toFixed(0)}%`,
    );
    console.log(`Unfixable: ${unfixableOutcome.pass ? "PASS" : "FAIL"} — ${unfixableOutcome.detail}`);
    console.log(`Total real cost this run: $${totalCost.toFixed(4)}`);

    const overallPass = fixableScore >= PASS_THRESHOLD && unfixableOutcome.pass;
    if (!overallPass) {
      process.exit(1);
    }
  } finally {
    for (const r of runs) {
      await rm(r.repo, { recursive: true, force: true });
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}

await main();
