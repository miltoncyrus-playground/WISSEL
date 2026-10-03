# SDD — crash recovery: picking up where wissel left off after a restart

Status: **Draft, not built.** Written per Milton's ask, following a real
power failure in this session that left two things broken: a task stuck
at `running` forever with nothing driving it forward, and the live repo
sitting mid-merge with real conflict markers, both recovered by hand
(restarting the process, manually resolving the conflict, manually
re-triggering both merges) rather than automatically.

## 1. Goal

Two things, independently useful, in the order they matter:

1. Any task wissel was itself mid-executing when the process stops —
   crash, power loss, or a deliberate restart without checking first —
   is requeued automatically on the next start, not left dead until a
   human notices.
2. A git repo left mid-merge by an interrupted auto-merge attempt is
   **surfaced** loudly the next time wissel starts or runs its periodic
   check, not silently discovered days later via an unrelated disk-change
   notification (how it was actually found this session).

Explicitly **not** a goal: blindly auto-resolving an arbitrary dangling
merge conflict. See §3.2 for why that's a real hazard, not just
conservatism, and §3.3 for where safe auto-recovery can actually live
instead.

## 2. What I looked at

This session's own direct reading of the live codebase and the real
incident itself (not a hypothetical):

- `src/core/orchestrator.ts`: `Orchestrator.sweep()` (line ~693) — its
  eligibility gate `if (task.status !== "inbox" && task.status !==
  "ready") continue;` is exactly why a `"running"` task is never
  reconsidered automatically; `scheduleRetry` (`src/services/board.ts`)
  is the existing precedent for "move back to inbox, clear routedTo" this
  doc's fix reuses rather than inventing a new reset mechanism.
- `HarnessPool`'s `inFlight` map and `Orchestrator`'s own `inFlight` set
  are both confirmed pure in-process state (their own doc comments say so
  explicitly) — meaning **every** task found at `"running"` on a fresh
  process start is unambiguously a crash/restart orphan. There is no
  heuristic or heartbeat needed to tell a legitimate long-runner from a
  dead one: the execution model itself (a task's "run" *is* this
  process's own subprocess call, never a separately-supervised job)
  makes the signal 100% reliable.
- `src/services/worktree.ts`'s `mergeTaskWorktree` (line ~136) — confirmed
  it does **not** call `git merge --abort` on a conflict today; a failed
  merge just returns `{ok: false, message}` and leaves the conflict
  sitting in the working tree on purpose, so whoever resolves it (human
  today) has the real git state to work from rather than having to
  re-trigger the attempt from scratch. This is why §3.2 below concludes
  auto-abort-on-startup is unsafe in general, not just untested — the
  conflicted state is the *intended* resting state while unresolved, not
  an artifact unique to the crash.
- `src/core/archive-scheduler.ts` (`startArchiveScheduler`, line ~76) —
  the existing periodic-check pattern (`setInterval`, an initial
  immediate check, same shape memory-scheduler/model-refresh-scheduler
  already use) this doc's periodic merge-health check copies.
- `src/core/orchestrator.ts`'s `maybeSpawnIntegrator` (line ~533) — the
  existing "auto-create a follow-up task when a specific trigger fires"
  precedent §3.3's safe-auto-recovery mechanism is modeled on.
- The actual incident this session: two genuinely-additive conflicts
  (two subtasks' own revision-callout paragraphs in the same SDD section;
  two independent tests in the same file) — both resolved correctly by
  combining both sides, neither requiring a real judgment call about
  which side was "right." That's the concrete evidence for §3.3's claim
  that an agent resolving *most* real conflicts here is plausible, not
  just hopeful — but also evidence that isn't a universal guarantee (see
  §3.3's own fail-closed design for what happens when it isn't additive).

## 3. Design decisions, stated plainly

**3.1 — Startup reconciliation for orphaned `"running"` tasks: safe,
automatic, no caveats.** On every process start (not gated behind
`WISSEL_ORCHESTRATOR` — this is cleanup, not automation of new work),
before the first `sweep()`: query every task with `status: "running"`
and reset each one via the same mechanism `scheduleRetry` already applies
elsewhere (status back to `"inbox"`, `routedTo` cleared, so the router
reconsiders it fresh rather than silently re-reusing a possibly-stale
routing decision). `"dispatched"` tasks are deliberately **not** touched
— those are handed to an external runner (agetor), not something this
process itself was driving, and wissel has no basis for reclaiming work
it never owned.

**3.2 — Dangling merges: detect and surface loudly, never blind-auto-
resolve.** The tempting fix — "run `git merge --abort` for any repo with
a lingering `.git/MERGE_HEAD` at startup" — was the first design
considered here and is **wrong**, caught before being built, not after:
it assumes the only way a repo ends up mid-merge is wissel's own
interrupted auto-merge attempt. In reality a human could be in the middle
of resolving that exact conflict by hand in their own editor at the
moment wissel happens to restart (a deploy, an unrelated process
supervisor hiccup) — auto-aborting then would destroy real, in-progress
manual work with no way to recover it. This doc corrects that assumption
explicitly rather than quietly dropping it. The safe version: a startup
check (and a periodic one, same interval-scheduler shape as
`archive-scheduler.ts`) that detects a dangling `MERGE_HEAD` per
registered project's repo and surfaces it — a board-visible warning, not
a silent log line nobody reads until they trip over it by accident (how
this session's actual incident was found). Resolution stays a human (or
§3.3's agent) decision, not an automatic one.

**3.3 — Real auto-recovery belongs at the moment of conflict, not at an
arbitrary later startup — because that's the one moment the state is
actually unambiguous.** The instant `tryAutoMerge`/`mergeTaskWorktree`
itself detects a fresh conflict, nothing else has had a chance to touch
it yet — no human could already be mid-manual-resolution, because the
conflict is brand new. That's the safe window §3.2's startup check
isn't. Reusing `maybeSpawnIntegrator`'s existing "auto-create a follow-up
task on a specific trigger" pattern: when a merge conflicts, auto-spawn
an `integrator`-routed follow-up task (real write-tier agent, already
exists, already trusted with `read`/`write`/`bash`) whose job is
specifically to resolve *this* conflict — told explicitly in its own task
body that the common case here is two features additively touching the
same section (confirmed true for both of this session's own real
conflicts) and to combine both sides faithfully, but to **fail loud and
leave the conflict exactly as found** — never guess, never silently drop
one side — the moment it looks like a genuine semantic contradiction
rather than two additions. This doesn't replace a human's ability to
resolve it either; it's a first attempt that either succeeds (same
review gate every other write-tier agent's work already goes through
before landing) or leaves the conflict untouched for a human, same as
today.

**3.4 — Process supervision is explicitly out of this doc's scope.** The
fact nothing restarted `bun run serve` after the reboot is a real gap,
but it's an ops/deployment concern (a systemd user service with
`Restart=always`), not a wissel code change — named here so it isn't
forgotten, not designed further.

## 4. Implementation shape

**`src/core/orchestrator.ts`** (or a new, small
`src/core/crash-recovery.ts` if that reads cleaner — implementer's call,
state which in the summary): a `reconcileOrphanedTasks(board): Promise<number>`
function — queries `board.list({status: "running"})`, calls the same
reset `scheduleRetry` already performs (or a sibling method on `Board` if
`scheduleRetry`'s own signature doesn't fit cleanly — it currently takes
a `retryAfter` timestamp this use case doesn't need; check whether a
bare "reset to inbox, clear routedTo" method already exists elsewhere
before adding a new one). Returns the count reset, logged at startup the
same way every other scheduler reports its own state (see the existing
`memory curation scheduled every Nh`/`auto-archive not started` log line
convention in `src/api/server.ts`'s bootstrap).

**`src/services/merge-health.ts`** (new): `checkDanglingMerges(repos:
string[], runner): Promise<{repo: string; branch: string}[]>` — pure,
deterministic (`git rev-parse --is-inside-work-tree` +
`.git/MERGE_HEAD` existence check per repo, no LLM anywhere in this
file). `repos` sourced from every registered `Project.path`
(`src/services/projects.ts`) plus, for safety, the distinct `repo` values
already seen across the board's own tasks (mirrors `renderRepoOptions`'s
own "projects ∪ task history" union in board.html) — a repo a human is
actively using doesn't stop being worth checking just because it was
never formally registered as a Project.

**`src/core/merge-health-scheduler.ts`** (new, mirrors
`archive-scheduler.ts`'s exact shape): runs the check once immediately at
startup, then on an interval (`WISSEL_MERGE_HEALTH_INTERVAL_HOURS`,
default matching `archive-scheduler`'s own default). A non-empty result
surfaces via a new `GET /merge-health` endpoint and a board.html banner
(a small warning strip, same visual register as the existing
`.harness-strip-empty` "No execution harnesses available" message) —
never a task card by itself; §3.3 is what turns a *fresh* conflict into
an actionable card, this is pure visibility for anything already dangling
when wissel starts (including, honestly, one its own §3.3 integrator
attempt failed to resolve and left behind).

**`src/core/orchestrator.ts`**: `tryAutoMerge`'s existing `if
(!merge.ok)` conflict path gains a new call — `maybeSpawnConflictIntegrator`
(mirrors `maybeSpawnIntegrator`'s own shape: idempotent, checks no
follow-up already exists for this task before creating one), creating an
`integrator`-routed task whose body names the conflicting repo, the
worktree branch, and the specific instruction from §3.3. The existing
fallback (task lands on `review` for a human) is **unchanged** — this is
additive, not a replacement; a human still sees the task either way,
now alongside an integrator's own attempt (successful or not) instead of
a bare conflict.

## 5. What this deliberately does not do

- **No blind auto-abort of a dangling merge, ever, at any trigger.**
  Named explicitly in §3.2 as a considered-and-rejected design, not an
  oversight.
- **No process supervisor / systemd unit.** Real gap, explicitly out of
  scope per §3.4 — ops work, not a code change.
- **No heartbeat/lease mechanism for "is this task's process still
  alive."** Unnecessary per §3.1 and §2's own confirmation — the
  execution model already makes "running at cold start" unambiguous
  without one.
- **No retrying of `"dispatched"` tasks.** Those belong to an external
  runner wissel never owned the execution of; reclaiming them would be
  guessing at state wissel has no visibility into.
- **No guarantee the integrator's conflict-resolution attempt (§3.3)
  succeeds for every conflict.** It's scoped, honestly, to the additive
  case this session's own two real conflicts both happened to be — a
  genuine semantic contradiction between two changes still needs a human,
  by design, and the task correctly still lands on `review` either way.

## 6. Subtasks

### 1. Startup reconciliation for orphaned `"running"` tasks
`reconcileOrphanedTasks`, wired into the bootstrap entrypoint before the
first `sweep()`, a startup log line reporting the count reset.

**Acceptance criteria**
- A board seeded with a task at `status: "running"` (with `routedTo`
  set) gets reset to `"inbox"` with `routedTo` cleared on `createApp`'s
  own startup path — gate test against a real `SqliteBoard`, no server
  process needed.
- A task at `"dispatched"` is completely untouched by the same startup
  path — gate test this explicitly as the regression to avoid.
- `bun run typecheck` and `bun test test/` both green.

### 2. Dangling-merge detection + visibility (not resolution)
`src/services/merge-health.ts`, `src/core/merge-health-scheduler.ts`,
`GET /merge-health`, the board.html warning banner.

**Acceptance criteria**
- A real tmp repo with a deliberately-left `.git/MERGE_HEAD` (seeded via
  a real `git merge` against a conflicting branch, left unresolved —
  same "real git, not a hand-faked fixture" discipline this project's
  git-touching tests already hold) is detected by
  `checkDanglingMerges`; a clean repo with no in-progress merge is not.
- `GET /merge-health` returns the detected set; the board.html banner
  renders it when non-empty, hidden when empty.
- `bun run typecheck` and `bun test test/` both green.

### 3. Auto-spawn an integrator on a fresh merge conflict
`maybeSpawnConflictIntegrator`, wired into `tryAutoMerge`'s existing
conflict path, the integrator task's own body/instructions per §3.3.

**Acceptance criteria**
- A scripted conflict (fake `CommandRunner` returning a real conflict
  exit code) triggers exactly one `integrator`-routed follow-up task,
  idempotently (a second conflict event for the same already-has-a-
  follow-up task creates no duplicate).
- The existing fallback (task lands on `review`) is provably unchanged
  for a result with no worktree, or a worktree whose merge succeeds —
  gate test both as explicit regressions, not just the new conflict path.
- A live smoke test (real git, a real additive two-branch conflict
  shaped like this session's own two real ones) proving the integrator
  agent actually resolves it correctly end to end — the honest proof
  this isn't just plausible-sounding, matching every other "live smoke
  test proves the claimed behavior" precedent in this project's own
  eval suite.

## 7. Sequencing

1 and 2 are fully independent of each other and of 3 — all three can run
in parallel. 3 is the most novel piece (a new agent-dispatch trigger) and
benefits from 1 already landing first only in the sense that a crash
mid-integrator-run should itself get reconciled by subtask 1's own fix —
not a hard dependency, just a nice property to have already in place
before stress-testing 3 for real.

## 8. Verification

Same standard every prior SDD in this project has been held to: gate
tests with real `SqliteBoard`/real tmp git repos where the behavior is
deterministic (subtasks 1 and 2 in full), a live smoke test specifically
for subtask 3's actual conflict-resolution quality, since "the agent
produces a plausible-looking resolution" and "the agent produces a
*correct* one" are different claims and only the second is worth
anything; `bun run typecheck` + `bun test test/` green before any of this
is called done.
