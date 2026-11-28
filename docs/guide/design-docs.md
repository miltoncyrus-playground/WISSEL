# Design docs

The specs behind each part, in `docs/`.

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

---

[Back to the README](../../README.md)
