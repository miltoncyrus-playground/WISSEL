# Periodic evals

Not run by `bun test` (the gate lane — deterministic, free, <2s per house
rule). These make real `claude` calls, cost real money, and take real
wall-clock time. Run explicitly before ship, and nightly.

| Eval | Command | What it proves |
|---|---|---|
| `eval/readonly.eval.ts` | `bun run eval:readonly` | ReadOnlyExecutor's plan-mode enforcement actually holds against a subprocess that tries to write. |
| `eval/implementer-reviewer.eval.ts` | `bun run eval:implementer-reviewer` | The automatic implementer→reviewer loop (`src/core/orchestrator.ts`'s `finishResult`/`handleReviewVerdict`) converges correctly against a *real* reviewer, not a scripted one. |
| `eval/planner-subtask-plan.eval.ts` | `bun run eval:planner-subtask-plan` | The real planner agent reliably produces a well-formed ```subtask-plan``` block against a vague card, and `finishResult`'s `spawnSubtasksFromPlan` turns it into real child cards with correct `dependsOn` chaining. |
| `eval/pipeline-review-handoff.eval.ts` | `bun run eval:pipeline-review-handoff` | The review-handoff loop recreated as a real `PipelineDef` (`src/core/review-handoff-pipeline.ts`) actually converges through `startPipelineRun` end to end against real `implementer`/`pipeline-reviewer` agents — see docs/SDD-pipelines.md §6 Subtask 5. |

## implementer-reviewer eval

`test/orchestrator-review-lifecycle.test.ts` (gate lane) already proves
the state machine transitions correctly — approve, pushback, escalate —
against a scripted reviewer verdict fed in by hand. What that can't
prove is whether the real reviewer agent produces the *right* verdict
against real implementer output. This eval checks that, end to end, with
no mocks: real `claude -p` calls for both roles, real git worktrees, the
real agent manifest (`agents/manifest.yaml`).

Six fixtures, each in its own throwaway git repo:

- **4 fixable** — two trivial single-function tasks (pass-first-try is
  the expected case) and two with several precise, easy-to-get-subtly-
  wrong acceptance criteria (a real pushback round or two is plausible,
  but always resolvable).
- **1 unfixable** (`contradictory-parity`) — acceptance criteria that
  directly contradict each other (criterion 3 requires
  `isEvenSpecial(7) === false` because 7 is odd; criterion 4 requires
  `isEvenSpecial(7) === true`). No implementation can satisfy both, so a
  reviewer reading the criteria correctly must reject every attempt.

Each fixture is driven through 6 rounds (a round = the pending
implementer attempt running, then its reviewer running — see
`driveRounds` in the gate test for the same pattern). Six is not an eval
knob: it's `handleReviewVerdict`'s own `pushbackCount >= 5` escalation
limit in `src/core/orchestrator.ts` — if that limit ever changes,
`ROUNDS` in the eval script must change with it, and the eval script
comment says so at the point it's used.

### Pass bar

- **Fixable fixtures**: ≥80% must reach `review` or `done` within the 6
  allowed attempts (currently 4 fixtures, so this means at least 4 of
  4 — see the note below on tightening this if the fixture count grows
  and some slack is wanted).
- **Unfixable fixture**: must reach `escalated` with **exactly 6**
  implementer attempts in its lineage — every run, not just on average.
- Both conditions must hold for the eval to pass; the script exits 1 and
  prints a per-fixture PASS/FAIL breakdown (plus total real spend) if
  either fails.

### Status — not yet empirically run

This eval script was written without Bash access in this session (the
implementer task that produced it was scoped read/write-file only), so
**the pass rate above has not been observed against real `claude`
calls**. The fixtures and the 80%/exactly-6 thresholds are a considered
design, not a measured result — the first real run (see the scheduled
command below) is also the first empirical check of whether the
`contradictory-parity` fixture reliably provokes rejection from the real
reviewer model every time, and whether the two "needs 1-2 rounds"
fixable fixtures actually need rounds rather than passing first try
(harmless either way for the pass bar, since both outcomes land in
`review`/`done`). If the first real run shows the unfixable fixture
occasionally getting approved by mistake, or a fixable fixture
oscillating past 6 rounds, that's a real finding about the reviewer
prompt/manifest — file it, don't just loosen the threshold to make the
eval green.

### Scheduling — before ship and nightly

This needs cron/CI config access wissel itself doesn't have. Milton runs
these:

**Cron (nightly, e.g. 2am local), from the repo root:**

```bash
crontab -e
# add:
0 2 * * * cd /path/to/wissel && /usr/bin/env timeout 1800 bun run eval:implementer-reviewer >> ~/.wissel/eval-implementer-reviewer.log 2>&1
```

`timeout 1800` (30 min) bounds a hung `claude` subprocess — the eval
script has no internal timeout of its own, this is the standard,
already-installed tool for it rather than bespoke process-timeout code.
Adjust the path and the cron time to taste.

**Before ship (CI), as a required step on the release/merge workflow:**

```yaml
- name: Periodic eval — implementer/reviewer loop
  run: timeout 1800 bun run eval:implementer-reviewer
```

Needs `claude` authenticated in the CI environment the same way any
other write-tier harness does (see `docs/SDD-execution-harnesses.md`) —
this is real local-Claude-Code usage per the house LLM-access rule, not
a hosted API call, so it needs a real authenticated `claude` CLI
session available to the runner, not just an API key.

## planner-subtask-plan eval

`test/parse-subtask-plan.test.ts` and `test/orchestrator.test.ts` (gate
lane) already prove the parsing and card-spawning logic is correct
against a scripted plan fed in by hand. What that can't prove is whether
the real planner — running in real plan mode, with zero write access —
actually respects the `outputContractFormat: subtask-plan` contract
(`agents/manifest.yaml`) often enough to be useful: does it reliably end
its message with a well-formed `\`\`\`subtask-plan` block, and does its
`dependsOnIndex` chaining hold up against real model output rather than
a hand-written fixture. This eval runs two vague, `whenToUse`-shaped
cards through the real planner and confirms `finishResult` turns the
real response into real child cards on a real board.

### Pass bar

Every fixture must: come back `ok: true` (which already implies
`parseSubtaskPlan` accepted the block), produce at least 2 subtask
items, and — once `finishResult` spawns them — leave the planner task
`done` with exactly that many real child cards, every declared
`dependsOnIndex` resolved to the right sibling's real id. 100% of
fixtures, every run — same "no silently discarded decomposition" bar
this feature exists to guarantee, never loosened to make the eval green.

### Scheduling

Same pattern as `eval:implementer-reviewer` above — add a nightly cron
line and a required CI step for `bun run eval:planner-subtask-plan`,
same `timeout 1800`, same real-authenticated-`claude` requirement.

## pipeline-review-handoff eval

`test/review-handoff-pipeline.test.ts` (gate lane) already proves the
recreated `PipelineDef`'s *shape* is correct — the right number of
implementer/reviewer step pairs, the escalate-only-on-the-6th-rejection
cap, fail-closed on an unresolvable `next` — against a scripted
claude/Anthropic stand-in. What that can't prove is whether the real
`implementer` and `pipeline-reviewer` agents (`agents/manifest.yaml`)
actually converge through `startPipelineRun` end to end: does the
reviewer reliably emit a well-formed `\`\`\`pipeline-handoff` block, does
it correctly read its own step's title to know whether "retry" or
"escalate" is the right choice on the final attempt, and does the whole
graph reach the same terminal outcome the legacy hardcoded loop would for
equivalent input. Two fixtures, reused from `eval:implementer-reviewer`'s
own roster so the two systems are compared against literally the same
inputs:

- **trivial-sum** (fixable) — expected to reach `done` via the
  "approved" terminal step after exactly 1 implementer attempt.
- **contradictory-parity** (unfixable) — expected to reach `done` via the
  "escalated" terminal step after exactly `REVIEW_HANDOFF_PUSHBACK_LIMIT + 1`
  (6) implementer attempts, the same cap `handleReviewVerdict` enforces
  in the legacy loop.

### Pass bar

Both fixtures must land on `done`, each via its own expected terminal
step (`approved`/`escalated`) with the exact expected implementer-attempt
count. Either fixture landing on `failed` instead — a violated
pipeline-handoff contract, an unresolvable `next`, a missing agent — is a
real finding about the recreated pipeline, not something to paper over by
loosening the bar.

### Status — not yet empirically run

Same situation as `eval:implementer-reviewer` when it was first written
(see that eval's own "Status" note above): this script was written
without subprocess-spawn access in this session (the implementer task
that produced it was scoped to file reads/writes and `bun test`/`bun run
typecheck` only — real `claude`/git-worktree calls require approval this
session's sandbox doesn't grant), so **it has not yet actually been run
against real `claude` calls**. The graph and fixtures were traced by hand
against `pipeline-runner.ts`'s real code (see docs/SDD-pipelines.md §6
Subtask 5's comparison section for the full trace), and the gate test
(`test/review-handoff-pipeline.test.ts`) proves the shape end to end with
a scripted stand-in — but the first real run of this eval is also the
first empirical check that `pipeline-reviewer` reliably produces a
well-formed `\`\`\`pipeline-handoff` block against real model output, and
correctly reads its own step's title to choose "retry" vs "escalate" on
the final attempt. Run it (`bun run eval:pipeline-review-handoff`) before
relying on this pipeline for anything real, and update this note with the
actual result once it's been observed.

### Scheduling

Same pattern as the other evals above — add a nightly cron line and a
required CI step for `bun run eval:pipeline-review-handoff`, same
`timeout 1800`, same real-authenticated-`claude` requirement.
