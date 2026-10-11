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
bun run eval:memory-curation-quality
bun run eval:claude-cli-429-replay
bun run eval:ai-news
bun run eval:world-news
```

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
`running`, and finishes review verdicts a restart interrupted
(`src/core/crash-recovery.ts`, `docs/SDD-crash-recovery.md` §9, §10).

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
   (`src/core/orchestrator.ts`, `docs/SDD-review-handoff.md`).
7. **Merge.** On approve, an agent with `autoMerge: true` and
   `trustLevel: high` is merged with `git merge --no-ff` into whatever is
   checked out in the task's repo, and the card moves to `done`.
   implementer has this on. Without it, or on a merge conflict, the card
   stops at `review` for a human **Merge** or **Discard**
   (`POST /tasks/:id/merge`, `/discard`).
   An implementer may run only `bun test` and `bun run typecheck`
   unless the card grants more: `extraAllowedTools` on `POST /tasks`, or
   `POST /tasks/:id/allowed-tools` (command-scoped Bash only, e.g.
   `Bash(bun install:*)`; see `src/core/allowed-tools.ts`).

A planner card ends in a `subtask-plan` block that the orchestrator turns
into real child cards. When every child has landed, an integrator card is
created to check they fit together.

A claude-cli session limit (429) reschedules the task for the reset time
in the error text instead of failing it (`docs/SDD-pipeline-automation.md`
§3.2).

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
  (running, needs you, landed today). Screens are hash routes
  (`#/feed`, `#/ask`, ...); `/app` opens Ask.
- **Command palette.** Cmd-K or Ctrl-K (or the search button): jump to a
  screen, open a card by title, run a pipeline by name, New card.
- **Board tab.** Running, Needs you, Review and Done today from `/tasks`,
  a read-only card view at `#/board/<id>`, and a link to the full board.
- **Live.** One shared `EventSource('/events')` keeps every screen
  current.
- **Look.** Dark design tokens in `app/src/tokens.ts` (contrast checked
  by a unit test), self-hosted fonts (Bricolage Grotesque, Geist, Geist
  Mono via `@fontsource`): no internet needed on the LAN.
- **Feed.** What happened, newest first, from `GET /feed?limit=&before=`
  (`src/services/feed.ts`, pure `buildFeed`): cards that landed, cards
  that need you (review, escalated, failed with Retry, no match, an MCP
  approval with Approve, a card held for a switched-off harness),
  podcasts with a player, their `check-news-run` results, and each past
  day's spend by harness. Updates live over `/events`; "Load more" pages
  back.
- **Stories.** Rings for the last 24 hours (AI news, World, Needs you,
  Landed, Your week). A ring opens a full-screen viewer: tap or swipe
  left/right, arrow keys, swipe down or Escape to close. Watched rings go
  grey (kept in `localStorage`).
- Ask, Listen and You are placeholders until their cards land
  (`docs/SDD-wissel-app.md` §6).

Tests: `cd app && npm test` (vitest), `e2e/app.spec.ts` and
`e2e/feed.spec.ts` at 390 and 1440 px.

## Pipelines

A pipeline is a saved step graph (`src/core/pipeline-runner.ts`,
`docs/SDD-pipelines.md`). The Pipelines page lists them with **Run** and
**Edit**. The editor opens inside the board (`#/pipelines/new`,
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
| `WISSEL_AUDIO_DIR` | `~/.wissel/audio` | Where each run's MP3 is written and served from. |
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

- No sandboxing beyond what the agent CLI itself does.
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
