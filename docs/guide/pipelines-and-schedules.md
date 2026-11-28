# Pipelines and schedules

## Pipelines

A pipeline is a saved step graph (`src/core/pipeline-runner.ts`,
`docs/SDD-pipelines.md`). The Pipelines page lists them with **Run**,
**Edit** and **Add schedule**, and each one's next scheduled run (see
[Schedules](#schedules)). The editor opens inside the board (`#/pipelines/new`,
`#/pipelines/edit/<id>`) and needs `pipeline-editor/dist/` built (see
[Getting started](getting-started.md)). `src/core/review-handoff-pipeline.ts` and
`src/core/full-lifecycle-pipeline.ts` define the built-in reviewer loop
and full lifecycle as pipeline graphs. The server does not seed them onto
the Pipelines page; the `eval:pipeline-*` scripts use them. Every step runs in-process, write tier included,
regardless of `WISSEL_EXECUTE_WRITE_TIER`. API: `/pipelines`
(CRUD), `POST /pipelines/:id/run`, `GET /pipeline-runs/:runId`.

A pipeline whose steps are all readonly with no `write`/`bash` runs with
no repo (each step in its own `~/.wissel/scratch/<taskId>`) and an
optional input; the Run dialog hides the repo field for it. Any other
pipeline without a repo is a 400.

**AI news podcast** (`docs/SDD-ai-news-podcast.md`): gather the week's AI
news from the web, explain it for a software engineer who follows AI
(`ai-news-explainer`), write a 5 minute podcast script, make audio.
Create it with `bun run seed:ai-news` or from the "Start from
a template" list under New pipeline; check it with `bun run eval:ai-news`
(paid, uses the web and Kokoro). The seed is safe to rerun: it creates the
pipeline, or replaces a stored one's graph in place (same id) when it
differs from the template, or does nothing.

**World news podcast** (SDD §3.8): the same pipeline with a different
gather step (`world-news-gatherer`): the last 48 hours' top world
headlines plus the main news from Spain and the Netherlands, each story
tagged with its region, explained for an informed adult
(`world-news-explainer`). `bun run seed:ai-news` seeds both pipelines;
check it with `bun run eval:world-news`.

Each explained story carries a one-sentence `summary` and a 60 to 150
word `detail` (SDD §3.9). In the run drawer a Quick read row expands to
its story's detail, why it matters and what is not known yet.

**Wissel retrospective podcast** (`docs/SDD-wissel-retro-podcast.md`):
a podcast about your own work in wissel. "Collect activity" is not an
agent: `src/executors/digest.ts` reads this board (cards folded by
lineage), merge commits (read-only git, linked to GitHub), telemetry
spend, `memory/lessons.md` and changed SDDs into a small digest. An
analyst picks what you built, what you learned, what to improve and
ideas to think about; the script and audio steps are the news ones. The
run input sets the period (`last 30 days`, `since 2026-10-01`, default
7 days). `bun run seed:ai-news` seeds it too; check it with
`bun run eval:wissel-retro` (paid, reads a copy of the real board).

The "Make audio" step is not an agent: `src/executors/tts.ts` sends the
script to a local [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
service (`WISSEL_TTS_URL`, docker container `kokoro-tts`) and saves
`~/.wissel/audio/<runId>.mp3`, served at `GET /pipeline-runs/:runId/audio`
(Range supported). The run drawer's Listen tab plays it with a Download
link; it shows "Making audio..." while the step runs, and falls back to
the browser's Read aloud when there is no audio. If Kokoro is down the
step fails with the reason; Quick read and the script still show.

## Schedules

A schedule runs a stored pipeline, or creates a card from a task
template, on a 5-field cron in an IANA timezone (`docs/SDD-schedules.md`).
It lives in the board's SQLite DB (`src/services/schedules.ts`), and
an in-process ticker (`src/core/schedule-runner.ts`) checks every 30 s,
at start and right after any change, so a new time takes effect with no
restart. When a schedule is due the ticker first moves `nextRunAt` to the
next run after now (missed runs collapse into one; a crash can lose a run
but never doubles one), then:

- more than `catchUpHours` late (default 12; `0` = never catch up, with a
  one-minute grace for the tick): skipped, `skipped-stale`;
- its last run (`lastRunId`) still open (a pipeline root not done or
  failed, a task card not done, failed or archived): skipped,
  `skipped-overlap`;
- otherwise a pipeline runs on the same path as `POST /pipelines/:id/run`
  (`runPipelineNow`), or a task card is created with `scheduleId` and the
  normal sweep picks it up with all its usual limits: `started`;
- a missing pipeline, a missing repo or a template that no longer passes
  the `POST /tasks` checks: `error`, `lastError` set, still enabled.
  Deleting a pipeline disables its schedules with `lastError: "pipeline
  deleted"`.

API (every validation failure is a 400 `{error}` with a plain message,
an unknown id is a 404):

| Endpoint | What it does |
|---|---|
| `GET /schedules` | Every schedule, plus `cadence` ("every day at 06:00") and `lastRunStatus` (status of the `lastRunId` card, or `null`). |
| `POST /schedules` | Create: `name`, `kind` (`pipeline` or `task`), `cron`, `timezone` (default `Europe/Madrid`), optional `enabled` (default true), `catchUpHours`, `repo`; `pipelineId` and `input` for a pipeline, `taskTemplate` `{title, body, labels, repo?, harnessOverride?, model?}` for a task. 201. |
| `GET /schedules/:id` | One schedule, same shape as the list. |
| `PATCH /schedules/:id` | Any of `name`, `cron`, `timezone`, `enabled`, `input`, `repo`, `taskTemplate`, `catchUpHours`. A new cron, timezone or `enabled` recomputes `nextRunAt`. `kind` and `pipelineId` can't change. |
| `DELETE /schedules/:id` | 204. Past run cards stay. |
| `POST /schedules/:id/run-now` | Fires now through the same code, leaves `nextRunAt` alone: `{runId}`. 409 while the last run is open, 400 if it can't start. |
| `GET /schedules/preview?cron=&timezone=` | `{valid, error?, cadence, next}` with the next 5 runs as ISO UTC, for editors. |

Every fire, skip and error logs one line (`schedule: "<name>" fired, run
<id>`, `skipped (overlap)`, `skipped (stale)`, `error: ...`) and appends
one telemetry event to `WISSEL_TELEMETRY_PATH`: `{"type": "schedule",
"scheduleId", "name", "outcome", "runId"?, "error"?, "at"}`, where
`outcome` is `started`, `skipped-overlap`, `skipped-stale` or `error`.
On start the server logs `schedules: N enabled, next: <name> at <local
time>`.

On the board, the Pipelines page's **Schedules** panel lists every
schedule: what it runs, cadence, timezone, next run and last run (with
its outcome and a link to the run card) in your browser's time, an
enabled toggle, **Run now** (a 409 overlap shows as is), **Edit** and
**Delete**. A pipeline's **Add schedule** and Edit open the schedule
editor: every day, weekdays, weekly on chosen days or every N hours, a
time and a timezone (your browser's preselected), or **Advanced: cron**.
It shows the next three runs from `/schedules/preview` as you type, or
the error, and Save stays off while it's invalid. In **+ New**, the Task
tab's **Repeat** saves a task schedule from the form instead of creating
a card. The picker, row text and request bodies are
`src/api/public/board-schedules.js`.

The morning podcasts move here from the systemd timer
(`ops/systemd/README.md`). `bun run seed:schedules` creates "AI news
podcast" and "World news podcast" (`0 6 * * *`, `Europe/Madrid`,
`catchUpHours: 12`) **disabled**, by name, and never touches one that
already exists. Enable them only after the timer is off, or each podcast
runs twice.

**In Ask** (`docs/SDD-schedules.md` §3.9): the concierge sees every
schedule (id, name, what it runs, cadence, cron, timezone, next run in its
own zone, enabled), the default timezone and the local time now, and can
propose these actions. Each runs the same `board-actions.ts` function as
its route, after `validateSchedule` checks the cron and timezone the model
gave: a bad one (6 fields, an unknown zone, runs under 5 minutes apart) is
refused with that message and never repaired.

| Action | Tier | Runs |
|---|---|---|
| `update_schedule` (`cron`, `timezone`, `input`) | A, at once | `PATCH /schedules/:id`. "Move the news podcasts to 7:00" is one per podcast schedule. |
| `set_schedule_enabled` | A | `PATCH /schedules/:id` with `enabled`. |
| `run_schedule_now` | A | `POST /schedules/:id/run-now`. |
| `create_schedule` (`pipeline` or `task`, `cron`, `timezone`, `name`?) | B, waits for Confirm | `POST /schedules`. The timezone is required here. |
| `delete_schedule` | B | `DELETE /schedules/:id`. |

A schedule is named by id, an 8+ character id prefix, its exact name or
whole words of it; zero or several matches is a question back, not an
action. `create_task` also takes an optional `notBefore` ("start this
tonight at 11"), checked by `validateNotBefore` like `POST /tasks`.

**In the app**: the Board tab has a Scheduled section, runs in the next
24 h first, each with an On toggle and Run now (editing stays on the
board and in Ask). A card waiting for its start time shows a "Starts
23:00" chip on the Board tab, the card page and Ask's chips.

`bun run eval:ask-schedules` is the paid eval of the real concierge on ten
schedule phrasings (pass 9 of 10, see `eval/README.md`).

---

[Back to the README](../../README.md)
