# SDD — Task archiving: move completed work off the board, automatically and by hand

Status: **Draft, not built.** Written per Milton's ask; a card for this exact
scope follows this doc, created but deliberately not started.

## 1. Goal

Three things, stated directly:

1. An archive action that moves a `TaskCard` off the active board — a
   dedicated place it still lives, not a delete.
2. Every task that reaches `done` auto-archives 24 hours after it got there,
   with no human action needed.
3. Archiving a task archives its whole subtree — every card whose
   `parentTaskId` chain leads back to it, however many separate `TaskCard`
   rows that is (a planner's full subtask fan-out, every reviewer pass,
   every pushback re-attempt).

## 2. What I looked at

`src/core/types.ts` (`TaskCard`'s full field set — no existing "when did
this reach a status" timestamp anywhere on the card itself, only
`RoutingDecision.decidedAt` and telemetry's own `at`, neither of which is a
reliable "became done" marker for every path that can produce `done`
— autoMerge's fast path, `resumeAfterApproval`, and a human's `POST
/tasks/:id/merge`/`POST /tasks/:id/result` with `ok:true` on a read-only
agent all reach it differently), `src/services/board.ts`
(`move`/`escalate`/`setSupersededBy` — the three existing precedents for
"atomic status-plus-metadata write, own method, own `BoardEvent`
variant"; `move` at line 333, `escalate` at 369, `setSupersededBy` at
360), `src/core/orchestrator.ts` (`finishResult`'s every path that can
set `status: "done"`, and `wireAutoIntegrator`/`maybeSpawnIntegrator`'s
own board-event-listener pattern — the precedent for "watch for a status
transition, react asynchronously, mirrored by a scheduler for the
time-based half of this feature"), `src/core/memory-scheduler.ts` (the
existing `setInterval`-behind-an-env-var precedent — `startMemoryScheduler`
checks once immediately then on a timer, exactly the shape an
hours-based auto-archive check needs), `src/api/public/board.html`
(`findLineageRoot`, `renderKanban`/`renderStats`/`renderSwimlanes`'s
existing `!t.supersededBy` filtering — the direct precedent for how
`archivedAt` filtering should work: UI-layer exclusion, not a
`Board.list()` behavior change, so nothing that already calls `list()`
for routing/integration logic gets a silently different result set).

## 3. Design decisions, stated plainly (overridable — flagging clearly
   rather than leaving them open, same as the original review-handoff
   SDD's own approach)

**3.1 — `archivedAt` is a field, not a status.** A `done` task that gets
archived is still `done` — archiving is a visibility concern layered on
top, exactly like `supersededBy` already is. `TaskCard.status`'s union
gains nothing new. `dependsOn` blocking logic, routing, sweep
eligibility — none of it changes, since none of it reads `archivedAt`.
An archived task is never deleted and never stops being queryable by
id; only the default board/swimlane views stop showing it.

**3.2 — `doneAt` is new, and is the only reliable trigger source.**
Every path that can set `status: "done"` goes through `Board.move`
(`finishResult`'s three `done` branches, `resumeAfterApproval`,
`server.ts`'s `POST /tasks/:id/merge`) — so `move()` is the one choke
point, matching `escalate()`'s own "atomic status-plus-metadata write"
shape. `move(id, "done")` stamps `doneAt = now` every time it's called
with `status === "done"` (including re-entering `done` after some
hypothetical future re-open — last time in wins, no special-casing).
Every other status leaves `doneAt` untouched.

**3.3 — The 24-hour threshold is fixed, not configurable.** Milton
asked for 24 hours specifically, not a tunable default the way
memory-curator's interval is (that one had no real signal for what
value was right; this one was stated directly). `WISSEL_AUTO_ARCHIVE=1`
turns the *feature* on (off by default, same pattern as every other
opt-in flag); a separate, smaller `WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS`
(default 1) controls how often the scheduler *checks* — operational
knob, not the business rule itself.

**3.4 — Auto-archive only ever evaluates root tasks** (`parentTaskId`
undefined) **for the 24h-since-done trigger; cascading is what reaches
everything else.** A non-root task reaching `done` on its own (e.g. one
subtask of a still-in-progress feature) never independently
auto-archives — only the feature's root does, once *it* has been done
for 24h, and archiving the root cascades to every descendant regardless
of each descendant's own age or even its own status (a child still
sitting at `failed` or `escalated` when its root finally lands on
`done`+24h archives right along with it). Rationale: the alternative —
a child silently vanishing from the board while its still-active
siblings remain — is more confusing than a rare early cascade. This is
the one decision most worth a second look if it turns out to surprise
anyone in practice.

**3.5 — Manual archive works on any task, any status, from either
view.** `POST /tasks/:id/archive` cascades to that task's own subtree
(not necessarily the whole root's tree — archiving a single completed
subtask branch without touching its still-active siblings is a real,
useful case the automatic 24h/root-only rule can't cover). Available
from the task drawer (any status) and from a Swimlane's own header
(archives the whole lane in one click — the natural affordance now that
swimlanes already show a lineage as one unit).

**3.6 — Unarchive is single-task, never cascading.** Restoring
`archivedAt: undefined` on one card doesn't restore its subtree — an
undo should be exactly as explicit as what was clicked, not re-apply
the same magic in reverse. Restoring a whole accidentally-archived
feature means unarchiving the root and, separately, whichever children
are also wanted back (or restoring straight from the Archive tab, which
lists every archived card individually either way).

**3.7 — No new UI concept beyond one more tab.** An "Archive" view,
toggled alongside Board/Swimlanes/New task/Memory — same list of tasks
the board already has, filtered to `archivedAt` truthy instead of
falsy, grouped the same lineage-root way swimlanes already are (so a
whole archived feature still reads as one unit, not a flat pile).

## 4. Implementation shape

**`src/core/types.ts`** — `TaskCard` gains `doneAt?: string` and
`archivedAt?: string`, both ISO timestamps, both following the exact
doc-comment convention every other optional field on this interface
already uses.

**`src/services/board.ts`**:
- `tasks` table gains `doneAt TEXT` and `archivedAt TEXT`, healed via
  the exact `ALTER TABLE ... ADD COLUMN` try/catch pattern every prior
  column addition already uses (see the block starting where
  `parentTaskId`/`pushbackCount`/etc. were healed).
- `move()` stamps `doneAt` on the `status === "done"` branch, per §3.2.
- New `Board` interface methods:
  - `archive(id: string): Promise<TaskCard[]>` — finds every descendant
    of `id` (a parent→children adjacency pass over `list()`'s full
    result, then a DFS/BFS from `id` — the mirror-image traversal of
    `findLineageRoot`'s upward walk, this time downward), stamps
    `archivedAt = now` on `id` and every descendant in one pass, emits
    one `task.archived` `BoardEvent` per card archived (or one event
    carrying the whole list — pick whichever the SSE stream's existing
    consumers handle more simply; `board.html`'s `refetchTasks` pattern
    already just re-pulls the full task list on any event, so a single
    batched event is probably simplest), returns every `TaskCard`
    touched.
  - `unarchive(id: string): Promise<TaskCard>` — clears `archivedAt` on
    exactly that one row, per §3.6.
- New `BoardEvent` variant: `{ type: "task.archived"; tasks: TaskCard[] }`
  (plural — a cascade is one logical event, not N).

**`src/core/archive-scheduler.ts`** (new file, mirrors
`memory-scheduler.ts`'s shape exactly):
- `AUTO_ARCHIVE_AFTER_HOURS = 24` (constant, per §3.3).
- `findArchivableRoots(tasks: TaskCard[], now: Date): TaskCard[]` — pure,
  deterministic (per CLAUDE.md's latent-vs-deterministic rule, same as
  `gatherSessionLessons`/`isMemoryCurationDue`): every task with no
  `parentTaskId`, `status === "done"`, `doneAt` set, no `archivedAt`
  yet, and `now - doneAt >= 24h`.
- `runAutoArchiveTick(board): Promise<TaskCard[]>` — lists tasks, finds
  archivable roots, calls `board.archive(root.id)` for each, returns
  everything actually archived this tick.
- `startArchiveScheduler(opts): { stop(): void }` — `setInterval`
  wrapping `runAutoArchiveTick`, checks once immediately (same
  "don't sit idle for a full interval on a fresh install" reasoning
  `startMemoryScheduler` already documents), gated behind
  `WISSEL_AUTO_ARCHIVE`.

**`src/api/server.ts`**:
- `WISSEL_AUTO_ARCHIVE`/`WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS` bootstrap
  wiring, identical pattern to `WISSEL_MEMORY_CURATION`/
  `WISSEL_MEMORY_INTERVAL_HOURS`.
- `POST /tasks/:id/archive` → `board.archive(id)`, returns the full
  list of cards actually archived.
- `POST /tasks/:id/unarchive` → `board.unarchive(id)`, returns the one
  card.

**`src/api/public/board.html`**:
- `renderKanban`/`renderStats`/`renderSwimlanes` each gain one more
  exclusion alongside their existing `!t.supersededBy` filter:
  `&& !t.archivedAt`. Same pattern, same place, no new concept.
- New "Archive" tab: same view-toggle/panel pattern as Memory/Swimlanes.
  Reuses `renderSwimlanes`' own lineage-grouping logic (extracted into a
  shared helper both views call, parameterized by which predicate
  selects membership — `!archivedAt` for the live views, `archivedAt`
  truthy for this one) so an archived feature still reads as one lane,
  not a flat list. Each card gets an "Unarchive" action; each lane
  header gets nothing extra (unarchiving a whole lane isn't a thing,
  per §3.6 — restore what you actually want back).
- Task drawer gains an "Archive" action, available regardless of
  status (§3.5) — same confirm-dialog pattern the existing
  Discard/Abandon actions already use, since it's a bulk, hard-to-fully-undo
  action once a real cascade is involved.
- Swimlane header gains its own "Archive this lane" action, calling the
  same endpoint on the lane's root card.

## 5. What this deliberately does not do

- **No retention/expiry beyond archiving.** An archived card stays in
  the database forever unless someone deletes it through the existing
  `DELETE /tasks/:id` endpoint — archiving and deleting stay two
  separate, already-distinct actions.
- **No auto-archive for `failed`/`escalated`/`no-match`.** Milton's ask
  was specifically "done items" — every other terminal status is out of
  scope here. Worth a follow-up if it turns out to matter in practice,
  not assumed now.
- **No change to routing, `dependsOn` blocking, or sweep eligibility.**
  Confirmed in §3.1 — `archivedAt` is invisible to every piece of logic
  that isn't the board UI's own rendering.

## 6. Subtasks

### 1. Data model: `doneAt`/`archivedAt` fields + migration
`TaskCard.doneAt`/`archivedAt` (types.ts), schema + heal-on-open
migration (board.ts), `move()` stamping `doneAt` on the done transition.

**Acceptance criteria**
- Round-trip test: `move(id, "done")` sets `doneAt`; moving to any other
  status leaves it untouched; moving to `done` a second time refreshes
  it.
- Heal-on-open test: a pre-existing on-disk DB from before these
  columns existed opens and writes both fields cleanly (mirrors every
  prior column-addition test in `test/board.test.ts`).

### 2. `Board.archive`/`Board.unarchive` + cascade traversal
The downward parent→children traversal, the atomic multi-row
`archivedAt` write, the single batched `task.archived` `BoardEvent`,
`unarchive`'s single-row clear.

**Acceptance criteria**
- A 3-generation lineage (implementer → reviewer → pushback re-attempt
  → its own reviewer) archived from the root: all 4 rows get
  `archivedAt` set in one call, one event fires.
- Archiving a non-root subtask only touches its own subtree — siblings
  and the root stay untouched.
- A task with no descendants archives as a 1-element result — no
  special-casing needed for the common case.
- `unarchive` clears exactly one row even when called on a task whose
  whole tree was previously archived together.
- `archive`/`unarchive` on an unknown id throws clearly, matching every
  other `Board` method's existing contract.

### 3. Auto-archive scheduler
`archive-scheduler.ts`'s pure `findArchivableRoots`, `runAutoArchiveTick`,
`startArchiveScheduler`; `WISSEL_AUTO_ARCHIVE`/
`WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS` bootstrap wiring.

**Acceptance criteria**
- `findArchivableRoots`: a done root exactly at the 24h boundary is
  included; one hour short is excluded; a non-root done task is never
  included regardless of age; an already-archived root is never
  included twice.
- Integration test: a real done root + a 2-card subtree, `doneAt` set
  25h in the past — one scheduler tick archives all 3 rows.
- Off by default: `startArchiveScheduler` never called unless
  `WISSEL_AUTO_ARCHIVE=1`, matching every other opt-in flag's existing
  test coverage shape.

### 4. API endpoints
`POST /tasks/:id/archive`, `POST /tasks/:id/unarchive`.

**Acceptance criteria**
- `archive` returns every card actually touched (the cascade), with
  correct status codes for an unknown id.
- `unarchive` returns the single restored card.
- Both emit the real `BoardEvent`s a live SSE listener would see —
  verified the same way existing endpoint tests already check event
  emission, not just the HTTP response.

### 5. Board UI: filtering, Archive tab, drawer/lane actions
`renderKanban`/`renderStats`/`renderSwimlanes`'s new `!archivedAt`
exclusion; the new Archive tab (reusing swimlane-style lineage
grouping); the drawer's "Archive" action; the swimlane header's
"Archive this lane" action.

**Acceptance criteria**
- e2e: an archived task disappears from Board and Swimlanes (kanban
  card count, stat tile, and swimlane membership all agree), and
  appears in the new Archive tab, grouped by lineage the same way
  Swimlanes already groups live tasks.
- e2e: archiving a lane from its Swimlanes header cascades to every
  card in that lane, confirmed via the Archive tab afterward.
- e2e: unarchiving one card from the Archive tab brings back exactly
  that one card to Board/Swimlanes, not its former lane-mates.
- Manual browser verification (per house UI-testing rule) with a real
  screenshot of the Archive tab against real board data, same standard
  Swimlanes/Memory were held to.

## 7. Sequencing

1 and 2 are sequential (2 needs the fields from 1). 3 and 4 both depend
on 2 but are independent of each other — parallel-safe. 5 depends on 4
(needs the real endpoints) but its filtering-only half (excluding
`archivedAt` from the three existing render functions) could land
earlier, right after 1, if useful to ship the visual half before the
full feature — not required, just an option if it speeds up landing
something visible sooner.

## 8. Verification

Same standard every subtask in this project has been held to: gate
tests for every pure function (`findArchivableRoots`, the cascade
traversal) with no real file I/O or process spawn, integration tests
against real SQLite fixtures for `Board.archive`/`unarchive` and the
scheduler tick, e2e tests against a real browser for the UI half, and
independent verification (`bun run typecheck` + `bun test test/`
green) before this is considered done — not just "the implementer said
so."
