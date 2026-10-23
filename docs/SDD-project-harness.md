# SDD — A project names the account its cards run on

Status: **Built.** `Project.harness` (a `POST /projects/:id/settings` key),
`validateNewTask`'s `projectHarnessFor`, and `inheritedPlacement` on every
card Wissel creates itself. `test/project-harness.test.ts`.

## 1. The problem

Each card chose its account with its own `harnessOverride`, or took
whichever enabled harness the pool offered. On a machine with a work and a
personal account that meant pinning every card by hand, and the cards Wissel
creates by itself (a review after each implementer run, a planner's
subtasks, an integrator) were never pinned at all. Four review runs went to
the wrong account that way.

## 2. Design

### 2.1 The setting

`Project.harness` is one more per-project setting, set the same way as the
others: `POST /projects/:id/settings {"harness": "<id>"}`, `null` to clear.
The id must name a harness in the pool, checked when it is set (a typo is a
400, not a card that fails later). It is a nullable JSON text column like
its siblings, added by the existing settings migration; a project with none
set reads back as before.

### 2.2 New cards

`validateNewTask` gets an optional `projectHarnessFor(repo)`. When a card
names a `repo` and no `harnessOverride`, the project's harness fills it in,
and the existing `harnessOverride` checks then run on it. A card's own
`harnessOverride` always wins; a repo with no project, or a project with no
harness, changes nothing. `POST /tasks` and `PATCH /tasks/:id` pass it. A
PATCH that clears a card's harness gets the project's again, since clearing
means "no choice of my own".

Schedule templates and Ask's `create_task` go through `validateNewTask` and
get the default when they pass `projectHarnessFor`; today only the two HTTP
routes do.

### 2.3 Cards Wissel creates itself

`inheritedPlacement(parent)` returns the parent's `harnessOverride` and
`mergeTarget` (docs/SDD-merge-target.md). It is used by `spawnReviewerTask`,
the planner's subtasks, the integrator and the conflict integrator.
Pushback and retry already carried both through `carriedCardSettings`.

## 3. Not here

- A project harness is a default for new cards, not a lock: a card may name
  another enabled harness.
- No per-agent or per-label default.
- A harness that disappears from the pool after it was set is not
  re-checked on the project; the new card fails like any unknown
  `harnessOverride`.
