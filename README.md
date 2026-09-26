# wissel

Routes tasks to a fleet of agents and skills. It decides; it doesn't
execute by default. Read-only agents run in-process; write-tier agents
are decided and handed off to whatever actually runs them (agetor) —
wissel never spawns a worktree or a session for *dispatched* work. When
local write-tier execution is opted into (see
`WISSEL_EXECUTE_WRITE_TIER` below), wissel does run the work itself,
inside its own isolated git worktree — never editing a task's repo
directly until a human explicitly merges it.

Named after the railway switch point — the thing that decides which
track the work goes down, and makes sure two trains never take the same
one.

```bash
bun install
bun run dev            # board API + web fleet view, at :8787 — includes a New Task tab
bun run serve          # same, without --watch — see warning below before using bun run dev
bun run agents         # list the fleet
bun run why <task-id>  # what matched, and why — the router is never a black box
bun run team create <prefix>  # scaffold a coordinator + 3 specialists, delegation pre-wired
bun run version        # commit/branch/dirty this checkout is actually running
bun run test           # unit/integration
bun run test:e2e       # Playwright smoke tests against a live server
```

Set `WISSEL_ORCHESTRATOR=1` to have wissel route eligible tasks
automatically as they appear (off by default). A routing decision only
ever dispatches when the router is confident — zero match, a weak match,
or an unresolved tie all stop before spend, visible on the board as
`no-match`.

Set `WISSEL_EXECUTE_WRITE_TIER=1` (in addition to the orchestrator flag
above) to have wissel run write-tier work itself — headless `claude -p`
(or `codex exec`) against an isolated git worktree of the task's repo —
instead of only dispatching it for agetor or another external runner to
pick up. Off by default; a write-tier success lands in `review`, never
`done`, regardless of who ran it — unless the routed agent declares
both `autoMerge: true` and `trustLevel: "high"` in `agents/manifest.yaml`,
in which case it skips straight to `done` (a real `git merge --no-ff`
still happens for a worktree result; a genuine conflict falls back to
`review` like normal, never a silent `done`). No agent opts into this by
default. From `review`, the board's **Merge**/**Discard** actions (or
`POST /tasks/:id/merge` / `/tasks/:id/discard`) either land the
worktree's changes into the task's repo or throw them away — see
`docs/SDD-worktree-isolation.md`.

Turning both flags on moves the pipeline from "wissel decides, a human
dispatches every step by hand" to genuinely unattended: an
implementer→reviewer→pushback/escalation loop (see
`docs/SDD-review-handoff.md`) runs start to finish with no manual
`POST /tasks/:id/run` in between, all the way up to the one deliberate
human checkpoint (`review`, or `escalated` after repeated rejection).
Set a concurrency and/or spend cap before turning this on for a
credit-limited account — see `docs/SDD-pipeline-automation.md` §2.6 for
why (built after this project's own pipeline burned through real spend
under entirely manual, one-at-a-time dispatch and still hit usage
limits):

- `WISSEL_MAX_CONCURRENT_TASKS` — caps how many tasks the automatic
  sweep loop has in flight at once. Undefined/unset means unlimited.
  Doesn't affect a human's manual `POST /tasks/:id/run`, which always
  bypasses this the same way it bypasses every other sweep gate.
- `WISSEL_SWEEP_SPEND_CEILING_USD` — caps total real spend (from
  telemetry's own recorded `actualCost`, not estimates) the sweep loop
  will let accumulate within the current UTC day before it stops
  dispatching further work. Undefined/unset means unlimited. Checked
  once per sweep round, not per task — a coarse same-round guard
  against runaway multi-day spend, not a precise per-dispatch meter.

A claude-cli session-limit (429) hit no longer strands a task on
`failed` for a human to notice and manually retry — `runClaude` detects
it, parses the real reset time out of the error text, and
`Board.scheduleRetry` reschedules the task (reusing its existing
worktree) instead. See `docs/SDD-pipeline-automation.md` §3.2.

Earlier versions of this ran write-tier subprocesses directly against
`task.repo`'s own working tree, which meant a self-hosted task (repo ==
wissel's own source) editing files could trigger `bun run dev`'s
`--watch` mid-run and orphan its own subprocess — hit for real while
building the `codex-cli` harness. Worktree isolation (above) fixes this
structurally: a write-tier task never touches `task.repo` at all until a
human merges it, so `bun run dev` is safe to use even with tasks
running. `bun run serve` (no `--watch`) still exists if you want it, but
isn't required for this anymore.

Each execution harness (see `harnesses.yaml`) can be turned on or off by
hand from the board — the strip at the top only ever shows what's usable
right now, but the **Manage harnesses** panel next to it lists every
configured harness (including disabled/not-authenticated ones) with a
toggle. Disabling just stops new work from picking it (nothing in
flight is interrupted); enabling re-checks that the harness is actually
authenticated before flipping the switch, refusing with a clear error
otherwise. Either way it's `POST /harnesses/:id/enable` /`/disable`,
and it's `harnesses.yaml` itself that gets updated (comments preserved),
so the decision survives a restart — see
`docs/SDD-harness-enable-disable.md`.

Wissel reports which commit/build it's actually running, snapshotted
once at process startup (not a live git check, so it always describes
what this process loaded, not whatever's currently on disk — see
`docs/SDD-version-info.md`): `GET /version` returns
`{commit, commitShort, branch, dirty, packageVersion, startedAt}`,
`wissel --version` (or `-v`) prints the same as one line, and the
startup log always includes a `version: ...` line. The board's header
also shows a small commit badge (hover for the full commit/branch).

Known gaps:
- No sandboxing beyond whatever the underlying agent CLI already does —
  not solved here, noted so it isn't assumed.
- Merging/discarding a worktree is a manual, per-task action — nothing
  auto-merges (unless the routed agent opted into `autoMerge`, see
  above), and an abandoned worktree (task deleted, never
  merged/discarded) just sits under `~/.wissel/worktrees/` until cleaned
  up by hand.

Design decisions and build order: `docs/HANDOVER.md` — but read
`docs/HANDOVER-2026-09-17.md` first, it's the current spec and supersedes
the older doc on the router/execution boundary.

## Pipelines

A **Pipeline** is a stored, reusable step graph — author it once on the
canvas, run it as many times as wanted (`POST /pipelines/:id/run`, or the
board's own hardcoded implementer→reviewer loop reproduced as a real
pipeline definition). CRUD lives at `/pipelines`; see
`docs/SDD-pipelines.md` for the full design.

The canvas editor (`pipeline-editor/`) is wissel's first frontend
framework/build step — a separate React + `@xyflow/react` + Vite app,
deliberately isolated from `board.html`'s zero-build-tooling convention
(see the SDD's §3.2). Build it once, then the running server picks up
its static output automatically:

```bash
cd pipeline-editor
bun install
bun run build      # writes pipeline-editor/dist/
cd ..
bun run dev         # or serve — now serving /pipelines/edit too
```

`bun run dev` inside `pipeline-editor/` also works standalone for local
iteration (hot reload, proxies `/agents`/`/pipelines`/`/board` to the
real wissel server at `:8787` — see `pipeline-editor/vite.config.ts`).
Until `pipeline-editor/dist/` exists, `GET /pipelines/edit` responds
`503` with a message telling you to build it — never a silent blank
page.
