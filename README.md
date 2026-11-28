# wissel

Personal research project. It changes often, and changes may break things.

wissel is a task board that routes each card to an agent from a fleet
(`agents/manifest.yaml`) and runs it under one of your local accounts
(`harnesses.yaml`):
- **Code changes** happen in an isolated git worktree.
- **Review:** they go through an automated reviewer.
- **Landing:** they're merged back into the repo, or delivered as a pull
  request.
- **The coordinator:** on top of single cards, it can run a whole piece of
  team work across projects, inside rules you set.

Named after the railway switch point: the thing that decides which track
the work goes down.

## Quick start

```bash
bun install
WISSEL_ORCHESTRATOR=1 WISSEL_EXECUTE_WRITE_TIER=1 bun run serve
```

The board is at `http://localhost:8787/board`, and the app (phone and
desktop) at `http://localhost:8787/app`. With those two flags, Wissel
routes every new card itself and runs write-tier work locally. Without
them, nothing runs until you press **Run** on a card. Before the first
write-tier run, do the one-time sandbox setup in
[Getting started](docs/guide/getting-started.md).

## In short

**Cards and agents.** A card is routed by its labels and text to an
agent: a planner, implementer, reviewer, triager and so on. It runs on
an account from `harnesses.yaml`, in its own worktree when it writes
code. Write-tier work is reviewed automatically and sent back for
another round until it passes or hits the cap, then lands.
[How cards run](docs/guide/how-cards-run.md) ·
[Review and delivery](docs/guide/review-and-delivery.md)

**The board and the app.** The board at `/board` shows lanes, a "Needs
you" strip, pipelines, tickets, CI and setup. The app at `/app` is the
phone-first view: a feed, Ask (chat that can work the board, with a
Confirm step for anything risky), the board, Listen (audio summaries)
and You. [The board](docs/guide/board.md) · [The app](docs/guide/app.md)

**Pipelines and schedules.** A pipeline is a saved graph of steps, each
bound to an agent, that runs as linked cards. Schedules start a pipeline
or a card on a cron.
[Pipelines and schedules](docs/guide/pipelines-and-schedules.md)

**Git and tickets.** See each project's branches and PRs, and every
ticket with the work on it across projects. Jira is optional, and
writing back to it is off unless you turn it on.
[Git and tickets](docs/guide/git-and-tickets.md)

**The coordinator.** Group cards across projects into a workstream, and
Wissel coordinates it for you:
- watches cards and PRs;
- plans the next cards and decides small things, or asks the right
  person;
- posts claims and ready-to-merge lines to the team's channel;
- moves the ticket, and sends digests.

Everything goes through one policy gate: hard limits, then each
project's role, `mustAsk` and `never` lists. Start it in Shadow, hand
over one duty at a time, and widen roles as it earns trust.
[The coordinator](docs/guide/coordinator.md), which starts with how to
adopt it step by step.

**Sign-in and permissions.** Off by default: one owner stands behind
everything, and every write is recorded in the audit. `WISSEL_AUTH=tokens`
turns sign-in on:
- **People** sign in with tokens you give them.
- **Permissions** are granted per instance, workstream or project.
- **Card runs** get read-only tokens for their own card.
- **Risky actions**, such as arming a PR, need an approval bound to
  exactly what was reviewed.

[Sign-in and permissions](docs/guide/sign-in-and-permissions.md)

**Running it.**
- [Getting started](docs/guide/getting-started.md): commands, host setup,
  safe restarts.
- [Operations](docs/guide/operations.md): owner tasks, restart when idle,
  the host guard, spend.
- [Configuration](docs/guide/configuration.md): every environment variable,
  and the YAML files.

**Design docs.** The specs behind each part:
[Design docs](docs/guide/design-docs.md). The coordinator is
`docs/SDD-coordinator.md`, and identity is
`docs/SDD-identity-and-permissions.md`.

## Known gaps

- Only write-tier Bash is sandboxed (`docs/SDD-write-tier-sandbox.md`).
  Claude's own file tools, readonly runs and codex runs are not.
- Deleting a task does not remove its worktree. It stays under
  `~/.wissel/worktrees/` until cleaned up by hand.
- The coordinator acts on the code host through `gh` as whoever is
  signed in there. A GitHub App of its own is planned.

## License

MIT. Copyright (c) 2026 Milton Cyrus. See [LICENSE](LICENSE).
