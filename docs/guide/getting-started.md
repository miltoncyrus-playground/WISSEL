# Getting started

How to run Wissel, the commands it comes with, and the one-time host setup.

```bash
bun install
WISSEL_ORCHESTRATOR=1 WISSEL_EXECUTE_WRITE_TIER=1 bun run serve   # how it's normally run
```

The board is at `http://localhost:8787`, the new app at
`http://localhost:8787/app` (see [The app](app.md)).

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
| `bun run seed:ai-news` | Create or upgrade the stored podcast pipelines (see [Pipelines and schedules](pipelines-and-schedules.md)). |
| `bun run seed:schedules` | Create the two morning podcast schedules, disabled (see [Pipelines and schedules](pipelines-and-schedules.md)). Idempotent. |

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

## One-time host setup: the write-tier Bash sandbox

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

## Restarting safely

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

---

[Back to the README](../../README.md)
