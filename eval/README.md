# Periodic evals

Not run by `bun test` (the gate lane — deterministic, free, <2s per house
rule). These make real `claude` calls, cost real money, and take real
wall-clock time. Run explicitly before ship, and nightly.

| Eval | Command | What it proves |
|---|---|---|
| `eval/readonly.eval.ts` | `bun run eval:readonly` | ReadOnlyExecutor's plan-mode enforcement actually holds against a subprocess that tries to write. |
| `eval/implementer-reviewer.eval.ts` | `bun run eval:implementer-reviewer` | The automatic implementer→reviewer loop (`src/core/orchestrator.ts`'s `finishResult`/`handleReviewVerdict`) converges correctly against a *real* reviewer, not a scripted one. |

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
