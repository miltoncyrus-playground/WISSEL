# Configuration

## Environment variables

Flags accept `1` or `true`; anything else is off.

| Variable | Default | What it does |
|---|---|---|
| `WISSEL_ORCHESTRATOR` | off | Route new cards automatically. |
| `WISSEL_EXECUTE_WRITE_TIER` | off | Run write-tier agents locally in a worktree instead of handing them off. Only matters with `WISSEL_ORCHESTRATOR`. |
| `WISSEL_MAX_CONCURRENT_TASKS` | unlimited | Cap on tasks the automatic sweep runs at once. Manual **Run** ignores it. |
| `WISSEL_AUTO_CHAIN` | off | Run only the review and rework loop on its own: a card in a review lineage (a review, or the rework a reviewer asked for) is routed and run, write tier included; every other card waits for a human **Run**. Ignored when `WISSEL_ORCHESTRATOR` is on. `docs/SDD-auto-chain.md`. |
| `WISSEL_PARALLEL_HINT` | off | `1` adds a paragraph to every claude-cli run's prompt asking for independent reads and checks in one turn and parallel read-only sub-agents. See `docs/SDD-parallel-hint.md`. |
| `WISSEL_AUTO_MERGE` | on | `0`, `off`, `false` or `no` stops an approved review from landing its card by itself (the reviewer agent's `autoMerge`): the card waits in `review` for a human **Merge**. `docs/SDD-merge-target.md`. |
| `WISSEL_INTEGRATIONS_PATH` | `integrations.yaml` | Where the ticket tracker config is read from. The env vars it names (`JIRA_EMAIL`, `JIRA_API_TOKEN` in the example) hold the credentials. See "Git and tickets". |
| `WISSEL_REVIEW_GUARD` | off | `1` checks what a write-tier card actually changed before handing it to the reviewer: a worktree with no changes goes straight to `review` for a human (no reviewer, so a report-only card can't loop on pushbacks), and a rework whose diff is identical to what the last review saw escalates instead of being reviewed again. Empty sandbox stub files don't count as changes. |
| `WISSEL_SWEEP_SPEND_CEILING_USD` | unlimited | Stop the automatic sweep once recorded spend for the current UTC day reaches this. |
| `WISSEL_MEMORY_CURATION` | off | Periodically distill session history into `memory/lessons.md`. |
| `WISSEL_MEMORY_INTERVAL_HOURS` | 24 | How often curation checks if it's due. |
| `WISSEL_MEMORY_INJECTION` | off | Add `memory/lessons.md` to every claude-cli/codex-cli prompt. Curation keeps running either way. |
| `WISSEL_REMOTE_CONTROL` | on | Every claude-cli card run (board cards and pipeline steps, not Ask) gets a Remote Control session you can follow and steer from claude.ai/code or the Claude app. The live output shows the link. `0` turns it off. |
| `WISSEL_WRITE_SANDBOX` | on | Run write-tier Bash inside Claude Code's OS sandbox when the startup preflight finds it can start (see "One-time host setup" in [Getting started](getting-started.md)). `off` (or `0`/`false`) forces the allowlist mode. |
| `WISSEL_MEMORY_PATH` | `memory/lessons.md` | Lessons file location. |
| `WISSEL_AUTO_ARCHIVE` | off | Archive `done` cards 24h after `doneAt`. |
| `WISSEL_ARCHIVE_CHECK_INTERVAL_HOURS` | 1 | Auto-archive check interval. |
| `WISSEL_MODEL_REFRESH` | off | Refresh the model catalog (valid model ids per harness). |
| `WISSEL_MODEL_REFRESH_INTERVAL_HOURS` | 24 | Model catalog refresh interval. |
| `WISSEL_MODELS_CACHE_PATH` | `~/.wissel/models-cache.json` | Model catalog cache. |
| `WISSEL_MERGE_HEALTH` | off | Detect repos left mid-merge (`.git/MERGE_HEAD`) and show a banner. Never auto-resolves. |
| `WISSEL_MERGE_HEALTH_INTERVAL_HOURS` | 1 | Merge-health check interval. |
| `WISSEL_PORT` | 8787 | HTTP port. |
| `WISSEL_BIND` | `127.0.0.1` | Address the board listens on. Anything outside loopback refuses to start without `WISSEL_ALLOW_OPEN_BIND=1`. |
| `WISSEL_ALLOW_OPEN_BIND` | off | Allow a non-loopback `WISSEL_BIND` without sign-in: start-up warns and raises an owner task. Not needed with `WISSEL_AUTH=tokens`. |
| `WISSEL_AUTH` | off (single owner) | `tokens` turns sign-in on: every request but health, version and the sign-in page needs a session or an API token (see [Sign-in and permissions](sign-in-and-permissions.md)). |
| `WISSEL_PUBLIC_URL` | `http://localhost:<port>` | The board's address as people reach it: the base of the bootstrap link, and `https://` makes the session cookie `Secure`. |
| `WISSEL_TOKEN` | unset | The CLI's API token when sign-in is on (sent as `Authorization: Bearer`). |
| `WISSEL_HOST_GUARD` | off | `1` turns on the host guard: new cards are held while the host is short of room, and an owner task says why. |
| `WISSEL_HOST_GUARD_LOAD_PER_CORE` | `3` | Hold when the 1-minute load reaches this many per core. |
| `WISSEL_HOST_GUARD_MIN_MEMORY_PCT` | `20` | Hold when less than this share of memory is available. |
| `WISSEL_HOST_GUARD_MIN_DISK_GB` | `30` | Hold when the disk under `~/.wissel` (worktrees) has less free than this. |
| `WISSEL_HOST_GUARD_MIN_TEMP_GB` | `2` | Hold when a project's temp directory (its `env.TMPDIR`, else the system's) has less free than this. |
| `WISSEL_HARD_LIMITS_PATH` | `hard-limits.yaml` | The coordinator's hard limits, read once at start: `production` (`accounts`, `clusters`, `hosts`, patterns with `*`) and `readOnlyRepos`. Missing means only the built-in limits. |
| `WISSEL_CHANNEL_INTERVAL_MS` | `900000` (15 min) | How often each workstream's pending channel messages are posted, as one scribe run per workstream. `0` posts only on `POST /workstreams/:id/channel/flush`. |
| `WISSEL_OWNER_COMMENTS` | on | `0` stops the daily read of each workstream's `reviewDoc` for owner comments (checked hourly, one read-only scribe run per doc a day). |
| `WISSEL_CHANNEL_READ_MS` | `0` (off) | How often the channel is read back for other people's entries (one scribe run per workstream each time); they land in the inbox as untrusted `channel.entry` events. |
| `WISSEL_PR_WATCH` | on | `0` stops the PR watcher, which reads every delivered card's PR once a minute with `gh` (read-only). |
| `WISSEL_SUPERVISOR` | unset | `script` when `bun run serve:supervised` started Wissel (the script sets it). With it, or under systemd, `POST /admin/restart-when-idle` is allowed; with neither it is refused. |
| `WISSEL_OWNER_HANDLE` | the OS user | Handle of the single-owner principal every action is attributed to (`GET /me`, `GET /audit`). Read once, on the first start against a database. |
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

## `harnesses.yaml`: accounts

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

Whose account it is: `ownerPrincipalId` names a principal (`owner` is
the instance owner, see `GET /me`), and `shared: true` lets others use
it. A harness with an owner and no `shared` runs only cards its owner
authorized; anyone else's card waits for one it may use. No owner means
anyone's, as before. Each run's telemetry names its harness and
principal, `bun run usage:report` splits spend by both, and a 429, an
exhausted balance or a lapsed sign-in is logged as a `harness.limit`
event naming the owner (`docs/SDD-identity-and-permissions.md` §4.7).

## `agents/manifest.yaml`: the fleet

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

## `mcp-servers.yaml`: tools agents can reach

Registry of MCP servers (stdio or http) with per-tool `trust`. Managed
from Setup > MCP servers (`/mcp-servers`). A tool call marked
`approval-required` shows up in Needs you for approve/deny
(`docs/SDD-mcp-orchestration.md`, `docs/SDD-mcp-server-registration.md`).
The checked-in file registers none.

## `integrations.yaml`: the ticket tracker

Optional, git-ignored; copy `integrations.example.yaml`. Names a Jira site
and the environment variables holding the email and API token, an optional
project filter, and `writeBack`. Only the first entry is used. Setup is
walked through in [Git and tickets](git-and-tickets.md).

---

[Back to the README](../../README.md)
