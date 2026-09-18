# wissel

Routes tasks to a fleet of agents and skills. It decides; it doesn't
execute. Read-only agents run in-process; write-tier agents are decided
and handed off to whatever actually runs them (agetor) — wissel never
spawns a worktree or a session itself.

Named after the railway switch point — the thing that decides which
track the work goes down, and makes sure two trains never take the same
one.

```bash
bun install
bun run dev            # board API + web fleet view, at :8787 — includes a New Task tab
bun run agents         # list the fleet
bun run why <task-id>  # what matched, and why — the router is never a black box
bun run team create <prefix>  # scaffold a coordinator + 3 specialists, delegation pre-wired
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
with `--permission-mode acceptEdits` against the task's repo — instead of
only dispatching it for agetor or another external runner to pick up.
Off by default; a write-tier success still lands in `review`, never
`done`, regardless of who ran it.

Known gap: no sandboxing beyond whatever the underlying agent CLI already
does — not solved here, noted so it isn't assumed.

Design decisions and build order: `docs/HANDOVER.md` — but read
`docs/HANDOVER-2026-09-17.md` first, it's the current spec and supersedes
the older doc on the router/execution boundary.
