# Proposal: agent run efficiency (not built yet)

Status: proposed 2026-10-11, waiting for Milton to pick what to build.
Source: the six "Wissel app" cards (docs/SDD-wissel-app.md), measured
from `~/.wissel/board.sqlite` (each card's review lineage) and the
`dispatch`/`result` events in `~/.wissel/telemetry.jsonl`.

## What happened

The six cards took 15.4 h wall clock (2026-10-10 20:43 to 2026-10-11
12:06 UTC). Agents were busy 2.7 h. About 12.3 h was waiting for the
usage window to reset after three 429s. Waiting, not slow agents or
serial order, set the wall clock.

| Card | Cost | Agent time | Waiting for limit reset | Review rounds |
|---|---|---|---|---|
| 1 shell/look | $9.28 | 0.4h | 0 | 6 (missing permissions) |
| 2 feed | $9.01 | 0.4h | ~3.8h | 1 |
| 3 audio | $7.26 | 0.3h | 0 | 1 |
| 4 Ask | $14.86 | 0.6h | ~4.3h | 1 |
| 5 voice | $12.44 | 0.5h | ~4.2h | 6 (missing permissions) |
| 6 characters | $9.12 | 0.5h | 0 | 1 |
| **Total** | **$61.96** | **2.7h** | **~12.3h** | |

Implementer $54.30 (88%, all Opus 5.5), reviewer $7.66 (12%).

## Findings, biggest first

1. **Runs cut off by the usage limit start over: $11.38 wasted.**
   Card 4 spent $5.97, hit the limit, waited 4.3 h, then spent $8.16
   again from scratch; card 2 lost $5.18 the same way. The retry starts
   a new `claude -p` session, so the agent's reasoning and reads are
   lost.
2. **Nothing paces work against the usage window.** The chain started
   each card as soon as the last merged, until the account hit its
   limit; the window resets every 5 h. The same account also runs this
   interactive session and the 06:00 podcasts. The spend guard can't
   help: implementer cards are estimated at $0.60
   (`costProfile.estUsdPerTask`) and actually cost $7 to $15.
3. **Permission loops: about $9 and 10 extra cards.** Cards 1 and 5 ran
   6 review rounds each because the implementer was refused a command
   (install/build, then `scripts/make-stt-fixtures.ts`). From round 2
   the reviewer named the missing grant; the loop still ran to the cap.
4. **No token breakdown.** Telemetry records only `actualCost` per run:
   no input, cache-read, cache-write or output tokens, no turn count. So
   we can't tell how much goes to re-reading the SDD and exploring the
   codebase on each card.
5. **Implementer model (Milton's call).** Every card ran on Opus 5.5 per
   the "best model by default" rule. Well-specified UI cards (2, 3, 6)
   might do fine on Sonnet 5.5. That is a deliberate downgrade, so it
   needs Milton's decision, and only after item 4 shows the cost split.

## Recommended work, in order

1. **Log the token breakdown per run.** Read `usage` (input,
   cache_read, cache_creation, output) and `num_turns` from the
   `claude -p` JSON result in `src/executors/claude-cli.ts`, store them
   on the result and in telemetry. Free, small, and it decides whether
   item 5 and context changes are worth doing.
2. **Resume a cut-off session instead of restarting.** Keep the
   `session_id` of a run that ended in a 429 and, on retry, run
   `claude --resume <session_id>` in the same worktree. Expected to
   recover about 18% of spend on a run like this one.
3. **Escalate permission gaps with grant-and-retry.** When the reviewer
   asks for a change that needs a command the implementer was refused
   (`TaskResult.permissionDenials`), escalate after that round with a
   one-click "grant and retry" (POST /tasks/:id/allowed-tools exists)
   instead of pushing back again. Optionally let a card declare the
   commands it needs and check them before dispatch.
4. **Calibrate estimates and pace against the window.** Set
   `estUsdPerTask` from telemetry history per agent, then don't start a
   big card when the window is nearly used up: hold it until just after
   the reset (the reset time is already parsed from the 429).

Rough expectation for a run like this one, not measured: items 2 to 4
cut cost by about a third and wall clock to well under half.

## Not worth doing

- **Running cards in parallel.** The usage limit is the bottleneck;
  parallel cards hit it sooner and lose more partial runs.
- **Making the reviewer cheaper.** 12% of cost, and it caught real bugs.
- **Fewer, bigger cards.** Saves some exploration but raises the odds a
  card is cut by the limit, the most expensive failure here.

## When picking this up

Build these as wissel cards only when there is usage headroom: a card
starts as soon as it is created. Item 1 first; check its numbers before
deciding item 5.
