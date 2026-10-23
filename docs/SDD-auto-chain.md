# SDD — The review and rework loop runs on its own; everything else waits

Status: **Built.** `WISSEL_AUTO_CHAIN=1`, `OrchestratorOptions.chainOnly`,
`isChainCard`. `test/auto-chain.test.ts`.

## 1. The problem

With `WISSEL_ORCHESTRATOR` off, a human started every card, including the
two that follow each implementer run: its automatic review, and, when the
reviewer asks for changes, the rework. A card going from spec to approval
took three to six manual Runs, each needing the right account pinned.
With the orchestrator on, Wissel starts everything it finds, including
cards a human was not ready to start. There was no setting between them.

## 2. Design

`WISSEL_AUTO_CHAIN=1` starts the orchestrator in **chain-only** mode. Its
sweep still skips what it always skips (a routed, archived or blocked
card, a card waiting on `notBefore` or a rate limit, the concurrency cap
and the daily spend ceiling), and additionally skips every card that is
not in a review lineage:

```
isChainCard(task) = task.reviewLineageId !== undefined && task.pipelineId === undefined
```

A card has a `reviewLineageId` once its first run has produced a review:
the review card carries it, and so does every rework. So the only cards the
chain touches are cards that follow work a human already started by
pressing Run on the first attempt. A fresh card, a planner's subtask or an
integrator waits for a human Run, exactly as with the orchestrator off.

Write-tier reworks run locally, so chain mode adds the write executors to
the automatic pool and runs the chain's cards with `executeWriteTier` on.
The sweep gate is what keeps that from reaching a fresh write-tier card.

With `WISSEL_ORCHESTRATOR=1` also set, nothing changes: the full
orchestrator already routes everything and chain mode is ignored.

### 2.1 What stops it

- The pushback limit (`MAX_PUSHBACKS`): after that many `changes_requested`
  verdicts the card escalates to a human instead of looping.
- `WISSEL_SWEEP_SPEND_CEILING_USD`: no new dispatch once the day's recorded
  cost reaches it.
- `WISSEL_MAX_CONCURRENT_TASKS`.
- `WISSEL_AUTO_MERGE=0` (docs/SDD-merge-target.md): an approved card stops
  in `review` for a human Merge. The chain never merges or pushes.
- A project's `harness` and a card's `mergeTarget` carry onto the chain's
  cards (docs/SDD-project-harness.md), so reviews and reworks stay on the
  account and branch of the card they follow.

## 3. Not here

- No per-project switch: it is process-wide.
- No chain budget of its own: the daily ceiling is the cap.
- The first attempt is never started by the chain.
