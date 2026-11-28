# Review and delivery

How finished work is reviewed and lands: a local merge or a pull request, the review policy (rounds, tiers, carry-forward, keeping a PASS) and what happens to an open PR afterwards.

## Delivery as a pull request

A project's `delivery` setting decides how a finished card lands. Unset,
or `{"mode": "local-merge"}`, merges it into your checkout as before.
`{"mode": "pull-request", "branchPattern": "feat/{key?}-{slug}",
"hostGates": [["bun", "run", "test:e2e"]], "gateRetries": 1, "draft":
true}` turns Merge into delivery:
1. fetch the remote's main branch (`base`, default the card's
   `mergeTarget` or the checked-out branch; `remote`, default `origin`)
   and build the landing commit against it;
2. run the merge gate, then the host gates, re-running a failed command
   once with `gateRetries: 1`;
3. only if all pass, push to the card's own branch and open a PR, or
   reuse the open one.

The PR is recorded on the card. The PR body ends with the card id, the
principal behind it and the policy revision. Your checkout is never
touched and the card's worktree is kept. Pushes are never forced: a
rejected push stops and reports. The branch can never be the main branch
or another long-lived one. PRs are opened with `gh`, as the account it
is signed in as (`src/services/delivery.ts`, `docs/SDD-coordinator.md`
§4.5).

## Review policy

A project's `reviewPolicy` (`{"maxRounds": 2, "blocks": ["HIGH"],
"atCap": "spec-question"}`) shapes its review loop:
- The reviewer's verdict may carry `severity` counts (`high`, `med`,
  `medWithScenario`, `low`). An approval with a severity listed in
  `blocks` becomes a fix round that says why.
- `maxRounds` replaces the default cap of 5. At the cap, `atCap` decides:
  `ask-decider` (the default) and `spec-question` escalate with their
  own note, and `accept` moves the work to review for you to merge.
- When the project has a `fix-round` card template, each fix round's
  whole brief is rendered from it with `{review}` (the full review
  text), `{round}`, `{key}`, `{title}` and `{body}` (the first
  attempt's brief), then the project rules. A review with no text
  refuses the round and escalates (`docs/SDD-coordinator.md` §4.6).
- `tiers` name who reviews:
  `[{"id": "risky", "when": "label:auth", "reviewers": [{"model": "other-than-coder", "mode": "adversarial"}, {"model": "claude-sonnet-5-5"}], "maxRounds": 3}]`.
  - A card's tier is its own `review: {"tier": "risky"}` (set on create
    or edit), else the first tier whose `when` matches (`always`,
    `label:<name>` or `files>=<n>`), else one reviewer as before.
  - Each reviewer gets its own review card, on its model.
    `other-than-coder` takes the first of `otherModels` that isn't the
    coder's model; with none, the review runs on the reviewer's own model
    and its card says so. `adversarial` asks the reviewer to look for how
    the change breaks.
  - With several reviewers, the verdict waits for all of them. It
    approves only if all approve, and a fix round gets every reviewer's
    full text. A tier's `maxRounds` overrides the policy's.
- `carryForward` (`card`, `ticket` or `drop`, the default) says where a
  passing review's non-blocking findings go:
  - `card`: a held follow-up card. It is escalated, so it never starts
    by itself: Retry starts it.
  - `ticket`: a comment on the workstream's ticket, through the gate.
    While tracker writes are off, it becomes the card instead.
- `keepPass` (`["text"]`, `["test"]` or both) decides what happens when
  a PR changes after its review passed. The PR records the head the
  review passed on, and it can only be armed at that head.
  - A merge-forward that merges main in cleanly keeps the PASS.
  - So does one whose conflict resolution touched only the kinds of
    file `keepPass` names (Markdown and `docs/`, or tests).
  - Anything else starts a narrow re-review of what the resolution
    changed. Its PASS lets the PR be armed at the new head, and its
    FAIL starts a fix round on the same branch.
  - `POST /tasks/:id/re-review` starts one by hand. It reviews the
    change since the reviewed head, or the whole PR when nothing has
    changed since.

## The PR watcher and merge-forward

Once a minute the PR watcher looks at every card delivered as a PR,
until the PR is merged or closed. It reads, with `gh pr view` (read-only):
- the checks, and the head commit they ran on;
- whether the PR can merge: clean, dirty, blocked or behind;
- whether auto-merge is armed;
- whether it is merged or closed.

What it sees is kept on the card as `pr.watch`, so the card's life
carries on past done:
- `landed`: the PR is open;
- `ready`: it is the reviewed head on the main branch, every check is
  green and nothing is in the way;
- `merged`, or `closed` without merging.

Each change is logged and recorded as a `pr.changed` telemetry event.
`armBlockedBy` says why the PR may not be armed for auto-merge yet. The
watcher never arms one: that waits for roles (`docs/SDD-coordinator.md`
§4.13). `GET /admin/pr-watch` lists the watched cards, and `POST` looks
again now (`src/services/pr-watcher.ts`, §4.7).

When the watcher sees a PR go dirty (main moved on and now conflicts),
it starts one **Merge forward** card for it, never two. That card
delivers the original card again, merging the freshly fetched main:
- A clean merge is gated and pushed as a fast-forward to the same branch,
  the open PR is reused and the card's PR head moves on.
- A conflict is left in the card's worktree for a conflict integrator
  card. The merge-forward card waits in review, and runs again once the
  integrator has finished.

Every delivery moves the card's branch to what it pushed, so a later fix
round is never a rejected push (`src/services/merge-forward.ts`).

---

[Back to the README](../../README.md)
