# How cards run

From a card on the board to merged work: routing, agents, worktrees, review, and the per-card and per-project settings that shape a run. Delivery as a pull request and the review policy are in [Review and delivery](review-and-delivery.md).

## How a card runs

1. **Board.** Cards live in SQLite (`~/.wissel/board.sqlite`). Create one
   from **+ New** (Task or Pipeline run) or `POST /tasks`.
2. **Router.** `src/core/router.ts` scores each agent by how many of the
   card's `labels` match its `tags`. A zero match or a tie for first stops
   before any spend and lands as `no-match`. `bun run why` shows the full
   ranking.
3. **Harness.** `src/core/harness-pool.ts` picks the account to run under
   (see `harnesses.yaml` in [Configuration](configuration.md)). If none is available, the task waits unrouted
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

## Planners, session limits and start times

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

## Keys, project rules and project env

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


## Start conditions and overlapping work

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

---

[Back to the README](../../README.md)
