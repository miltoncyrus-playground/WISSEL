# wissel

Personal research project. It changes often, and changes may break things.

wissel is a task board that routes each card to an agent from a fleet
(`agents/manifest.yaml`) and runs it under one of your local accounts
(`harnesses.yaml`). Code changes happen in an isolated git worktree, go
through an automated reviewer, and are merged back into the repo.

Named after the railway switch point: the thing that decides which track
the work goes down.

## Run it

```bash
bun install
WISSEL_ORCHESTRATOR=1 WISSEL_EXECUTE_WRITE_TIER=1 bun run serve   # how it's normally run
```

The board is at `http://localhost:8787`, the new app at
`http://localhost:8787/app` (see "The app" below).

Defaults, if you start it with no env vars (`src/api/server.ts:1424-1425`):
both flags are off. Nothing is routed until you click **Run** on a card,
and write-tier agents (implementer, fixer, integrator, lint-fixer) are
only routed and handed off to an external runner, not executed. The
board's **Run** button always executes, write tier included.

In daily use both flags are on: wissel routes every new card itself and
runs write-tier work locally in a worktree.

| Command | What it does |
|---|---|
| `bun run serve` | Board API and UI on :8787. Use this one. |
| `bun run dev` | Same with `--watch`. Restarts whenever a file under `src/` changes, including when wissel merges its own work into this checkout (see below). |
| `bun run build:app` | Build the app at `/app` into `app/dist/` (`serve` does this for you). |
| `bun run agents` | List the fleet. |
| `bun run why <task-id>` | Show what the router matched for a task, and why. |
| `bun run team create <prefix>` | Scaffold a coordinator and 3 specialists in `agents/manifest.yaml`. |
| `bun run version` | Commit, branch and dirty state of this checkout. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run test` | Gate tests (`bun test test/`). |
| `bun run test:e2e` | Playwright tests against a live server. |
| `bun run test:e2e:affected` | Only the e2e specs affected by your changes. |
| `bun run live-check:shutdown` | Real server, real agent spawn, SIGTERM: asserts no agent process survives. |
| `bun run live-check:sandbox` | Real `claude -p` write-tier run with the Bash sandbox on: piped Bash works; writes outside the worktree, `~/.ssh` reads, off-allowlist hosts and `git commit` don't. Skips when the sandbox can't start. |
| `bun run denials:baseline` | Permission denials per implementer run (raw, old keys, new keys); `--telemetry` for the after numbers by sandbox state. |
| `bun run seed:ai-news` | Create or upgrade the stored podcast pipelines (see Pipelines). |
| `bun run seed:schedules` | Create the two morning podcast schedules, disabled (see Schedules). Idempotent. |

Paid evals (real LLM calls), one script each:

```bash
bun run eval:readonly
bun run eval:implementer-reviewer
bun run eval:planner-subtask-plan
bun run eval:pipeline-review-handoff
bun run eval:pipeline-full-lifecycle
bun run eval:pipeline-mcp-integration
bun run eval:live-task-output
bun run eval:conflict-integrator
bun run eval:merge-gate
bun run eval:memory-curation-quality
bun run eval:claude-cli-429-replay
bun run eval:ai-news
bun run eval:world-news
bun run eval:sandbox-denials
```

### One-time host setup: the write-tier Bash sandbox

Write-tier agents run Bash inside Claude Code's OS sandbox
(`docs/SDD-write-tier-sandbox.md`). On Linux it needs bubblewrap and
socat, and on Ubuntu 24.04+ (where
`sysctl kernel.apparmor_restrict_unprivileged_userns` prints 1) an
AppArmor profile that lets bwrap create user namespaces:

```bash
sudo apt-get install bubblewrap socat
sudo tee /etc/apparmor.d/bwrap > /dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
sudo systemctl reload apparmor
```

Then restart the server. Startup logs `write-tier sandbox: on`, and
`GET /version` shows `writeSandbox.state`. If anything is missing,
startup logs `write-tier sandbox: UNAVAILABLE` with the fix for each
problem and write-tier Bash falls back to the allowlist (more permission
denials, same boundary). `bun run live-check:sandbox` proves it end to end.

The pipeline editor and the app are separate Vite bundles.
`pipeline-editor/dist/` and `app/dist/` are gitignored; `bun run serve`
and the e2e web server build both before starting
(`bun run build:editor`, `bun run build:app`). Each needs its own
dependencies installed once per checkout. A rebuild while the server runs
is picked up by a browser reload; no server restart.

```bash
cd pipeline-editor
bun install
bun run build
cd ..
(cd app && bun install)
bun run build:app
```

### Restarting safely

Stop the server with Ctrl-C or `kill <pid>` (SIGINT/SIGTERM), never
`kill -9`. The shutdown handler kills every agent subprocess it started
(`src/executors/child-processes.ts`). On the next start, crash recovery
kills any agent process left behind, requeues tasks stranded at
`running`, moves cards whose merge already landed (their recorded
`mergedSha` is in HEAD) to `done`, and finishes review verdicts a
restart interrupted (`src/core/crash-recovery.ts`,
`docs/SDD-crash-recovery.md` §9, §10, §11).

Use `bun run serve`, not `bun run dev`, when wissel works on its own
source. An auto-merge into `src/` restarts the `--watch` process mid-merge.
Recovery handles it on the next start, but the restart is avoidable.

## How it works

1. **Board.** Cards live in SQLite (`~/.wissel/board.sqlite`). Create one
   from **+ New** (Task or Pipeline run) or `POST /tasks`.
2. **Router.** `src/core/router.ts` scores each agent by how many of the
   card's `labels` match its `tags`. A zero match or a tie for first stops
   before any spend and lands as `no-match`. `bun run why` shows the full
   ranking.
3. **Harness.** `src/core/harness-pool.ts` picks the account to run under
   (see Harnesses below). If none is available, the task waits unrouted
   and resumes on its own when one frees up or is enabled.
4. **Executor.** `src/executors/`: `claude -p` (`claude-cli`),
   `codex exec` (`codex-cli`), or the Anthropic Messages API
   (`anthropic-api`, read-only agents only). Output streams live into the
   card's drawer.
5. **Worktree.** Write-tier work runs in its own git worktree under
   `~/.wissel/worktrees/<task>` (`src/services/worktree.ts`). The task's
   repo is not touched until merge.
6. **Review.** An agent with `reviewer` in its `handoffs` (implementer
   does) lands on `pending-review` and a reviewer run follows. On
   `changes_requested` a pushback attempt reruns the implementer in the
   same worktree. After 5 pushbacks the card goes to `escalated`
   (`src/core/orchestrator.ts`, `docs/SDD-review-handoff.md`). When the
   reviewer says the work needs a command the implementer was refused
   (the `grants` field of its verdict), the card escalates on that round
   as "needs a grant", and **Grant and retry** on the board
   (`POST /tasks/:id/escalation/grant-and-retry`) adds the grant and
   continues in the same worktree.
7. **Merge.** On approve, an agent with `autoMerge: true` and
   `trustLevel: high` is merged and the card moves to `done`. Without it,
   the card stops at `review` for a human **Merge** or **Discard**
   (`POST /tasks/:id/merge`, `/discard`). Both go through one merge path
   (`mergeTaskWorktree`, `docs/SDD-worktree-isolation.md` §7): the repo's
   current HEAD is merged into the card's branch in the worktree, the
   project's merge gate runs there, and only then does the repo's
   checkout fast-forward to it. Nothing merges in your checkout, so a
   conflict never leaves `MERGE_HEAD` there and your uncommitted edits
   are never touched. Merges into one repo run one at a time. What the
   Merge button can answer instead of landing:
   - **Merge gate failed**: names the command; the card goes back as a
     pushback attempt with the output (same 5-round limit as review).
   - **Conflict**: left in the worktree, one integrator card resolves it
     there; Merge again after.
   - **Blocked by uncommitted local changes in: files**: commit or move
     those edits in your checkout, then Merge again. No integrator.
   - **HEAD moved twice**: someone kept committing; Merge again.

   The gate is per project: `POST /projects/:id/merge-gate
   {"mergeGate": [["bun","run","typecheck"],["bun","run","test"]],
   "mergeGateTimeoutMs": 600000}` (`null` clears it; default timeout 10
   minutes per command). wissel's own checkout is seeded with
   typecheck + test. No gate means the merge lands as before, recorded
   as `gate: "none"` on the `merge` telemetry event.
   A project can also carry execution settings for a non-Bun repo:
   `POST /projects/:id/settings` with any of `sandboxAllowedDomains`
   (extra sandbox hosts, e.g. `["pypi.org","*.pythonhosted.org"]`, at
   most 20), `verification` (`{"commands": [["uv","run","pytest"]],
   "allowedTools": ["Bash(uv run pytest:*)"]}`), `worktreeSetup`
   (`[["uv","sync"]]`) and `protectedPaths` (repo-relative globs, no
   `..`). An absent key is kept, `null` clears it, bad input is a 400
   naming the field. `GET /projects` returns them; see
   `docs/SDD-project-settings.md`. `worktreeSetup` runs once in each new
   worktree, in order, before the agent starts (10 minutes per command).
   A failure fails the card with the command's last 200 output lines;
   reviewer, fixer and integrator runs on the same worktree skip it
   (`docs/SDD-worktree-isolation.md` §8). The other three are stored
   only for now.
   An implementer may run only `bun test` and `bun run typecheck`
   unless the card grants more: `extraAllowedTools` on `POST /tasks`, or
   `POST /tasks/:id/allowed-tools` (command-scoped Bash only, e.g.
   `Bash(bun install:*)`; see `src/core/allowed-tools.ts`). A card that
   isn't running can be pinned to a harness after it was made with
   `POST /tasks/:id/harness {harness}` (`null` clears it).

A planner card ends in a `subtask-plan` block that the orchestrator turns
into real child cards. When every child has landed, an integrator card is
created to check they fit together.

A claude-cli session limit (429) reschedules the task for the reset time
in the error text instead of failing it (`docs/SDD-pipeline-automation.md`
§3.2). The retry resumes the cut-off session (`claude --resume`) instead
of starting over, and falls back to a fresh run when that session can't
be found.

A card can be given a start time: `notBefore` (ISO with a zone, e.g.
`2026-10-12T23:00:00Z`, in the future, at most 30 days out) on
`POST /tasks`, or `POST /tasks/:id/not-before {notBefore}` on a card in
inbox or ready that isn't routed yet (`null` clears it; 409 otherwise).
The card is not routed or run before then, and starts on time on a quiet
board. **Run** on the card starts it anyway and clears the start time
(`src/core/not-before.ts`, `docs/SDD-schedules.md` §4). On the board, the
Task tab's optional **Start at** (your browser's time, sent as UTC) sets
it, the card shows a "Starts 23:00" chip (with the date when it isn't
today) until it's picked up, and the card's drawer changes or clears it.

`bun run usage:report [--since 2026-10-10] [--agent implementer]` shows
where agent spend goes: per agent the runs, cost, turns, context per turn
and output, and what runs cut off by a session limit cost
(`docs/proposal-agent-run-efficiency.md`).

## The board

`src/api/public/board.html`, vanilla JS, no build step
(`docs/SDD-ui-cleanup.md`).

- **Sidebar.** Work: Board, Pipelines, Archive. Setup: Agents & skills,
  Harnesses, MCP servers, Projects, Memory, Settings.
- **Top bar.** Project switcher, **+ New**, the account line (one chip per
  enabled harness with what's running on it and which model,
  `GET /status/accounts`), and a version badge (`GET /version`).
- **Needs you.** Every card in `review`, `escalated`, `failed` or
  `no-match`, plus pending MCP approvals.
- **Lanes.** Queued, Working, In review, Done (last 24h by default). A
  second view, **By feature**, shows one swimlane per root card with its
  subtasks and follow-ups.
- **Pipeline runs** show as one card with step progress. Clicking opens
  the run drawer; "View on canvas" shows the graph with live step status.
- **Archive.** Archived cards and their subtrees. Auto-archive of `done`
  cards after 24h is behind `WISSEL_AUTO_ARCHIVE`.

## The app

`app/` (Vite, React, TypeScript, vitest), served at `/app`
(`docs/SDD-wissel-app.md`). Phone first (390 px) and desktop. The board
stays at `/board`, unchanged apart from a "Try the new app" link in its
top bar.

- **Shell.** Phone: a bottom tab bar (Feed, Ask, Board, Listen, You).
  Desktop (1024 px and up): a left rail and a right **Live** panel
  (at work, running, needs you, landed today). Screens are hash routes
  (`#/feed`, `#/ask`, ...); `/app` opens Ask.
- **Command palette.** Cmd-K or Ctrl-K (or the search button): jump to a
  screen, open a card by title, run a pipeline by name, New card (opens
  Ask).
- **Board tab.** Running, Needs you, Review and Done today from `/tasks`,
  a read-only card view at `#/board/<id>`, and a link to the full board.
- **Live.** One shared `EventSource('/events')` keeps every screen
  current.
- **Look.** A news-site layout (white ground, heavy sans headlines, one
  green, hairline-ruled lists, header nav on desktop). Light tokens by
  default and dark ones under `prefers-color-scheme`, both in
  `app/src/tokens.ts` (contrast checked by a unit test), self-hosted
  fonts (Figtree, Geist Mono via `@fontsource`): no internet needed on
  the LAN. Reference mockups: `docs/mockups/techcrunch/`.
- **Feed.** What happened, newest first, from `GET /feed?limit=&before=`
  (`src/services/feed.ts`, pure `buildFeed`): cards that landed, cards
  that need you (review, escalated, failed with Retry, no match, an MCP
  approval with Approve, a card held for a switched-off harness),
  podcasts with Play (in the mini-player), their `check-news-run`
  results, and each past day's spend by harness. Updates live over
  `/events`; "Load more" pages back.
- **Stories.** Rings for the last 24 hours (AI news, World, Needs you,
  Landed, Your week). A ring opens a full-screen viewer: tap or swipe
  left/right, arrow keys, swipe down or Escape to close. Watched rings go
  grey (kept in `localStorage`).
- **Mini-player.** One player for the whole app, above the tab bar on a
  phone and in the Live panel on desktop: play/pause, back 15 s,
  forward 30 s, a position slider. It keeps playing while you change
  screens, remembers where you stopped in each episode (and what was
  playing, across a reload) in `localStorage`, and shows the episode on
  the lock screen and headset keys through Media Session.
- **Listen.** Every podcast pipeline's episodes from `GET /podcasts`
  (`?limit=` per pipeline, 1 to 50, default 10), latest first, with the
  same Quick read as the board's run drawer: sources as links, invented
  sources flagged, and "More" for the explain step's detail. The app
  runs the board's own `board-news.js` for it through `app/src/news.ts`.
- **Ask.** Chat with wissel (`POST /ask`, `GET /conversations`,
  `GET /conversations/:id`; `docs/SDD-wissel-app.md` §3.4). The
  `concierge` agent (claude-fable-5-1, no tools, private `claude` harness
  only) reads the board as fenced data and proposes actions, checked in
  code before anything happens, at most three per message: create a
  card (labels from the board's set, repo only a registered project),
  run a pipeline, show a card, or press one of the board's own buttons
  (§3.7). Those run the same functions as the board's endpoints
  (`src/services/board-actions.ts`), on cards found in code by id8 or
  title words (zero or several matches is a question, never a guess),
  and only when the board would allow it. At once: move, run now,
  retry, stop, approve or deny an MCP request, grant and retry, abandon,
  archive, unarchive, add a dependency, set a card's harness, enable or
  disable a harness or MCP server, set a harness model. After a Confirm
  tap in the app (`POST /ask/actions/:id/confirm`, 10 minutes, once,
  never from a "yes" in chat): merge, discard, delete a card or a
  pipeline, grant tools, trust an MCP tool, remove a project, and any
  batch of more than three cards ("retry everything that failed"
  expands in code, at most 10). Never from chat: secrets, accounts,
  `agents/manifest.yaml`, pipeline contents, restarting the server.
  Archive, move and harness changes get an Undo chip. Every control
  action is stored on its message and logged as an `ask.action`
  telemetry row. Cards it makes show as chips that follow the board
  live; a podcast run gets Play once its audio is ready. Quick replies
  (run a podcast, what needs me, retry failed, show harnesses, what did
  I do this week, what is running, show board) come from code. Each
  reply shows its cost, which also goes to telemetry. The open chat
  survives a reload; "Earlier chats" lists the rest. Palette "New card"
  now opens Ask.
- **Voice.** The mic button in Ask turns a voice note into text
  (`POST /voice`, multipart, at most 10 MB and 5 minutes;
  `docs/SDD-wissel-app.md` §3.5) through the local speaches service
  (`WISSEL_STT_URL`). The text lands in the box to check before sending.
  On the board's plain-HTTP LAN address the mic opens the phone's own
  recorder; on localhost (or HTTPS) it records in the page and stops by
  itself at 5:00. "Play reply" on a wissel message has Kokoro read it
  (`POST /ask/:messageId/audio`, the podcasts' queue, one MP3 per message
  in `<WISSEL_AUDIO_DIR>/ask/`) and plays it in the mini-player. Set up
  speaches once: `docker run -d --name speaches --restart unless-stopped
  -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu`, then
  `curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small`.
- **Agent faces.** Every agent has an avatar: a colour and a one or two
  letter glyph. Set one with `persona: { color: "#RRGGBB", glyph: "Im" }`
  in `agents/manifest.yaml` (checked at load); without it the app derives
  a stable one from the agent id (`app/src/persona.ts`). Faces show on
  Board and Live rows and on Ask's chips; an agent with a card running
  pulses as "working" (a still ring with reduced motion). The Live panel
  and You list who is at work right now.
- **You: Wissel Wrapped.** `GET /wrapped?period=last 7 days` (or `last
  30 days`, `since YYYY-MM-DD`; `docs/SDD-wissel-app.md` §3.6): cards
  merged, commits, agent runs, spend and the top agent straight from the
  retrospective's digest (`src/services/wissel-digest.ts`), plus
  pipelines added, the merge streak (days in a row with a `Merge
  wissel/...` commit, read-only git) and the lesson of the week (the
  latest retrospective run's first learning). The You tab shows them as
  story cards you swipe (or Previous/Next, arrow keys), with 7 and 30 day
  views. Download saves the current card as a PNG; Share sends it through
  the phone's share sheet where the browser has one.

Tests: `cd app && npm test` (vitest), `e2e/app.spec.ts`,
`e2e/feed.spec.ts`, `e2e/listen.spec.ts`, `e2e/ask.spec.ts` and
`e2e/ask-control.spec.ts` (with a scripted concierge),
`e2e/voice.spec.ts` (with a fake speaches) and `e2e/you.spec.ts` at 390
and 1440 px. `bun run eval:concierge` is the paid eval of the real
concierge (`--suite basic` or `--suite control`, both by default; the
control suite's 41 requests report a pass rate per category);
`bun run eval:stt` checks the real speaches on five fixture
notes (word error rate at most 15%, `eval/fixtures/stt/`);
`bun run eval:ask-schedules` checks Ask's schedule actions (see
Schedules below).

## Pipelines

A pipeline is a saved step graph (`src/core/pipeline-runner.ts`,
`docs/SDD-pipelines.md`). The Pipelines page lists them with **Run**,
**Edit** and **Add schedule**, and each one's next scheduled run (see
[Schedules](#schedules)). The editor opens inside the board (`#/pipelines/new`,
`#/pipelines/edit/<id>`) and needs `pipeline-editor/dist/` built (see
above). `src/core/review-handoff-pipeline.ts` and
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

## Configuration

### Environment variables

Flags accept `1` or `true`; anything else is off.

| Variable | Default | What it does |
|---|---|---|
| `WISSEL_ORCHESTRATOR` | off | Route new cards automatically. |
| `WISSEL_EXECUTE_WRITE_TIER` | off | Run write-tier agents locally in a worktree instead of handing them off. Only matters with `WISSEL_ORCHESTRATOR`. |
| `WISSEL_MAX_CONCURRENT_TASKS` | unlimited | Cap on tasks the automatic sweep runs at once. Manual **Run** ignores it. |
| `WISSEL_SWEEP_SPEND_CEILING_USD` | unlimited | Stop the automatic sweep once recorded spend for the current UTC day reaches this. |
| `WISSEL_MEMORY_CURATION` | off | Periodically distill session history into `memory/lessons.md`. |
| `WISSEL_MEMORY_INTERVAL_HOURS` | 24 | How often curation checks if it's due. |
| `WISSEL_MEMORY_INJECTION` | off | Add `memory/lessons.md` to every claude-cli/codex-cli prompt. Curation keeps running either way. |
| `WISSEL_REMOTE_CONTROL` | on | Every claude-cli card run (board cards and pipeline steps, not Ask) gets a Remote Control session you can follow and steer from claude.ai/code or the Claude app. The live output shows the link. `0` turns it off. |
| `WISSEL_WRITE_SANDBOX` | on | Run write-tier Bash inside Claude Code's OS sandbox when the startup preflight finds it can start (see "One-time host setup"). `off` (or `0`/`false`) forces the allowlist mode. |
| `WISSEL_MEMORY_PATH` | `memory/lessons.md` | Lessons file location. |
| `WISSEL_AUTO_ARCHIVE` | off | Archive `done` cards 24h after `doneAt`. |
| `WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS` | 1 | Auto-archive check interval. |
| `WISSEL_MODEL_REFRESH` | off | Refresh the model catalog (valid model ids per harness). |
| `WISSEL_MODEL_REFRESH_INTERVAL_HOURS` | 24 | Model catalog refresh interval. |
| `WISSEL_MODELS_CACHE_PATH` | `~/.wissel/models-cache.json` | Model catalog cache. |
| `WISSEL_MERGE_HEALTH` | off | Detect repos left mid-merge (`.git/MERGE_HEAD`) and show a banner. Never auto-resolves. |
| `WISSEL_MERGE_HEALTH_INTERVAL_HOURS` | 1 | Merge-health check interval. |
| `WISSEL_PORT` | 8787 | HTTP port. |
| `WISSEL_DB_PATH` | `~/.wissel/board.sqlite` | Board database. |
| `WISSEL_TELEMETRY_PATH` | `~/.wissel/telemetry.jsonl` | Per-run cost and outcome log. |
| `WISSEL_HARNESSES_PATH` | `harnesses.yaml` | Harness manifest. |
| `WISSEL_MCP_SERVERS_PATH` | `mcp-servers.yaml` | MCP server registry. |
| `WISSEL_TTS_URL` | `http://127.0.0.1:8880` | Local Kokoro-FastAPI service the "Make audio" pipeline step calls. |
| `WISSEL_TTS_VOICE` | `af_heart` | Kokoro voice for that step. |
| `WISSEL_AUDIO_DIR` | `~/.wissel/audio` | Where each run's MP3 is written and served from; Ask's spoken replies go in its `ask/` folder. |
| `WISSEL_STT_URL` | `http://127.0.0.1:8000` | Local speaches service (OpenAI-compatible speech to text) Ask's voice notes go to. |
| `WISSEL_STT_MODEL` | `Systran/faster-whisper-small` | Whisper model speaches uses (`Systran/faster-whisper-base` if small is too slow). |
| `WISSEL_STT_LANGUAGE` | unset | ISO 639-1 code for voice notes; unset lets Whisper detect it. |
| `WISSEL_CONCIERGE_SCRIPT` | unset | e2e only: Ask's concierge answers from this JSON script (`e2e/fixtures/concierge-script.json`) instead of `claude -p`. Leave unset in real use. |
| `WISSEL_API_URL` | `http://localhost:8787` | Server the CLI (`src/cli.ts`) talks to. |
| `WISSEL_COMMIT` | from git | Commit to report when there's no `.git` (`src/core/version.ts`). |

### `harnesses.yaml`: accounts

A harness is a tool (`claude-cli`, `codex-cli`, `anthropic-api`) plus an
account. At startup wissel auto-detects every authenticated `~/.claude*`
profile, `~/.codex`, and every `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_<NAME>`
in the environment (`src/core/harness-discovery.ts`), then layers
`harnesses.yaml` on top: an entry with the same id overrides the detected
one. Manual entries are re-checked and reported disabled if not
authenticated on this machine.

Per harness: `enabled`, `model` (default model for runs on it), and
`maxConcurrent` (at the cap it counts as busy). Enable, disable and set
the model from Setup > Harnesses (`POST /harnesses/:id/enable`,
`/disable`, `/model`); changes are written back to `harnesses.yaml`.
Disabling stops new work only. See `docs/SDD-execution-harnesses.md`,
`docs/SDD-harness-enable-disable.md`.

### `agents/manifest.yaml`: the fleet

Each agent declares `tier` (`readonly` or `write`), `executor`, `tags`,
`whenToUse`, `handoffs`, `trustLevel`, `autoMerge`, and
`costProfile.model`. Optional `harnesses: [id, ...]` is an ordered
preference: each run takes the first listed harness that is enabled and
under capacity, otherwise the task waits. It never runs on an unlisted
harness. A card's `harnessOverride` wins over the list. An unknown id, or
a harness of the wrong tool, stops startup
(`docs/SDD-agent-harness-preference.md`).

`toolAccess` takes `read`, `write`, `bash` and `web`. `web` gives a
`tier: readonly`, `executor: readonly` agent WebSearch and WebFetch, still
in plan mode; on any other agent it stops startup
(`docs/SDD-ai-news-podcast.md` §3.1).

Model per run (`src/core/model-resolution.ts`): `task.model`, else the
harness's `model`, else the agent's `costProfile.model`
(`docs/SDD-model-selection.md`).

### `mcp-servers.yaml`: tools agents can reach

Registry of MCP servers (stdio or http) with per-tool `trust`. Managed
from Setup > MCP servers (`/mcp-servers`). A tool call marked
`approval-required` shows up in Needs you for approve/deny
(`docs/SDD-mcp-orchestration.md`, `docs/SDD-mcp-server-registration.md`).
The checked-in file registers none.

## Known gaps

- Only write-tier Bash is sandboxed (`docs/SDD-write-tier-sandbox.md`);
  Claude's own file tools, readonly runs and codex runs are not.
- Deleting a task does not remove its worktree. It stays under
  `~/.wissel/worktrees/` until cleaned up by hand.

## Docs

- `docs/HANDOVER-2026-09-17.md`: current spec on the router/execution
  boundary. Supersedes `docs/HANDOVER.md`.
- `docs/SDD-worktree-isolation.md`: worktrees, merge and discard.
- `docs/SDD-review-handoff.md`: reviewer loop and status machine.
- `docs/SDD-pipeline-automation.md`: unattended mode, concurrency and spend caps, 429 retry.
- `docs/SDD-crash-recovery.md`: restart recovery, merge health.
- `docs/SDD-pipelines.md`, `docs/SDD-ui-cleanup.md`: pipelines and the board UI.
- `docs/SDD-wissel-app.md`: the app at `/app`.
- `docs/SDD-memory-curator.md`, `docs/SDD-memory-injection-toggle.md`: memory.
- `docs/SDD-task-archiving.md`, `docs/SDD-version-info.md`, `docs/SDD-live-task-output.md`.
- `docs/SDD-remote-control.md`: every card run as a claude.ai Remote Control session.
- `docs/SDD-write-tier-sandbox.md`: write-tier Bash in Claude Code's OS sandbox, denial counting, project allow rules.
- `docs/SDD-schedules.md`: schedules for pipelines and tasks, and "Start at" for a card; §7 is the switch-over from systemd.

## License

MIT. Copyright (c) 2026 Milton Cyrus. See [LICENSE](LICENSE).
