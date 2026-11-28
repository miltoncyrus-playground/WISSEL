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
| `bun run live-check:sandbox` | Real `claude -p` write-tier run with the Bash sandbox on: piped Bash works; writes outside the worktree, `~/.ssh` reads, off-allowlist hosts and `git commit` don't; a host the project configured (`sandboxAllowedDomains`) is reachable and an unconfigured one is not. Skips when the sandbox can't start. |
| `bun run live-check:sandbox-postgres` | Real `claude -p` write-tier run that starts a vendored PostgreSQL 18 inside the Bash sandbox: `docker ps` and unix sockets fail, the stock config fails, a TCP-only server on 127.0.0.1 starts and passes row-level-security checks (FORCE RLS, transaction-local `set_config`), and is gone in the next Bash call. Downloads the binaries from the npm registry once (60 MB, cached in the OS temp dir). Skips when the sandbox can't start. See `docs/SDD-sandboxed-postgres.md`. |
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

Sandboxed Bash can reach `registry.npmjs.org` and `github.com`; every
other host is refused. A project that needs more (a Python or Terraform
repo) names its hosts once with `POST /projects/:id/settings
{"sandboxAllowedDomains": ["pypi.org", "files.pythonhosted.org",
"registry.terraform.io", "releases.hashicorp.com"]}`; they are appended
to the fixed two for every write-tier run on that repo, read per run,
no restart. Nothing is hardcoded per language. A project with no setting
gets exactly the fixed two.

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
     there (edits only; its sandbox can't commit). Merge again after:
     Wissel commits the resolution itself once no file has a conflict
     marker and that integrator card has finished, then gates and lands
     it. Otherwise the refusal names the file and line, or the card and
     its status. If the repo's HEAD moved again meanwhile and the merge
     conflicts once more, that is a new conflict and gets a new
     integrator card (one per conflicting HEAD, the sha on the card's
     first line; clicking Merge twice on the same conflict spawns
     nothing). After 3 integrator cards the card escalates instead, and
     its escalation context says a human must resolve it. Resolving by
     hand always works: `git commit --no-edit` in the worktree, then
     Merge.
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
   `docs/SDD-project-settings.md`. `verification` is live: a write-tier
   run in that repo is told to run those commands and may run those
   grants instead of the Bun defaults (`docs/SDD-project-settings.md`
   §7). `sandboxAllowedDomains` is live: a write-tier run on that repo
   gets those hosts added to the sandbox's network allowlist
   (`docs/SDD-write-tier-sandbox.md` §11). `worktreeSetup` runs once in
   each new worktree, in order, before the agent starts (10 minutes per
   command). A failure fails the card with the command's last 200 output
   lines; reviewer, fixer and integrator runs on the same worktree skip
   it (`docs/SDD-worktree-isolation.md` §8). `protectedPaths` is stored
   only for now.
   An implementer may run only the project's verification commands
   (`bun test` and `bun run typecheck` when the project sets none)
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

A card can carry a short `key` such as `A4`, on `POST /tasks` or
`PATCH /tasks/:id` (`null` clears it). It is unique per project among
live cards, and every attempt and review of the same work keeps it.
`round` counts the attempts in a review lineage: 1 first, one more per
pushback, and a review carries the round it reviews. `POST /tasks/:id/pr
{pr: {number, url, head}}` records the pull request the work became,
with `head` as the full commit sha (`null` clears it)
(`docs/SDD-coordinator.md` §3.3).

A project can keep `cardRules`, text appended under "Project rules:" to
the body of every card started with `POST /tasks` in its repo. It can
also keep `cardTemplates`, a markdown brief per kind (`coder`, `review`,
`fix-round`, `split-only`, `merge-forward`) with placeholders such as
`{ticket}` (required) or `{notes?}` (optional). Write `{{` and `}}` for
literal braces. Set both with `POST /projects/:id/settings`.
`POST /tasks {template: "fix-round", fields: {...}}` renders the brief
from `fields` and the card's own `key`, `title` and `body`. It refuses
the card, creating nothing, when a required placeholder is empty or the
brief comes out over 2,500 characters (`src/core/card-templates.ts`,
`docs/SDD-coordinator.md` §4.16).

A project's `env` setting (`POST /projects/:id/settings {env: {"TMPDIR":
"/data/tmp"}}`, at most 20 entries) is added to its card runs, its merge
gate and its worktree setup. Use it for a temp directory or cache on a
disk with room. A harness's own variables stay on top, so a project can't
redirect an account. Names that are Wissel's own settings (`WISSEL_*`),
account or tool config (`CLAUDE_*`, `ANTHROPIC_*`, `CODEX_*`,
`OPENAI_*`), what runs (`PATH`, `HOME`, `GIT_*`, `LD_*`, `NODE_OPTIONS`)
or anything that looks like a credential (`*TOKEN*`, `*SECRET*`,
`*PASSWORD*`, `*_KEY`) are refused: the board never holds a secret.

A project's `delivery` setting decides how a finished card lands. Unset,
or `{"mode": "local-merge"}`, merges it into your checkout as before.
`{"mode": "pull-request", "branchPattern": "feat/{key?}-{slug}",
"hostGates": [["bun", "run", "test:e2e"]], "gateRetries": 1, "draft":
true}` turns Merge into delivery:
1. fetch the remote's main branch (`base`, default the card's
   `mergeTarget` or the checked-out branch; `remote`, default `origin`)
   and build the landing commit against it;
2. run the merge gate, then the host gates, re-running a failed command
   once with `gateRetries: 1`;
3. only if all pass, push to the card's own branch and open a PR, or
   reuse the open one.

The PR is recorded on the card. The PR body ends with the card id, the
principal behind it and the policy revision. Your checkout is never
touched and the card's worktree is kept. Pushes are never forced: a
rejected push stops and reports. The branch can never be the main branch
or another long-lived one. PRs are opened with `gh`, as the account it
is signed in as (`src/services/delivery.ts`, `docs/SDD-coordinator.md`
§4.5).

A project's `reviewPolicy` (`{"maxRounds": 2, "blocks": ["HIGH"],
"atCap": "spec-question"}`) shapes its review loop:
- The reviewer's verdict may carry `severity` counts (`high`, `med`,
  `medWithScenario`, `low`). An approval with a severity listed in
  `blocks` becomes a fix round that says why.
- `maxRounds` replaces the default cap of 5. At the cap, `atCap` decides:
  `ask-decider` (the default) and `spec-question` escalate with their
  own note, and `accept` moves the work to review for you to merge.
- When the project has a `fix-round` card template, each fix round's
  whole brief is rendered from it with `{review}` (the full review
  text), `{round}`, `{key}`, `{title}` and `{body}` (the first
  attempt's brief), then the project rules. A review with no text
  refuses the round and escalates (`docs/SDD-coordinator.md` §4.6).

Once a minute the PR watcher looks at every card delivered as a PR,
until the PR is merged or closed. It reads, with `gh pr view` (read-only):
- the checks, and the head commit they ran on;
- whether the PR can merge: clean, dirty, blocked or behind;
- whether auto-merge is armed;
- whether it is merged or closed.

What it sees is kept on the card as `pr.watch`, so the card's life
carries on past done:
- `landed`: the PR is open;
- `ready`: it is the reviewed head on the main branch, every check is
  green and nothing is in the way;
- `merged`, or `closed` without merging.

Each change is logged and recorded as a `pr.changed` telemetry event.
`armBlockedBy` says why the PR may not be armed for auto-merge yet. The
watcher never arms one: that waits for roles (`docs/SDD-coordinator.md`
§4.13). `GET /admin/pr-watch` lists the watched cards, and `POST` looks
again now (`src/services/pr-watcher.ts`, §4.7).

When the watcher sees a PR go dirty (main moved on and now conflicts),
it starts one **Merge forward** card for it, never two. That card
delivers the original card again, merging the freshly fetched main:
- A clean merge is gated and pushed as a fast-forward to the same branch,
  the open PR is reused and the card's PR head moves on.
- A conflict is left in the card's worktree for a conflict integrator
  card. The merge-forward card waits in review, and runs again once the
  integrator has finished.

Every delivery moves the card's branch to what it pushed, so a later fix
round is never a rejected push (`src/services/merge-forward.ts`).

A card can wait on start conditions (`waitsFor`, on `POST /tasks` or
`PATCH`, at most 10). The sweep leaves it alone until every one holds,
as it does for `dependsOn`:
- `{"kind": "card-done", "cardId": ...}`
- `{"kind": "pr-merged", "repo": "org/repo", "number": 12}` (asked of
  `gh` at most once a minute)
- `{"kind": "path-on-main", "repo": "/path/to/checkout", "path":
  "db/schema.sql"}`

A card can also name the files its work will touch (`files`). When it is
created, and again just before it starts, Wissel warns when another open
card, or a delivered card whose PR is still open, names the same files
or a folder holding them. The warning goes to the log, to a
`card.overlap` telemetry event and to `overlaps` in POST /tasks's
answer. It never blocks the card (`src/services/start-conditions.ts`,
`docs/SDD-coordinator.md` §4.8).

A workstream is one piece of team work across projects (`POST
/workstreams {name, ticket?, spec?, projects, channel?, chat?,
quietHours?, digests?}`; `GET`, `PATCH` and `DELETE` on
`/workstreams/:id`). A project is in at most one workstream. Each
project in it has:
- a `role`:
  - `shadow`: record only;
  - `follow`: work to a decider's answers;
  - `decide`;
  - `decide-over`;
- an optional `decider`;
- `decideAlone`: the decision kinds it may take by itself;
- `mustAsk`: always asked;
- `never`: actions refused outright.

A role changes only through `POST
/workstreams/:id/projects/:projectId/role {role}`. The first call answers
409 with what would change, and the same call with `"confirm": true`
applies it. Only the owner may make it. Every workstream or role write is
a policy revision.

A card may name its `workstreamId`. Within a workstream a card's `key` is
unique across all its projects. A workstream with open cards can't be
deleted. This is the model and the API: the policy gate that reads roles
comes with card 14 (`src/services/workstreams.ts`,
`docs/SDD-coordinator.md` §3.1, §4.13).

Every coordinator trigger goes through one persisted inbox:
- a card reaching review, failed or escalated;
- a PR's checks finishing, the PR going dirty, ready, merged or closed;
- the host guard holding;
- a message you send with `POST /inbox {text, workstreamId?}`.

Each event has a source-stable id, so seeing it again is a no-op. Its
timestamp is the server's, never one an agent wrote. Payloads from the
code host, a channel or a tracker are marked untrusted. A dispatcher
hands events to a handler per kind, oldest first. One that throws is
retried once and then marked failed. Most kinds are recorded only until
the gate and decision cards take them. `GET /inbox?unhandled=1&
workstream=<id>` and `GET /workstreams/:id/inbox` list them
(`src/services/inbox.ts`, §4.1).

Everything the coordinator does goes through one policy gate
(`src/services/policy-gate.ts`, §4.2). It is a pure function answering
allow, ask the decider, ask the owner, queue or deny, and the first
matching rule wins:
1. a hard limit;
2. the project's `never` list;
3. a duty an external coordinator owns;
4. Shadow (record only);
5. quiet hours, which queue outward actions;
6. `mustAsk`;
7. the role table, with `decideAlone` for decisions;
8. otherwise, ask the owner.

The hard limits are code plus `hard-limits.yaml`, never set from a
channel or a card. They deny:
- production targets you list;
- read-only repos;
- pushing to main or another long-lived branch;
- arming a PR whose base isn't main, or whose checks aren't green;
- posting outside the workstream's channel and chat.

Every decision goes to an append-only gate log (`GET
/workstreams/:id/gate-log`). A property test over random actions checks
that nothing a deny rule matches is ever allowed.

The executor does what the gate allows and nothing else (`POST
/workstreams/:id/actions {action}`, `src/services/executor.ts`, §4.3):
- **Allowed:** a performer for the kind runs it. Card start, owner task,
  restart when idle and merge-forward exist. Channel, chat and tracker
  posts arrive with their adapters, and until then such an action
  answers `unsupported`.
- **Shadow:** recorded only.
- **Ask:** raises an owner task naming who should decide.
- **Deny:** says which rule refused it.
- **Queue (quiet hours):** the action waits in a persisted outbound
  queue (`GET /workstreams/:id/outbound`), with its flush time. Each
  minute the queue is decided again, oldest first, so a rule changed
  overnight still applies. A queued push goes through the merge path
  and its gates again.

Judgment runs as short decision cards (`src/services/decisions.ts`,
§4.4). A card labelled `decision` goes to the read-only `decider` agent.
Its brief fences the context as untrusted data, and its answer must end
with a ` ```decision ` block that fits its kind's schema. The decider
only proposes; the answer is one gated action, so the role decides what
happens. The kinds:
- **`plan-batch`:** proposes cards, each started as its own gated card.
- **`decide-default`:** a default with its alternative and lean, kept
  as a Decision you can flip (`GET /workstreams/:id/decisions`, `POST
  /decisions/:id/flip`).
- **`triage-red`:** `retry` (deliver again), `fix-round` (back with the
  reason) or `spec-question` (an owner task).

A `follow` project turns the same answer into a question for its decider.
A workstream card whose PR checks go red starts a `triage-red` on its
own. `POST /workstreams/:id/decisions/start {kind, context, projectId?,
subjectId?}` starts one by hand.

A workstream's channel is where its decisions show up for people
(`src/services/channel.ts`, §4.9). Wissel stays authoritative: an
allowed `channel.post` adds a message to Wissel's channel outbox, and the
workstream's adapter copies the batch out once per interval. Message
kinds: claim, release, ready-to-merge (with the full head sha), question
(options and a lean), answer, decision, status and handover.

The first adapter is `claude-docs`, with the workstream's `channel`
being `{adapter: "claude-docs", target: <doc link>}`. Its scribe is one
short `claude -p` run per batch on the first enabled claude-cli account,
allowed only the Claude Docs tools. It appends the lines to the doc and
returns the block id of each, which Wissel records. An empty outbox
starts no run, a failed run leaves the batch pending, and a line the
scribe didn't confirm is marked failed. `GET /workstreams/:id/channel`
shows the outbox, and `POST .../channel/flush` posts now. Reading the
channel back is off unless `WISSEL_CHANNEL_READ_MS` is set.

A workstream's `ticket` follows its cards (`src/services/tracker-rules.ts`,
§4.10). Its decision, review and merge-forward cards don't count. The
ticket moves forward only, once per stage:
- "in progress" when its first card starts;
- "in review" once every card is an open PR;
- "done" once all are merged.

Each move is a gated `ticket.transition` plus one `ticket.comment` naming
the merged PRs. Both write only when the tracker's `writeBack` is on. It
stays off for now, so a move is decided and logged but nothing is
written. With a tracker set up, a workstream needs its ticket before its
first card.

Chat is a Slack adapter for `chat.post`, which posts only to the
workstream's `chat` channel. Set it up in `integrations.yaml`:

```yaml
chat:
  kind: slack
  tokenEnv: TEAM_SLACK_BOT   # the variable's NAME; the token is never stored
```

A workstream's `digests` (cron and timezone) send a fixed digest built
from Wissel's own numbers, with no model call:
- live cards against the cap;
- PRs by state;
- what waits on the decider;
- open owner tasks;
- what quiet hours are holding;
- host load, memory and disk.

It goes through the gate to the workstream's chat, else as a status line
on its channel, so quiet hours queue it. A restart never sends a backlog.
`GET /workstreams/:id/digest` previews it, and `POST` sends it now
(`src/services/digests.ts`, §4.11).

While a team moves from an external coordinator to Wissel, each duty
switches over on its own (`src/services/duties.ts`, §4.13). The duties
are status, host, landing, review, channel-read, claims, ready-to-merge
and arming. A duty the external coordinator still owns is denied by the
gate, so nothing is done twice. `GET /workstreams/:id/duties` lists
them, and `POST /workstreams/:id/duties/:duty {owner: "external" |
"wissel"}` switches one.

**Shadow** (`POST /admin/shadow {on}`) runs the whole coordinator
record-only. The gate allows in shadow mode and nothing acts. `GET
/workstreams/:id/shadow-report` sets what Wissel would have done beside
what actually happened: channel entries, PRs opened, armed and merged.

Both switches are owner only, take a confirm step (the first call
answers 409 with what would change, `"confirm": true` applies it), and
each is a policy revision.

A team that already has a coordinator imports its state with `POST
/workstreams/:id/import` (owner only, a policy change;
`src/services/import.ts`, §7). Import creates nothing:
- `items`, as JSONL or a list of `{key, cardId?, pr?, sha?, round?}`,
  match cards already on the board, by id or by key in the workstream.
  A match gets its key, workstream, round and PR (which needs the full
  head `sha`). A different existing key or PR, or a key another card
  already uses, is reported as a conflict and left alone.
- `rules {projectId, cardRules?, cardTemplates?}` become that project's
  settings.
- `channelCursor` is where channel reading starts.
- `schedule {digests?, quietHours?}` goes onto the workstream.

`"dryRun": true` reports all of it and changes nothing. Then: Shadow for
a day or two, and hand over one duty at a time.

Each curated lesson in `memory/lessons.md` gets a scope, the first line
under its `##` heading (`src/services/lessons.ts`, §4.15):
- **`Scope: wissel`:** a problem with Wissel's own environment.
  Approving it raises an owner task to file it as an issue. It never
  becomes a prompt line.
- **`Scope: project`:** a standing rule. Approving it with a `projectId`
  appends it to that project's `cardRules`, and nothing is applied
  without that approval.
- **`Scope: path:<glob>`:** code knowledge for an area. It matches a
  card through the card's planned `files` (`GET /tasks/:id/lessons`).

`GET /lessons` lists the lessons, `GET /lessons/proposals` the owner's
proposals, and `POST /lessons/:key/approve` or `.../reject` decides one
(owner only). Prompt injection stays as `WISSEL_MEMORY_INJECTION` says:
scoped lessons aren't injected yet.

On its own, through the gate, Wissel posts a **claim** to a workstream's
channel when one of its cards starts, and a **ready-to-merge** (with the
full head) when its PR becomes ready. In Shadow those are would-records,
and the **replay eval** (`bun run eval:replay [day.jsonl
coordinator.json]`, `src/services/replay.ts`, §8) measures them. It runs
a recorded day (cards, moves, PR states, channel entries) through an
in-memory Wissel in Shadow. It then compares the would-records with what
the team's coordinator did: ready-to-merge agreement (target 95%),
claims, and would-be hard-limit violations (target zero). The bundled
day is an invented example; a team's own recording uses the same
shapes.

An owner task is something only the owner can do, such as signing in
again or freeing a disk. `POST /owner-tasks {title, why, steps, check?,
blocks?}` raises one: a card labelled `owner` shows in Needs a human
with the why and the steps as tick-boxes, and each card in `blocks`
waits on it. `check` is a command as argv, run with no shell. Done
(`POST /owner-tasks/:id/done`) runs the check and closes the task only
if it exits 0. A failed check keeps the task open, with its output under
`lastCheck`. `POST /owner-tasks/:id/dismiss` closes the task without a
check. Closing releases the waiting cards. `GET /owner-tasks?status=open`
lists them (`src/services/owner-tasks.ts`, `docs/SDD-coordinator.md`
§3.4).

To restart without interrupting cards, use `POST /admin/restart-when-idle`.
It stops new work from starting: the sweep, **Run** and pipeline runs all
answer 409 until the restart. Running cards are left to finish. Once none
is running, Wissel exits with code 75, and its supervisor starts it again
on the current code. `GET` on the same path shows whether a restart is
pending, and `DELETE` cancels it. The supervisor can be:
- systemd: `Restart=on-failure` restarts on 75, and adding
  `RestartForceExitStatus=75` makes that explicit;
- `bun run serve:supervised` (`scripts/serve-supervised.sh`), when Wissel
  is started by hand.

With neither, the route is refused, because exiting would leave the board
down. The start-up log says which applies (`docs/SDD-coordinator.md`
§4.12).

The host guard (`WISSEL_HOST_GUARD=1`) reads the host every 30 seconds:
load, available memory, free disk under `~/.wissel`, and free space in
each project's temp directory. While anything is under its threshold
(see the `WISSEL_HOST_GUARD_*` variables), new cards, **Run** and
pipeline runs wait, and running cards carry on. It raises one owner task
saying what is short, naming the largest entries in a full temp
directory and the running cards writing there. Done runs `bun run
host:check`, which passes only once the host has room. The hold lifts by
itself as soon as a reading is healthy. `GET /admin/host-guard` shows
whether it is holding (`src/services/host-guard.ts`).

`bun run usage:report [--since 2026-10-10] [--agent implementer]` shows
where agent spend goes: per agent the runs, cost, turns, context per turn
and output, and what runs cut off by a session limit cost
(`docs/proposal-agent-run-efficiency.md`).

## The board

`src/api/public/board.html`, vanilla JS, no build step
(`docs/SDD-ui-cleanup.md`).

- **Sidebar.** Work: Board, Tickets, Pipelines, Archive. Setup: Agents &
  skills, Harnesses, MCP servers, Projects, Memory, Settings.
- **Top bar.** Project switcher, **+ New**, the account line (one chip per
  enabled harness with what's running on it and which model,
  `GET /status/accounts`), and a version badge (`GET /version`).
- **Needs a human.** Only cards that need a decision (the server's
  `needsYou.lane: "human"`, `src/services/needs-you.ts`): an MCP approval,
  a grant, an escalation, a failed or unmatched card, a review report that
  FAILed, or changes nobody reviewed. Each one says why in full and lists
  the steps as tick-boxes (kept per browser), with its one button.
- **Lanes.** Queued, Working, In review, Next step, Done (last 24h by
  default). Next step holds finished work waiting on one mechanical step:
  an approved merge, a passed review report (Close,
  `POST /tasks/:id/close`), a merge that waits on another. A review in
  flight shows once, in In review, tagged "Review in progress"; the
  reviewer's own card isn't drawn in Working. A
  second view, **By feature**, shows one swimlane per root card with its
  subtasks and follow-ups.
- **Pipeline runs** show as one card with step progress. Clicking opens
  the run drawer; "View on canvas" shows the graph with live step status.
- **Archive.** Archived cards and their subtrees. Auto-archive of `done`
  cards after 24h is behind `WISSEL_AUTO_ARCHIVE`.
- **Tickets.** Every ticket and the work on it across your projects; see
  "Git and tickets" below. Cards also carry a ticket chip.

## Git and tickets

Wissel can show where each registered repo stands and which ticket every
branch and card belongs to. It works on git alone; connecting a Jira Cloud
site adds each ticket's title and status, and lets you comment on or move
a ticket from the board. Design: `docs/SDD-git-jira-visibility.md`.

### 1. Register your repos

Setup > Projects > add a local folder, or clone from GitHub. Cards that
name a repo (`repo` on the card) are matched to the project registered at
that path.

### 2. Say what a ticket key looks like

With nothing set, any `PROJ-123`-shaped key counts. To narrow it, or to
match your own shape, set the patterns per project (regular expressions,
at most 5 each, matched anywhere in a card title or branch name; the
first match wins):

```bash
curl -X POST localhost:8787/projects/<project-id>/settings \
  -H 'content-type: application/json' \
  -d '{"ticketPatterns": ["ABC-\\d+"], "referencePatterns": ["DEC-\\d+"]}'
```

`referencePatterns` finds ids that are not tickets (a decision or spec
number). They show next to a branch as plain labels and never link
anywhere. Send `null` to clear either. Find a project's id with
`curl localhost:8787/projects`. Branch names like `feat/ABC-12-login`
and commit subjects ending `(ABC-12)` need no setup beyond this.

### 3. See it

- **Board > Tickets** (`#/tickets`): a **Checkouts** block with one line
  per repo (branch, clean or changed files, ahead/behind), then one
  section per ticket across all repos with its cards, branches and
  worktrees. Filter by project, or tick **Needs a look** for checkouts
  with changed files, a detached head, a branch other than `main` or
  `master`, or commits behind. Click a card to open it. **Refresh**
  re-reads git; the page never polls.
- **Cards** show a ticket chip, and the card drawer shows Ticket and
  Branch.
- **Setup > Projects**, with a project selected, lists its tickets under
  the status line.
- **The app** (`/app`) Board tab has a Projects section: open a project
  for the same grouping.

Git state is as of each repo's last fetch. Wissel only reads git here: it
never fetches, checks out or pushes.

### 4. Connect Jira (optional)

Wissel talks to Jira Cloud over its REST API with an email and an API
token. (The Claude connector you may use in a Claude session is tied to
that session and cannot be used by the board's server.)

1. Create an API token at
   <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Copy the example config and edit it:

   ```bash
   cp integrations.example.yaml integrations.yaml   # git-ignored
   ```

   ```yaml
   integrations:
     - id: jira
       kind: jira
       site: https://your-team.atlassian.net   # https only
       emailEnv: JIRA_EMAIL                     # NAMES of env vars,
       tokenEnv: JIRA_API_TOKEN                 # never the values
       projectKeys: [ABC]                       # optional filter
       writeBack: false                         # see below
   ```

3. Put the two variables in the environment the server starts in, then
   restart it:

   ```bash
   export JIRA_EMAIL=you@example.com JIRA_API_TOKEN=...
   bun run serve
   ```

   Under systemd, use `EnvironmentFile=` in the unit (a file only you can
   read), not `Environment=` with the token in it.

Startup logs `tickets: jira (write-back off)`, or `tickets: off (<why>)`
(file missing, a variable unset, a bad `site`). The board keeps working
either way, and the Tickets page prints the reason.

Each ticket section then shows its title (linked to Jira), status and
assignee. Lookups are one JQL search per 50 keys and cached for a minute;
if Jira is down the page says so and the git view stays.

### 5. Write back (optional)

Set `writeBack: true` and restart. Each ticket section gains **Comment**
and **Move…**. Nothing is automatic: each action shows exactly what it
will do and waits for your OK, and the server refuses a write that does
not carry `confirm: true`.

- **Comment** adds a comment as the token's account.
- **Move…** lists the moves Jira allows for that ticket right now and
  applies the one you pick.

Leave `writeBack` off and the integration cannot change anything: the
write endpoints answer 403. Use an API token from an account that only
has the access you want wissel to have.

### API

| Endpoint | What it returns |
|---|---|
| `GET /projects/:id/git` | One repo: checkout state, branches, worktrees, and cards grouped by ticket. |
| `GET /work` | Every project's `/git` merged by ticket, plus per-project "needs a look" reasons. A repo that cannot be read is reported, not fatal. |
| `GET /github` | Pull requests (state, review, mergeable) and CI checks per project and branch, read with `gh`. A project `gh` cannot read is reported, not fatal. |
| `GET /ci` | Workflow runs per project on any branch (running, queued, failed, passed), read with `gh run list`. The CI tab shows what is running or queued and failures from the last day, with each run's jobs and the card and ticket it belongs to. |
| `GET /tickets/mine` | Open tickets assigned to the tracker account (Jira: `assignee = currentUser()`, limited to `projectKeys`), newest update first, at most 50. Drives the board's "Assigned to me" column. |
| `GET /tickets?keys=ABC-1,ABC-2` | Tracker details per key, or `{configured:false, reason}`. |
| `GET /tickets/:key/transitions` | The moves Jira allows now. Needs `writeBack`. |
| `POST /tickets/:key/comment` | `{confirm:true, text}`. Needs `writeBack`. |
| `POST /tickets/:key/transition` | `{confirm:true, transitionId}`. Needs `writeBack`. |

Ticket text from Jira is shown as data; it is never passed to an agent as
an instruction.

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
- **Board tab.** Running, Needs a human, Next step, Review and Done today from `/tasks`,
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
| `WISSEL_BIND` | `127.0.0.1` | Address the board listens on. Anything outside loopback refuses to start without `WISSEL_ALLOW_OPEN_BIND=1`. |
| `WISSEL_ALLOW_OPEN_BIND` | off | Allow a non-loopback `WISSEL_BIND`. The board has no sign-in yet: start-up warns and raises an owner task. |
| `WISSEL_HOST_GUARD` | off | `1` turns on the host guard: new cards are held while the host is short of room, and an owner task says why. |
| `WISSEL_HOST_GUARD_LOAD_PER_CORE` | `3` | Hold when the 1-minute load reaches this many per core. |
| `WISSEL_HOST_GUARD_MIN_MEMORY_PCT` | `20` | Hold when less than this share of memory is available. |
| `WISSEL_HOST_GUARD_MIN_DISK_GB` | `30` | Hold when the disk under `~/.wissel` (worktrees) has less free than this. |
| `WISSEL_HOST_GUARD_MIN_TEMP_GB` | `2` | Hold when a project's temp directory (its `env.TMPDIR`, else the system's) has less free than this. |
| `WISSEL_HARD_LIMITS_PATH` | `hard-limits.yaml` | The coordinator's hard limits, read once at start: `production` (`accounts`, `clusters`, `hosts`, patterns with `*`) and `readOnlyRepos`. Missing means only the built-in limits. |
| `WISSEL_CHANNEL_INTERVAL_MS` | `900000` (15 min) | How often each workstream's pending channel messages are posted, as one scribe run per workstream. `0` posts only on `POST /workstreams/:id/channel/flush`. |
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

Whose account it is: `ownerPrincipalId` names a principal (`owner` is
the instance owner, see `GET /me`), and `shared: true` lets others use
it. A harness with an owner and no `shared` runs only cards its owner
authorized; anyone else's card waits for one it may use. No owner means
anyone's, as before. Each run's telemetry names its harness and
principal, `bun run usage:report` splits spend by both, and a 429, an
exhausted balance or a lapsed sign-in is logged as a `harness.limit`
event naming the owner (`docs/SDD-identity-and-permissions.md` §4.7).

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

### `integrations.yaml`: the ticket tracker

Optional, git-ignored; copy `integrations.example.yaml`. Names a Jira site
and the environment variables holding the email and API token, an optional
project filter, and `writeBack`. Only the first entry is used. Setup is
walked through under "Git and tickets".

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
- `docs/SDD-git-jira-visibility.md`: git state and tickets on the board, the Jira integration and write-back.
- `docs/SDD-schedules.md`: schedules for pipelines and tasks, and "Start at" for a card; §7 is the switch-over from systemd.

## License

MIT. Copyright (c) 2026 Milton Cyrus. See [LICENSE](LICENSE).
