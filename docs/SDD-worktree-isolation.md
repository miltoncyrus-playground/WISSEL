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
- **`mergeTaskWorktree(repo, worktree, task, context, onLanded?)`** —
  commits whatever's uncommitted in the worktree (no-op if clean), then
  the merge path in §7: the repo's HEAD merged into the branch in the
  worktree, the project's gate run there, a fast-forward of `repo`, the
  landed sha recorded, the worktree removed. The *only* place a
  worktree's changes ever reach the live repo. (Before 2026-10-17 this
  ran `git merge --no-ff <branch>` in `repo` itself; §7 says why not.)
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
- **Doesn't resolve merge conflicts itself.** `mergeTaskWorktree`
  reports a conflict as `{ok: false, outcome: "conflict"}` and leaves it
  in the worktree (never removed on failure), where the auto-spawned
  integrator or a human resolves it; see §7. Your own uncommitted
  changes in `task.repo` colliding with the landing are reported as
  `blocked-local-changes` with the file list, never merged around and
  never touched.

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
board's own Merge button calls — the real merge path (§7), gate
included, not a shortcut that pretends the merge happened. A gate
failure goes back as a pushback (§7.3). **A genuine merge conflict
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

## 7. Merge path (2026-10-17)

Ideas from Anthropic's Scion write-up
(https://www.anthropic.com/engineering/redesigning-source-control):
test after the merge, not before it; never merge in the client's copy;
read merge status from the system of record, not the commit log.

### 7.1 What was wrong

- `git merge --no-ff <branch>` ran with `cwd = task.repo`: the user's
  own checkout, usually with uncommitted edits in it. A conflict left
  `MERGE_HEAD` there for a human to clean up.
- Nothing ran the code before it landed. The reviewer (read-only, no
  Bash) was the only check.
- The orchestrator's auto-merge and the board's Merge button could merge
  into one repo at the same moment. A `.git/index.lock` collision read as
  a merge failure and could spawn an integrator for a conflict that
  didn't exist.
- "Did this land?" was answered by `git log --all --grep` for the merge
  message, `unknown` otherwise. A crash between the merge and
  `board.move` stranded card bf6fe7fe in `pending-review` (2026-10-05).

### 7.2 The flow

`mergeTaskWorktree` (`src/services/worktree.ts`), every caller: the
Merge button (`board-actions.ts` `mergeTask`), Ask's merge
(`concierge-control.ts`), the auto-merge (`orchestrator.ts`
`tryAutoMerge`). All of it under the repo's lock (§7.4).

1. Refuse a worktree with an unfinished merge (`MERGE_HEAD` in the
   worktree): committing it would commit conflict markers.
2. Commit the worktree's uncommitted changes, as before.
3. `base` = the repo's HEAD, `tip` = the branch.
   - `tip` already in `base`: nothing to land. Recorded as landed at
     `base`, gate `skipped`.
   - `base` in `tip` (main hasn't moved): the merged tree is `tip`'s.
   - Otherwise `git merge-tree --write-tree base tip` computes it in the
     object store, no working tree touched. A conflict there is redone as
     a real `git merge --no-ff -m "Merge <branch>: <title>" base` in the
     worktree, on the branch, and the result is `conflict`: the integrator
     (or a human) resolves it there and runs `git commit --no-edit`, which
     makes that commit the landing commit; the next Merge lands it as is.
4. The landing commit: `git commit-tree <tree> -p base -p tip -m
   "Merge <branch>: <title>"`. Same parents, same order, same subject as
   the old `git merge --no-ff` in the repo made, so `git log
   --first-parent` and every counter of `Merge wissel/` commits (digest,
   streaks, Wrapped) read exactly as before
   (`test/merge-history-counts.test.ts` builds one history both ways and
   compares).
5. The gate: the worktree is checked out at the landing commit
   (detached), `linkNodeModules` links the repo's `node_modules` and each
   top-level package's (`app/`, `pipeline-editor/`), and the project's
   gate commands run there in order (`src/services/merge-gate.ts`). Then
   the worktree goes back onto its branch, pass or fail. The branch
   itself never moves, so a failed attempt leaves nothing behind for the
   pushback attempt to trip over.
6. Land: HEAD must still be `base`. If a human committed meanwhile, go
   back to step 3 once with the new HEAD (re-merge, re-gate); a second
   miss is `head-moved`. Uncommitted files in the repo that the landing
   changes (`git status -z` against `git diff --name-only base landing`,
   untracked included) make it `blocked-local-changes`, listed by name.
   Then `git merge --ff-only <landing>`. The only write to the user's
   checkout in the whole path is that fast-forward, which git refuses
   rather than overwrite a local edit.
7. `onLanded(sha)`: the caller's `board.recordMerge(id, sha)`, before
   cleanup (§7.5). Then `removeTaskWorktree`.

Never anywhere: `merge --abort`, `reset`, `checkout -f`, `stash`.

| Outcome | Repo touched | Card | Integrator |
|---|---|---|---|
| `landed` | fast-forwarded | `done` | no |
| `gate-failed` | no | pushback attempt, or `escalated` at the cap | no |
| `conflict` | no (conflict in the worktree) | `review` | one, idempotent |
| `blocked-local-changes` | no | `review` | no |
| `head-moved` | no | `review` | no |
| `error` | no | `review` | no |

### 7.3 The gate

`Project.mergeGate`: argv arrays, run in order, first failure stops;
`mergeGateTimeoutMs` per command, default 10 minutes; a timeout kills the
command's whole process group and counts as a failure. Set with `POST
/projects/:id/merge-gate`, read per merge. The migration that adds the
column seeds every registered wissel checkout (its `package.json` says
`"name": "wissel"`) with `[["bun","run","typecheck"],["bun","run","test"]]`,
once; `addLocalProject`/`addGithubProject` seed a new one the same way.
No gate: lands as before, `gate: "none"` on the telemetry event. A gate
lookup that throws refuses the merge; it never lands ungated by accident.

A failure goes back through the existing pushback loop
(`pushBackGateFailure`, `orchestrator.ts`): same lineage, same worktree,
`pushbackCount` + 1, the same `MAX_PUSHBACKS` (5) cap the reviewer loop
uses, escalation at the cap. The new attempt's body gets a `Merge gate
feedback (attempt N)` section: the command, its exit code or timeout,
and the last 200 lines of its output. It hangs off the attempt's
reviewer card when there is one, so it routes exactly as a reviewer
pushback would.

### 7.4 The lock

`withRepoLock(repo, fn)` (`src/services/repo-lock.ts`): one promise
chain per resolved repo path, in-process, held from step 1 to cleanup.
Every merge caller goes through `mergeTaskWorktree`, so every merge
takes it. The `merge` telemetry event carries `lockWaitMs` and
`lockHoldMs`.

### 7.5 The recorded sha

`task_results.mergedSha` / `mergedAt`, written by `Board.recordMerge` in
one UPDATE on the latest result row. `determineWorktreeMergeState` checks
it first (`git merge-base --is-ancestor <sha> HEAD`); the commit-log grep
remains only for rows from before the column (marked legacy in the
code). Startup reconciliation `reconcileLandedMerges`
(`crash-recovery.ts`) moves a `pending-review` or `review` card whose
`mergedSha` is in HEAD to `done`; see docs/SDD-crash-recovery.md §11.

### 7.6 Trace

One `merge` telemetry event per attempt: `taskId`, `repo`, `branch`,
`outcome`, `gate` (`none|passed|failed|skipped`), `gateRuns` (argv, exit
code, duration, timedOut), `gateMs`, `lockWaitMs`, `lockHoldMs`,
`landedSha`, `blockedFiles`, `message` (misses only, 500 chars). The
digest counts them as `stats.mergeAttempts` by outcome. What to watch:
`gateFailed / total` (the gate's catch rate), `conflict` that wasn't a
real conflict (should be 0; an index.lock collision can no longer be
one), cards left in `pending-review` with a `mergedSha` (should be 0
after a start).

### 7.7 Known limits

- After an integrator resolves a conflict in the worktree, the original
  card still needs a Merge (button or Ask). Nothing re-merges it
  automatically.
- If a resolved conflict sits while HEAD moves again, the next landing
  wraps it in a second `Merge wissel/<id>` commit; the digest counts that
  card twice. Rare (a conflict, then more commits before the re-merge).
- The lock is in-process. A second wissel server on the same repo, or a
  human's own `git` at the same moment, can still race the fast-forward;
  that shows as `head-moved` (retried once) or `error`, never as a
  conflict.
- The gate runs in the server process's environment with the repo's own
  `node_modules`. A repo whose gate needs more setup than that (a
  database, a build step) has to say so in its gate commands, or in the
  project's worktree setup (§8), which runs before the agent and so
  before the gate.

## 8. Per-project worktree setup (2026-10-19)

### 8.1 Why

A new worktree gets the repo's `node_modules` symlinked
(`linkNodeModules`) and nothing else. That is enough for a Bun repo. A
Python repo (finn-platform: uv, FastAPI, pytest) has no `.venv` in a
fresh checkout, so every implementer would spend its first turns on
`uv sync`, or fail its verification contract without saying why.
Outcome: a card on such a repo starts with its dependencies installed,
and a broken install fails the card in seconds with the installer's own
output instead of the agent burning turns on it.

### 8.2 The flow

`Project.worktreeSetup` (argv arrays, set with `POST
/projects/:id/settings`, docs/SDD-project-settings.md) is looked up per
run by `ProjectStore.worktreeSetupFor(repo)` (same path matching as
`mergeGateFor`) and passed by WriteExecutor and CodexWriteExecutor to
`createTaskWorktree` as `opts.setup`. After `git worktree add` and
`linkNodeModules`, `runWorktreeSetup` (`src/services/worktree.ts`):

1. Finds the worktree's own git dir from its `.git` file (`gitdir:
   <repo>/.git/worktrees/<key>`). Never part of the checkout, so nothing
   written there is tracked, diffed or merged.
2. Skips if `.wissel-setup-done` is there.
3. Writes `.wissel-setup-pending`, then runs each command in order in
   the worktree with `runGateCommand` (the merge gate's spawner: own
   process group, `WISSEL_*` env stripped, killed on timeout, tracked
   for shutdown). Per-command timeout `DEFAULT_GATE_TIMEOUT_MS`, 10
   minutes.
4. First failure or timeout stops. The result is `{ error }`: the
   command, its exit code or timeout, and the last 200 lines of its
   output. The executor returns it as a failed result before the agent
   starts, so it is the card's summary and the card goes to `failed`.
5. All passed: writes `.wissel-setup-done`, removes the pending marker.

### 8.3 Once per worktree

Reviewer, fixer, integrator and retry runs reuse the worktree
(`createTaskWorktree`'s early return) and pay nothing. The one
exception: a reused worktree that still has `.wissel-setup-pending` and
no done marker never finished setup (it failed, or the server died
mid-command), so setup runs again there. Without that, retrying a card
whose `uv sync` failed would start the agent with no `.venv`. A
worktree created before setup was configured has neither marker and is
left alone.

### 8.4 Trust

Setup runs in wissel's own process, outside the agent sandbox, with the
server's network. It comes only from the project row in the board DB,
which a human sets; no card field, card body or worktree file feeds it.

### 8.5 Trace

One log line per worktree: `worktree setup: <path>: N command(s)
passed in Xs`, or `` `<cmd>` exited N `` / `timed out after Ns` on
failure, plus the failure text on the card. No telemetry event yet.

### 8.6 Known limits

- Editing `worktreeSetup` doesn't re-run it in worktrees already marked
  done; only new worktrees see the change.
- A worktree whose `.git` can't be read gets setup on every run (no
  marker to write). Every `git worktree add` writes one, so this only
  happens to a hand-built directory.
- Setup has no network allowlist of its own: it has whatever the server
  has. The agent sandbox's domain list doesn't apply.

### 8.7 Tests

`test/worktree-setup.test.ts` (gate, no network): order and cwd,
default and configured timeout, stop at first failure with the output
tail, timeout text, skip on reuse, re-run after a failed setup then
skip once done, skip when unset or empty, setup after `node_modules`
linking, done-marker skip, `.git` file/dir parsing, a real-git run
checking the marker stays out of `git status`, both executors, the
error reaching the card through `finishResult`, and
`ProjectStore.worktreeSetupFor`. No eval: no LLM step.
