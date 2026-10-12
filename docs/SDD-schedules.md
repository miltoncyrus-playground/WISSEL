# SDD: Schedules for pipelines and tasks, and "Start at" for a card

Status: approved by Milton 2026-10-12 (items A and B of the timer
analysis). To be built through wissel's own planner card.

## 1. Why, and the outcome

Today wissel can't change when anything runs:

- The only schedule is a systemd user timer outside wissel:
  `ops/systemd/wissel-morning-podcasts.timer` (`OnCalendar=*-*-*
  06:00:00 Europe/Madrid`) whose `.service` hard-codes the two pipeline
  names for `scripts/run-pipelines.ts`. Changing the time means editing
  a unit file and `systemctl --user daemon-reload`.
- `pipelines` (`src/services/pipelines.ts`) has no schedule column.
- A card has no "run at". The only clock on a card is `retryAfter`,
  set by a 429 (`Board.scheduleRetry`), never by a person.

**Outcome:** Milton changes when a pipeline or a recurring task runs,
or when one card starts, from the board, the app or Ask, with no file
edit and no restart, and the next run happens at the new time.

**How we see it:** every fire, skip and error writes a log line and a
telemetry event (`type: "schedule"`, §3.6), and updates the schedule's
`lastRunAt`/`lastOutcome`/`lastRunId`. Acceptance check after the
switch-over (§7): `GET /schedules` shows both podcasts with `lastRunAt`
within 60 s of 06:00 Europe/Madrid on three mornings in a row,
including 2026-10-25 (the DST change).

## 2. Scope

In:

- **A. Schedules.** A schedule runs a stored pipeline, or creates a
  card from a task template, on a cron cadence in an IANA timezone.
  Lives inside wissel (SQLite + an in-process ticker). Replaces the
  systemd timer.
- **B. Start at.** An optional `notBefore` time on a card. The sweep
  leaves the card alone until then.

Out (named so nobody builds them by accident): run timeouts per
task/step (item C), runtime-editable intervals for the background
schedulers (item D), sub-minute or seconds-field cron, schedules for
codex-only flows beyond what the normal routing already does, any
distributed or multi-process scheduling.

## 3. A. Schedules

### 3.1 Library

Use **croner**, pinned exactly to `10.0.1`, for cron parsing and the
next-run time only. Chosen 2026-10-12: zero dependencies, timezone
support, runs under Bun, 2.6k stars, last push 2026-10-08, 5 open
issues, ~10M weekly downloads. Second choice `cron-parser` 5.10.2 (more
downloads, but pulls in luxon). Rejected `cron`/`node-cron` as runners:
we keep our own ticker (§3.4) because catch-up and overlap rules have to
read our own state.

Only this is used: `new Cron(expr, { timezone, paused: true }).nextRun(from)`
(and `nextRuns(n, from)` for previews). croner never owns a timer here.

### 3.2 Data model

New table `schedules` in the board's SQLite DB, own store class
`SqliteScheduleStore` in `src/services/schedules.ts` (same shape as
`SqlitePipelineStore`):

| column | type | notes |
|---|---|---|
| id | TEXT PK | uuid |
| name | TEXT | shown in UIs, e.g. "AI news podcast, 06:00" |
| kind | TEXT | `pipeline` or `task` |
| pipelineId | TEXT NULL | kind=pipeline |
| input | TEXT NULL | pipeline input, optional |
| repo | TEXT NULL | pipeline repo, or the task's repo |
| taskTemplate | TEXT NULL | kind=task: JSON `{title, body, labels, repo?, harnessOverride?, model?}`, validated with the same rules as `POST /tasks` |
| cron | TEXT | 5 fields (no seconds) |
| timezone | TEXT | IANA, e.g. `Europe/Madrid` |
| enabled | INTEGER | 0/1 |
| catchUpHours | REAL | default 12; 0 = never catch up |
| nextRunAt | TEXT NULL | ISO UTC; NULL when disabled |
| lastRunAt | TEXT NULL | when it last fired or skipped |
| lastOutcome | TEXT NULL | `started`, `skipped-overlap`, `skipped-stale`, `error` |
| lastError | TEXT NULL | |
| lastRunId | TEXT NULL | pipeline root card id, or the created card id |
| createdAt, updatedAt | TEXT | |

Types go in `src/core/types.ts` (`ScheduleDef`). A card created by a
task schedule gets `TaskCard.scheduleId` (new optional field + column,
added with the usual `ALTER TABLE ... ADD COLUMN` heal in `board.ts`) so
the card and its schedule link both ways. A pipeline run's root card
gets the same field.

### 3.3 Validation (deterministic, shared by API, UI preview and Ask)

`src/core/schedule-time.ts`, pure functions, no I/O:

- `validateCron(expr)`: croner parses it; exactly 5 fields.
- `validateTimezone(tz)`: `new Intl.DateTimeFormat("en", { timeZone: tz })` doesn't throw.
- **Minimum gap 5 minutes** between any two of the next 10 runs.
  Guards against `* * * * *` burning money on a paid pipeline.
- `nextRunAfter(cron, tz, from: Date): Date`.
- `describeCadence(cron)` for UIs: "every day at 06:00", "weekdays at
  07:30", falling back to the raw cron. Deterministic templates, no LLM.
- `DEFAULT_SCHEDULE_TIMEZONE = "Europe/Madrid"`, the only place that
  default lives. UIs preselect the browser's zone
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and send it.

### 3.4 The ticker: `src/core/schedule-runner.ts`

One `ScheduleRunner`, started by `src/api/server.ts` next to the other
schedulers (log line on start: `schedules: N enabled, next: <name> at
<local time>`). Injectable `now()` and timer functions so every test
runs on a fake clock.

- Ticks every 30 s, and immediately on start and after any store
  change. Fire precision is therefore ≤ 30 s.
- **Due:** `enabled && nextRunAt <= now`.
- **Advance before fire (at-most-once):** in one write, set `nextRunAt =
  nextRunAfter(cron, tz, now)` (computed from *now*, not from the old
  `nextRunAt`, so any number of missed occurrences collapse into one
  fire) and `lastRunAt = now`. Only then start the run. A crash between
  the write and the run loses that one run; it never doubles it.
- **Catch-up / staleness:** if `now - nextRunAt > catchUpHours`, don't
  fire: advance, `lastOutcome = skipped-stale`. Covers the server being
  down at fire time: on the next start a fresh miss fires once (like
  systemd `Persistent=true`), a day-old podcast doesn't. A fire found
  within `ON_TIME_GRACE_MS` (1 minute) of its time is on time, not a
  catch-up, so `catchUpHours: 0` still fires when the 30 s tick reaches
  it a few seconds late.
- **Overlap:** if `lastRunId` points at a card that isn't terminal yet
  (a pipeline root not `done`/`failed`, a task card not
  `done`/`failed`/archived), don't fire: advance, `lastOutcome =
  skipped-overlap`.
- **Fire a pipeline:** through one shared function, extracted from the
  `POST /pipelines/:id/run` route in `src/api/server.ts`
  (`runPipelineNow(pipelineId, repo, input)`), so a scheduled run and a
  manual run take the same path, same executors, same
  `stepsNeedingRepo` check. Use `ctx.onRootCreated` to record
  `lastRunId` right away. Do **not** await the run's settlement in the
  tick; catch and log its rejection.
- **Fire a task:** `board.create({...taskTemplate, scheduleId})`. The
  normal sweep routes and runs it, with every usual gate (concurrency
  cap, spend ceiling, harness availability).
- **Errors:** pipeline deleted, repo required but missing, template
  invalid: `lastOutcome = error`, `lastError` set, schedule stays
  enabled (it may be fixed). Deleting a pipeline disables its schedules
  with `lastError = "pipeline deleted"`.
- Stop cleanly on server shutdown (clear the interval), same as the
  other schedulers.

### 3.5 API (in `src/api/server.ts`, logic in the store/runner)

- `GET /schedules`: every schedule plus `cadence` (describeCadence),
  and `lastRunStatus` (status of the `lastRunId` card).
- `POST /schedules`, `GET /schedules/:id`, `PATCH /schedules/:id`
  (any of name, cron, timezone, enabled, input, repo, taskTemplate,
  catchUpHours; recompute `nextRunAt`), `DELETE /schedules/:id`.
- `POST /schedules/:id/run-now`: fires now through the same code,
  leaves `nextRunAt` alone, refuses with 409 on overlap.
- `GET /schedules/preview?cron=…&timezone=…`: `{ valid, error?,
  cadence, next: [5 ISO times] }` for the editors.
- 400 with a plain message on any validation failure.

### 3.6 Trace

Each fire/skip/error: one log line (`schedule: "<name>" fired, run
<id>` / `skipped (overlap|stale)` / `error: …`) and one telemetry JSONL
event `{type: "schedule", scheduleId, name, outcome, runId?, error?,
at}` through the existing `TelemetryLog`.

### 3.7 Board UI (`src/api/public/board.html` + a new
`src/api/public/board-schedules.js` pure-render module with `.d.ts`,
like `board-pipelines.js`)

- A **Schedules** panel: name, what it runs, cadence text, timezone,
  next run (local), last run with outcome and a link to the run card,
  enabled toggle, Run now, Edit, Delete (with confirm).
- Each pipeline row in the Pipelines tab shows its next scheduled run
  and an "Add schedule" button.
- The schedule editor: a picker (every day / weekdays / weekly on
  chosen days / every N hours) plus time and timezone (browser zone
  preselected), and an "Advanced: cron" field. Shows the next three runs
  from `/schedules/preview` as you type, and the error when invalid.
- The New task form gets **Repeat** (off by default). On, it creates a
  task schedule instead of a card.

### 3.8 App (`app/`, React)

- Board screen: a "Scheduled" section listing upcoming runs (next 24 h
  first) with the enabled toggle and Run now. Editing stays on the
  board and in Ask.
- Types in `app/src/types.ts`, fetchers in `app/src/api.ts`.

### 3.9 Ask (`src/services/concierge-actions.ts`,
`concierge-control.ts`, `concierge-context.ts`)

New control actions, each running the same store/runner function as
its endpoint:

| action | tier | why |
|---|---|---|
| `create_schedule` | B | recurring spend: needs the Confirm tap |
| `update_schedule` (time, days, timezone, input) | A | reversible |
| `set_schedule_enabled` | A | reversible |
| `run_schedule_now` | A | same as `run_pipeline` |
| `delete_schedule` | B | |

The model proposes cron + timezone; the server validates them with
§3.3 and refuses with the validation message, never guesses. Ask's
context lists schedules (id, name, cadence, timezone, next run, enabled)
and the default timezone. "Move the news podcasts to 7:00" must become
one `update_schedule` per podcast schedule.

## 4. B. Start at (`notBefore`)

- `TaskCard.notBefore?: string` (ISO UTC). New column with the usual
  heal. Accepted on `POST /tasks` (must parse, must be in the future,
  at most 30 days out).
- `POST /tasks/:id/not-before` `{ notBefore: string | null }` for a card
  in inbox/ready that isn't routed: set or clear.
- `Orchestrator.sweep()` skips a card whose `notBefore` is in the
  future, next to the existing `retryAfter` check. The wake timer
  (`scheduleRetryWake`) arms for the earliest of `retryAfter` and
  `notBefore`, so a quiet board still starts the card on time (the
  2026-10-09 bug that timer fixed must not come back for `notBefore`).
- Manual **Run** (`Orchestrator.runNow`) is an explicit human decision:
  it ignores `notBefore` and clears it.
- Separate field from `retryAfter` on purpose: `retryAfter` is cleared
  on routing and travels with `resumeSessionId`; `notBefore` is a
  person's choice and stays visible on the card.
- Board: a "Starts 23:00" chip on the card; the New task form gets an
  optional "Start at" (datetime-local, browser zone, sent as UTC); the
  drawer can change or clear it. App: same chip. Ask: `create_task`
  takes an optional `notBefore` ("start this tonight at 11").

## 5. Tests and evals

Gate tests (fake clock, no network, no LLM):

- schedule-time: cron/timezone validation, 5-minute minimum,
  `describeCadence`, and DST: `0 6 * * *` Europe/Madrid gives
  2026-10-24T04:00Z then 2026-10-25T05:00Z; `30 2 * * *` on the spring
  change (2027-03-28) fires exactly once that day (assert whatever
  croner does, and document it).
- runner: fires when due and only once; advance-before-fire; collapsed
  catch-up after downtime; stale skip past `catchUpHours`; overlap skip;
  pipeline deleted → error and disabled; run-now leaves `nextRunAt`;
  disable → no fire; telemetry and log lines written.
- store round trip and API routes (status codes, validation messages,
  preview).
- `notBefore`: sweep skips until due, wake timer arms for it, runNow
  clears it, POST validation.
- Ask: each new action validated and refused correctly, tiers enforced.
- e2e: board schedule editor (preview, save, toggle, delete), New task
  "Start at" chip, app Scheduled section.

Evals (paid, LLM):

- `eval/ask-schedules.eval.ts`: ~10 phrasings ("every weekday at 7",
  "move the podcasts to 7", "pause the world news one", "start this
  tonight at 11", "every 2 hours", an invalid one like "every 30
  seconds") → the right action, cron and timezone, or a refusal. Pass
  threshold 9/10. `bun run eval:ask-schedules`.

## 6. Files (expected)

New: `src/services/schedules.ts`, `src/core/schedule-time.ts`,
`src/core/schedule-runner.ts`, `src/api/public/board-schedules.js` +
`.d.ts`, `scripts/seed-schedules.ts`, tests, eval. Changed:
`src/core/types.ts`, `src/services/board.ts`, `src/core/orchestrator.ts`,
`src/api/server.ts`, `src/api/public/board.html`,
`src/services/concierge-*.ts`, `app/src/*`, `package.json` (croner,
scripts), `README.md` (API, env, docs list), `ops/systemd/README.md`.

## 7. Switch-over from systemd (no double run)

1. `scripts/seed-schedules.ts` (idempotent, by name) creates two
   **disabled** schedules: "AI news podcast" and "World news podcast",
   `0 6 * * *`, `Europe/Madrid`, `catchUpHours: 12`.
2. Milton runs `systemctl --user disable --now
   wissel-morning-podcasts.timer`. Agents never run systemctl.
3. Milton enables both schedules (board, app or Ask).
4. After the first clean morning, a follow-up commit removes the two
   unit files and rewrites `ops/systemd/README.md` to point here.
   `scripts/run-pipelines.ts` stays as a manual CLI.

## 8. Where it breaks

- Server down at 06:00 and back after 18:00: the podcast is skipped
  (stale), by design. Raise `catchUpHours` if that's wrong.
- Two wissel servers on one DB would both fire. Not supported (one
  server per machine today).
- Clock jumps (NTP, suspend): the 30 s tick re-reads `now()`; a jump
  forward fires due work once, a jump back delays at most until
  `nextRunAt`.
- A pipeline that takes longer than its interval: overlap skip, logged.
- croner's DST handling is the source of truth for wall-clock gaps and
  repeats; the tests pin it so an upgrade that changes it fails loudly.
