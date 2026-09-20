# SDD — Isolated worktrees for local write-tier execution

Status: **Built and verified**, both by unit test (fake `CommandRunner`,
no real git spawned) and by a live smoke test against a real repo
(create → edit → diff → commit → merge → cleanup, full lifecycle, real
`git` — see §6). §4 (autoMerge, an opt-in exception to the review gate)
built and tested the same way — no live smoke test for that one
specifically, since it's the same `mergeTaskWorktree` code path already
covered by §6, just called from a different trigger.

## 1. Why

`WriteExecutor`/`CodexWriteExecutor` used to run their subprocess with
`cwd: task.repo` — editing the task's actual repo directly. When
`task.repo` is wissel's own source (a self-hosted task, e.g. building
the `codex-cli` harness) and the dev server is running under `bun run
--watch`, every file the subprocess edited restarted the very server
tracking it, orphaning the in-flight subprocess mid-run with no result
ever recorded. Confirmed live, not hypothetical — see the `README.md`
warning this doc supersedes with an actual fix, and the incident
recorded in `docs/SDD-codex-cli-harness.md`'s own build history.

The operational guardrail (`bun run serve`, no `--watch`) shipped first
as a stopgap. This is the structural fix: a write-tier task never
touches `task.repo`'s own working tree at all, so nothing it does can
ever restart (or otherwise disturb) whatever process is watching that
tree — self-hosted or not.

## 2. Design

`src/services/worktree.ts`, three functions:

- **`createTaskWorktree(repo, taskId, {runner, homeDir?})`** — `git
  worktree add -b wissel/<taskId> ~/.wissel/worktrees/<taskId> HEAD`.
  Outside any repo directory on purpose, mirroring the existing
  `~/.wissel/board.sqlite` convention — structurally impossible for any
  `--watch`-style tool pointed at a repo to ever see these edits.
  Idempotent: a second call for the same task (a retry via `POST
  /tasks/:id/run`) reuses the existing worktree instead of erroring.
- **`mergeTaskWorktree(repo, worktree, task, runner)`** — commits
  whatever's uncommitted in the worktree (no-op if clean), `git merge
  --no-ff` that branch into whatever's checked out in `repo`, then
  removes the worktree. The *only* place a worktree's changes ever reach
  the live repo — always this one explicit, human-triggered call.
- **`removeTaskWorktree(repo, worktree, runner)`** — discards a
  worktree and its branch without merging.

Deliberately **not committing right after the run** — only at merge
time. This means `GET /tasks/:id/diff` can keep calling the existing
`getRepoDiff(path)` completely unchanged, just pointed at the worktree
path instead of `task.repo` when a result has one: a worktree mid-review
is a plain git working tree with uncommitted edits, exactly the shape
`getRepoDiff` already reads for the non-worktree case. No new diff
logic, no special-casing.

`WriteExecutor`/`CodexWriteExecutor` each: create the worktree, run
their CLI with `cwd` pointed at it (via a shallow-copied `TaskCard` —
`buildAgentPrompt` never reads `task.repo`, confirmed by reading it, so
this is a pure cwd redirect with zero effect on the prompt), attach the
result's `worktree: {path, branch}`. `TaskResult.worktree` is new
(`types.ts`), persisted as a JSON column on `task_results` (`board.ts`,
same pattern as the existing `artifacts` column, with the same
`ALTER TABLE ... ADD COLUMN` healing block for a pre-existing on-disk
DB).

Two new endpoints, `POST /tasks/:id/merge` and `POST /tasks/:id/discard`
(`server.ts`) — both 409 if the task's result has no worktree. Merge
moves the task to `done`; discard moves it to `failed` (closest existing
status for "reviewed, rejected"). `board.html`'s review-gate buttons
(`Mark done`/`Mark failed`) are replaced by `Merge`/`Discard` exactly
when the task's result carries a worktree — otherwise unchanged, so a
dispatched (non-wissel-executed) write-tier task still gets the original
buttons.

## 3. What this deliberately does NOT do

- **Doesn't touch dispatched work.** A task wissel hands off (`status:
  "dispatched"`) never gets a worktree — wissel has no visibility into,
  or control over, how agetor or another external runner executes it.
  Worktrees only cover the two local executors.
- **Doesn't carry over `task.repo`'s own uncommitted changes.** `git
  worktree add ... HEAD` branches from the last *commit*, not the
  working tree state — any of your own in-progress, uncommitted edits in
  `task.repo` are invisible to the worktree. Deliberate: a task's
  worktree should reflect the repo's real history, not leak whatever a
  human happened to have half-written at dispatch time. Confirmed live
  (§6) that this is exactly what happens, not assumed.
- **Doesn't resolve merge conflicts.** `mergeTaskWorktree` reports a
  conflict as a clean `{ok: false, message}` and leaves the worktree
  entirely alone (never removed on failure — confirmed by test) so
  nothing is lost; resolving it by hand and re-merging is still a manual
  step. A merge conflict on the live `task.repo` side (your own
  uncommitted changes colliding with the incoming merge) is refused by
  `git merge` itself, the normal safe default — not specially handled
  here, doesn't need to be.

## 4. `autoMerge` — an opt-in, per-agent exception to the review gate

Added on request: Milton asked whether a card in `review` genuinely
needs a human every time, or could sometimes go straight to `done`. The
review gate itself (§1's whole reason for existing — a human confirms
before a write-tier success is "done", regardless of who ran it) stays
the default. `AgentDef` gains one new optional field:

```ts
autoMerge?: boolean;
```

Both `autoMerge: true` **and** `trustLevel: "high"` are required
together before anything skips review — deliberate, so a manifest typo
or a copy-pasted low-trust entry can't silently bypass the gate by
accident. Enforced in `finishResult` (`orchestrator.ts`), the single
choke point that already decides where every finished task lands,
regardless of whether wissel ran it locally or an external runner
(agetor, a human) reported it back via `POST /tasks/:id/result` — same
policy either way, since the risk being gated (trusting a reported
`ok: true` without a second look) is the same regardless of who
produced it.

Critically, this is never just a status flip. When the result carries a
`worktree`, `finishResult` calls the exact same `mergeTaskWorktree` the
board's own Merge button calls — a real `git merge --no-ff`, not a
shortcut that pretends the merge happened. **A genuine merge conflict
falls back to the normal `review` stop**, not a silently-abandoned
`done` — auto-merge only ever succeeds by actually merging cleanly; any
failure gets the same human attention every other write-tier task gets.
A result with no worktree (e.g. an external report with no local
execution behind it) has nothing to reconcile, so `autoMerge` there
just means "don't stop for review" — the result was never going to
touch a worktree either way.

No agent in `agents/manifest.yaml` opts into this — shipped as pure
mechanism, same as `codex-cli` Phase 1 shipped without a pilot agent.
Picking which agent(s), if any, should get `autoMerge: true` is still
Milton's call, not decided here.

## 5. Known gaps, found while building this

- **Fixed in this same pass**: `TaskResult.actualCost`/`harnessId` were
  silently dropped by `board.recordResult`/`getResult` — found while
  adding the `worktree` column, since it's the same table. The SQLite
  schema only ever had fixed columns for
  `taskId/agentId/ok/summary/artifacts`, so cost/harness attribution
  never made it into `task_results` even though `TaskResult` had carried
  both fields for a while — pre-existing, unrelated to worktree
  isolation itself, but cheap enough (two more columns, same
  `ALTER TABLE` healing pattern) to fix rather than just flag. Telemetry's
  own log had always captured both correctly (`finishResult` records them
  into `telemetry.record(...)` separately), so the original harness
  SDD's spend-aggregation plan was never actually affected — only
  `GET /tasks/:id/result`'s single-task view was under-reporting, now
  fixed. Round-trip covered by a `board.test.ts` case; the board UI's
  result card now shows harness/cost when present.
- **§7.2 of `docs/SDD-codex-cli-harness.md` is still open** — the
  sandbox-inside-a-sandbox risk for Codex's `workspace-write` mode,
  re-verification from wissel's own real (non-nested-sandbox) process.
  Untouched by this change.
- **No cleanup for an abandoned worktree.** A task that's deleted (`DELETE
  /tasks/:id`) or simply never merged/discarded leaves its worktree
  sitting under `~/.wissel/worktrees/` indefinitely. Not harmful (cheap
  disk, no live process), just not automatic — a `wissel gc` style
  command would be the natural fast-follow if this becomes clutter.

## 6. Verified live

Ran the full lifecycle against a real throwaway git repo, not just the
unit tests' fakes: `git worktree add -b wissel/<id> <path> HEAD` →
edited a tracked file and added a new one inside the worktree → `git
diff HEAD` + `git status --porcelain` from inside it showed exactly what
`getRepoDiff` expects → committed and `git merge --no-ff` back into the
original repo → both changes landed correctly → `git worktree remove
--force` + `git branch -D` cleaned up completely (`git worktree list`
back to just the main tree). Also confirmed `git worktree list
--porcelain`'s exact output shape (`worktree <path>` lines) matches
`createTaskWorktree`'s idempotency check.
