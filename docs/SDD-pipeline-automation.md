# SDD — Autonomous pipeline operation: sweep loop, self-verification, failure recovery, spend guard

Status: **Not built — proposed.** Written from a live retro of the review-handoff
pipeline's first real end-to-end run (subtasks A–H,
`docs/SDD-review-handoff.md`'s own feature, this session). Every claim below is
sourced from actual task results, telemetry, and file:line reads taken during
that run — not hypothetical.

## 1. Why

Delivering A–H required 7 manual `POST /tasks/:id/run` calls on auto-created
reviewer follow-ups that should have dispatched themselves, 2 manual retries of
`POST /tasks/:id/merge` on a flaky empty-first-response, 2 manual retries after
real 429 session-limit hits, and one manually-found-and-filed cross-subtask
integration bug (Subtask H) that neither subtask's reviewer could have caught
structurally. Every one of these is mechanical — not judgment — and CLAUDE.md is
explicit that mechanical, same-input-same-output work belongs in deterministic
space, not in a human (or an LLM) babysitting a queue.

Real spend: telemetry.jsonl records $25.91 across 31 successful runs for this
feature. That undercounts actual spend — two of the real 429 failures this
session (subtask C's first attempt, and Subtask G's reviewer's first attempt)
were billed ($2.37, and $0.26+$0.14 respectively) but logged with no
`actualCost` at all, because `fail()` never captures it. Real spend for this one
feature is at least $28.5, and the gap is systemic, not a one-off.

## 2. Findings — root causes, one per file:line

**2.1 — The automation already exists and was never turned on.**
`Orchestrator.start()` (`src/core/orchestrator.ts:326-329`) wires an
event-driven sweep — `this.board.events.on("event", () => void this.sweep())`
— that reruns `sweep()` (`orchestrator.ts:335-356`) on every board mutation,
including the `board.create()` call `spawnReviewerTask` makes. `sweep()` picks
up any `inbox`/`ready` task with no `routedTo` and an unblocked `dependsOn`,
and for a `readonly`-tier agent (which `reviewer` is), dispatches it
immediately — no `executeWriteTier` gate applies (`orchestrator.ts:424`,
`runsHere = agent.tier !== "write" || ...`). This is gated behind
`WISSEL_ORCHESTRATOR=1` (`server.ts:425`, `server.ts:108`), which was unset on
this session's dev server. Every one of the 7 manual reviewer-dispatch calls
this session would have been unnecessary had that one env var been set.
Write-tier auto-execution (implementer running without a human clicking "Run")
is a second, separate gate — `WISSEL_EXECUTE_WRITE_TIER=1`
(`server.ts:426`) — also unset. **This is a config change, not new code** —
but see 2.6 before flipping it.

**2.2 — Implementer never self-verifies before declaring done.**
`agents/manifest.yaml:122` declares `implementer.toolAccess: [read, write,
bash]`, but every implementer result this session states some form of "no
Bash access under this permission mode — write files only." Root cause:
`WriteExecutor` runs `claude` with `--permission-mode acceptEdits`
(`src/executors/write.ts:74`), which auto-approves file Write/Edit but not
Bash — a headless run with no human to answer the approval prompt gets denied
by default. Implementer therefore ships code it has never compiled or run.
Reviewer becomes the first real check, and my own independent worktree
verification (symlink `node_modules`, `tsc --noEmit`, `bun test`) becomes a
mandatory *third* pass on every single subtask, even ones the automatic
pipeline was supposed to fully own.

**2.3 — A 429 is terminal, never retried.**
`claude-cli.ts:100-102`: any non-zero exit goes straight to `fail()`
(`claude-cli.ts:152-154`) using raw `stderr || stdout` as the summary — no
attempt to parse the JSON that's actually in `stdout` for a 429. A real 429's
`result` field is a fully structured string:
`"You've hit your session limit · resets 3:10pm (UTC)"`, paired with
`api_error_status: 429`. Both hits this session (subtask C's first attempt;
Subtask G's reviewer's first attempt) required a human to notice the task
stuck at `pending-review`, fetch `/result`, read the error text, check a
clock, and manually re-run.

**2.4 — actualCost, and therefore real spend, is dropped on every failure.**
`claude-cli.ts:142` sets `actualCost: parsed.total_cost_usd` only in the
success path, after the `exitCode !== 0` early return at line 100-102 has
already exited. `fail()` (line 152-154) never sets it. `finishResult`
(`orchestrator.ts:45`) logs every result to telemetry regardless of `ok` —
confirmed directly in `~/.wissel/telemetry.jsonl`, where both 429 failures
from this session produced a `"result"` row with no `actualCost` key at all,
while the real charge ($0.26, $0.14) is visible only inside the raw error
text nobody queries. Telemetry-based spend tracking is silently wrong by
exactly the amount of every failed run, always in the direction of
under-reporting.

**2.5 — No automatic cross-subtask integration check.**
`agents/manifest.yaml` already declares an `integrator` agent
(`agents/manifest.yaml:150`, `toolAccess: [read, write, bash]`), but nothing
in the auto-handoff pipeline (`finishResult`, `spawnReviewerTask`,
`handleReviewVerdict`) ever dispatches it. Subtask D's reviewer never touched
`board.html`; Subtask E's reviewer explicitly deferred integration
verification "until Subtask D lands." Both landed, and nothing re-checked the
pair — the escalation-button request-body mismatch (Subtask H) was found only
because I manually diffed both worktrees by hand after both were already
merged.

**2.6 — Nothing caps concurrent spend.**
Flipping 2.1's env vars on with no other change would let `sweep()` fire every
unblocked task at once, every time — for a credit-limited account, that turns
"a pipeline that needs babysitting" into "a pipeline that can burn the whole
budget in one sweep with nobody watching." This has to ship alongside 2.1, not
after it.

## 3. Design

### 3.1 Turn on autonomous dispatch, gated by a concurrency + spend cap (3.6)
Set `WISSEL_ORCHESTRATOR=1` and `WISSEL_EXECUTE_WRITE_TIER=1` on the dev
server's launch command — but only once 3.6 ships. No orchestrator code
changes needed beyond what 3.6 adds; this is deploy config, documented in
`README.md`'s existing harness/env-var table.

### 3.2 429 detection + auto-reschedule
In `runClaude` (`claude-cli.ts`), before the blind `fail()` at line 100-102,
attempt `JSON.parse(stdout)` even on non-zero exit. If it parses and
`api_error_status === 429`, extract the reset time from `result` (format is
fixed: `"resets H:MMam/pm (UTC)"` — a small deterministic parser, tested
against exact fixture strings, not a regex guess) and return a new
`TaskResult` shape carrying `retryAfter: <ISO timestamp>` instead of a bare
`ok: false`. `finishResult` (`orchestrator.ts`) checks for `retryAfter`
before the existing `if (!result.ok)` branch (line 49-52): instead of moving
the task to `failed`, it leaves status untouched and calls a new
`scheduleRetry(board, task, retryAfter)` that re-marks the task `inbox` at
(or after) that timestamp — reusing the existing worktree via
`reviewLineageId`, same as a pushback re-attempt. A malformed/unparseable
reset string falls back to today's plain `failed` — never silently retries
forever.

### 3.3 actualCost and full result data always captured
Move the `JSON.parse(stdout)` attempt in `runClaude` ahead of the
`exitCode !== 0` check (needed for 3.2 anyway) so `actualCost` is extracted
whenever the JSON is parseable, success or failure. `fail()`
(`claude-cli.ts:152-154`) gains an optional `actualCost` parameter, passed
through wherever a caller has already parsed it. `TelemetryLog` needs no
schema change — `actualCost?: number` already exists
(`src/services/telemetry.ts:6`) — the fix is entirely in ensuring it's
populated before the record call.

### 3.4 Implementer self-verification allowlist
`WriteExecutor`/`CodexWriteExecutor` gain a narrow, explicit
`--allowedTools "Bash(bun test:*)" "Bash(bun run typecheck:*)"` (exact flag
per whatever the installed `claude` CLI version supports — verify before
building) on top of the existing `--permission-mode acceptEdits`, scoped to
nothing else, cwd-locked to the task's own worktree by construction (the
subprocess never runs anywhere else). The `implementer` (and any future
write-tier agent) prompt gets an explicit instruction: run `bun run
typecheck` and `bun test test/` before finishing, fix what fails, and only
report done once both pass — mirroring the "test before shipping" house
rule directly in the agent's own contract, not just in the human process
around it. This is the single highest-leverage fix in this doc: it collapses
most pushback rounds into the same turn, and demotes my own independent
worktree verification from a full re-run to a spot-check.

### 3.5 Auto-integrator on subtask-set completion
When a planner task's own status query shows every child (`parentTaskId` ==
planner task, per the existing dependsOn graph) at `done`, auto-create an
`integrator` follow-up scoped to the *parent* task (not any one subtask) —
full test suite, plus a deterministic cross-file contract check for the
common failure shape this session actually hit: every `fetch(...)` call's
request body shape grepped against its target endpoint's declared required
fields. Lands as a new orchestrator hook alongside `spawnReviewerTask`, not
inside it — a per-subtask reviewer and a per-feature integrator are different
scopes and should stay two agents, not one overloaded one.

### 3.6 Concurrency + spend guard for autonomous sweep
`sweep()` (`orchestrator.ts:335-356`) gains two caps, both configurable via
env var with conservative defaults (`WISSEL_MAX_CONCURRENT_TASKS`, default 2;
`WISSEL_SWEEP_SPEND_CEILING_USD`, default unset/unlimited until Milton picks a
number): before adding a task to `pending`, check `this.inFlight.size` against
the concurrency cap, and sum `actualCost` from telemetry's current UTC-day
window against the spend ceiling. Either cap being hit skips dispatch for
that sweep round (the task stays `inbox`, tried again next event) rather than
erroring — a full board can just wait out a busy sweep. This is what makes
3.1 safe to turn on for a credit-limited account instead of turning a
supervised bottleneck into an unsupervised one.

## 4. What this deliberately does NOT do

- **Doesn't remove the human merge gate.** `POST /tasks/:id/merge` stays
  explicit and human-triggered, same as `docs/SDD-worktree-isolation.md` §2
  already decided — self-verification (3.4) and integration checks (3.5)
  raise confidence in what a human is merging, they don't skip the click.
- **Doesn't fix the flaky empty-first-response on `/merge`.** Observed 4+
  times across this session and the prior one but never root-caused (looks
  like a response-flush timing issue, not confirmed) — out of scope here;
  flagging it as a known open item rather than guessing at a fix.
- **Doesn't change `AgentDef.autoMerge`'s existing behavior** — that path
  (trustLevel: high + autoMerge: true skips the review gate entirely) is
  untouched; this doc is about making the *review* gate itself run without
  supervision, not about who gets to skip it.
- **Doesn't retry a non-429 failure automatically.** A genuine bug, a
  contract violation, or a crash should still land on `failed`/`pending-review`
  for a human or the pushback loop (already built) to see — only the
  specific, structurally-detectable "this wasn't a real failure, it's a
  clock" case gets silent auto-retry.

## Subtasks

### 1. claude-cli.ts: parse JSON before the exit-code branch, always capture actualCost
Move `JSON.parse(stdout)` ahead of the `exitCode !== 0` check in `runClaude`.
On successful parse, always extract `actualCost` regardless of exit code,
before deciding success/fail. `fail()` gains an optional `actualCost` param.

**Acceptance criteria**
- Gate test: a fixture 429 stdout (real captured shape from this session,
  redacted) produces a `TaskResult` with `actualCost` populated and `ok:
  false`.
- Gate test: an unparseable stdout on non-zero exit still falls back to
  today's plain `fail()` behavior (no `actualCost`, summary from
  stderr/stdout) — never throws.
- Regression test: every existing success-path test in
  `test/claude-cli.test.ts` still passes unchanged.

### 2. 429 detection, reset-time parsing, auto-reschedule
Add a pure, tested `parseSessionLimitReset(resultText: string): Date | null`
(new file or alongside `parse-review-verdict.ts`). Wire `runClaude` to
surface `retryAfter` on a 429. `finishResult` branches on it before the
`!result.ok` check: re-marks the task `inbox` at/after `retryAfter` instead
of `failed`, preserving `reviewLineageId`/worktree exactly like a pushback
re-attempt.

**Acceptance criteria**
- Gate tests for the parser: exact reset-time fixture strings (various
  hour/minute/am-pm combinations) parse correctly; malformed text returns
  `null`, never a guessed time.
- Integration test: a fixture 429 result run through `finishResult` leaves
  the task `inbox` (not `failed`), preserves `reviewLineageId`, and a
  subsequent sweep past the reset time picks it up and reuses the same
  worktree — no fresh worktree created.
- Guard test: `retryAfter` more than [some sane ceiling, e.g. 24h] in the
  future or in the past falls back to plain `failed` instead of silently
  scheduling a near-infinite wait.

### 3. WriteExecutor/CodexWriteExecutor: scoped self-verification allowlist
Add the allowlisted Bash flag (exact syntax verified against the installed
`claude` CLI version first) to both executors' spawn args. Update
`implementer`'s (and every future write-tier agent's) prompt template to
instruct running `bun run typecheck` + `bun test test/` and fixing failures
before reporting done.

**Acceptance criteria**
- Live smoke test (real `claude`, real worktree, a fixture task with a
  deliberately introduced compile error in the starting state): implementer
  run ends with the error fixed and both checks passing, confirmed by
  re-running them independently afterward.
- Gate test: the exact allowlist flag/value is asserted in the spawned
  command args for both executors (regression guard against silently
  widening or narrowing the allowlist).
- Explicit non-goal test: a fixture where `bun test` itself is broken
  (not the task's fault) doesn't loop forever — bounded to the same
  turn/attempt budget `claude` already enforces, not a new retry loop here.

### 4. Auto-integrator on subtask-set completion
New orchestrator hook: on any task reaching `done` with a `parentTaskId`,
check whether every sibling (same `parentTaskId`) is now `done`. If so and
none has already spawned one, auto-create an `integrator` follow-up scoped to
the parent, `repo` pointed at the parent's own repo (post-merge state, not
any one subtask's worktree — this only makes sense after every subtask is
already merged).

**Acceptance criteria**
- Integration test: 3 fixture subtasks under one parent, last one to reach
  `done` triggers exactly one `integrator` task, not one per sibling.
- Integration test: the fetch-body-shape check (this session's actual bug
  class) is exercised against a fixture repo with the exact D/E-style
  mismatch and correctly flags it.
- Regression test: a parent with only one subtask still gets an integrator
  pass — this isn't fan-out-specific, any completed subtask set qualifies.

### 5. Sweep concurrency + spend guard
`WISSEL_MAX_CONCURRENT_TASKS` (default 2) and
`WISSEL_SWEEP_SPEND_CEILING_USD` (default unset) env vars, enforced inside
`sweep()`'s dispatch loop against `this.inFlight.size` and a UTC-day sum from
telemetry.

**Acceptance criteria**
- Gate test: with the cap set to 1 and 3 eligible tasks, exactly 1 dispatches
  per sweep round, the rest stay `inbox` and pick up on the next event once
  the first finishes.
- Gate test: with a spend ceiling set below the sum of fixture
  `estimatedCost`s, no task dispatches at all — verified via telemetry
  dispatch-row absence, not just a return value.
- Regression test: both caps unset (today's default posture) behaves
  identically to pre-change `sweep()` — this ships off by default until
  Milton turns 3.1 on.

### 6. Turn on autonomous mode (deploy config)
Once subtasks 1-5 are merged, set `WISSEL_ORCHESTRATOR=1`,
`WISSEL_EXECUTE_WRITE_TIER=1`, `WISSEL_MAX_CONCURRENT_TASKS` and
`WISSEL_SWEEP_SPEND_CEILING_USD` (values Milton's call — Confusion Protocol:
name the concurrency/spend numbers explicitly before flipping this in
production, don't guess) on the dev/prod launch command. Update
`README.md`'s env var table.

**Acceptance criteria**
- Live run: create a real card, walk away, confirm it reaches `review` (or
  `escalated`, for a deliberately unfixable fixture) with zero manual
  `/run`/`/merge` calls — merge is still the one intentional human click
  (§4).
- Document the exact restart command for Milton (this touches env vars, not
  code — no code deploy needed, just a process restart with the new env set).

## Sequencing

1 and 5 can build in parallel (independent files, no shared state). 2 depends
on 1 (needs the moved JSON.parse). 3 is independent of everything else — can
build anytime. 4 depends on nothing here but touches the same
`finishResult`/orchestrator hook surface as 2, so land it after 2 to avoid a
merge conflict on the same function, not because of a real dependency. 6 is
last by construction — it's the payoff, not a build step.

## Verification

- Gate tests (parser, cap logic, allowlist-flag assertion) run via the
  existing test command, <2s, on every commit — same lane as the review-handoff
  feature's own tests.
- Integration tests (2, 4, 5) exercise real SQLite + real git worktree
  fixtures, no mocks — same standard `test/orchestrator-review-lifecycle.test.ts`
  already set.
- Subtask 3's live smoke test calls the real `claude` CLI — costs real money,
  run once per PR, not on every commit.
- Subtask 6's live run is the actual acceptance test for this whole document:
  a card, unattended, reaching a human-decision point with no manual
  intervention in between.
