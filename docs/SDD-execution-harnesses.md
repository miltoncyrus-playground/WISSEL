# SDD — Execution harnesses: registry, selection, and a status strip

Status: **Phase 1 built and demoed** (§9's registry, selection, task-load
strip). Verified live against the real `claude` CLI and this machine's
real `claude-personal` profile — a task's `harness` field and the
`/harnesses` endpoint's `activeCount` flip live while a task runs and
settle back after, and a bogus `CLAUDE_CONFIG_DIR` override was proven
to actually redirect `claude auth status` to a logged-out identity,
confirming the env-passthrough mechanism (§5) really works, not just
happens to match the ambient default. Phase 2 (spend badge + harness
health check, §9) not started. §8.1 (credential storage) and §8.2
(manual pinning) are still open — Phase 1 shipped with their recommended
defaults (env-pointer only, no raw secrets; automatic selection only).
§8.3 resolved: demoed against the single `claude-personal` harness, no
second `CLAUDE_CONFIG_DIR` needed yet.

**Follow-up, also built**: auto-detection (§11) — `harnesses.yaml` is no
longer the only way a harness gets registered. `HarnessPool.autoload()`
scans `$HOME` for `.claude*`-prefixed directories, probes each with
`claude auth status --json`, and includes only the ones that come back
actually logged in — this machine's untouched default `~/.claude`
correctly gets skipped rather than offered as a fake harness, confirmed
live. `harnesses.yaml` is now an override layer (rename/disable/pin a
detected account, or declare a manual-only entry), not the source of
truth.

## 1. Goal

Add a persistent strip at the top of the board listing every **execution
harness** wissel can run work under — a named combination of *tool*
(which CLI actually runs the agent, e.g. `claude-cli`) and *account*
(which authenticated identity it runs as, e.g. `claude-personal` vs
`claude-work`) — showing which are active right now and their current
utilization.

This is a different, and bigger, thing than "the fleet" (agents/skills
in `agents/manifest.yaml`). The fleet answers "what kind of work can be
done"; a harness answers "which credentialed process actually does it."
wissel has never modeled the second question — every executor today
shells out to whatever `claude` happens to be on `PATH`, under whatever
account is currently logged in, with no way to name, choose between, or
observe multiple accounts/tools. This SDD adds that concept.

## 2. This deliberately crosses a boundary already on record

`docs/SDD-openclaw-agents-for-wissel.md` §2 and §5 explicitly ruled
workspace/auth/credential state out of wissel's scope: *"wissel decides
and dispatches; it does not hold state, credentials, or a persistent
identity for anything it routes to... belongs to agetor, never wissel."*
That was the right call for wissel routing *tasks* to agents it never
runs itself. Harnesses are narrower: wissel already runs read-only work
in-process (`ReadOnlyExecutor`) and optionally write-tier work locally
(`WriteExecutor`, opt-in via `WISSEL_EXECUTE_WRITE_TIER`) — for exactly
that local-execution path, wissel is already the thing spawning `claude`
processes, so naming *which* `claude` identity it spawns is an extension
of work wissel already does, not a new category of responsibility.
Confirmed with you directly: build this into wissel, not as an external
feed wissel merely displays.

The one piece of the old boundary I'm keeping regardless: **wissel
names and selects harnesses, it doesn't become a credential store.** A
harness entry points at an *already-authenticated* local profile (a
config directory, an env var) rather than holding an API key or session
token itself. See §8 open question if you actually want the latter.

**Out of scope, unaffected by this doc**: tasks wissel *dispatches*
(write-tier, `executeWriteTier` off — the default) are still handed to
agetor as `dispatched` and wissel has no visibility into, or say over,
which harness agetor runs them under. Harness tracking only covers work
wissel executes itself. See §6.

## 3. What I looked at

`src/executors/claude-cli.ts` (`runClaude`, `CommandRunner`, the single
hardcoded `claude` binary + no account/env selection), `readonly.ts` and
`write.ts` (both take one global `model` option, no harness concept),
`src/core/orchestrator.ts` (`process()`'s dispatch/telemetry recording,
`inFlight` tracking — per-task, not per-harness), `src/core/types.ts`
(`TaskCard`, `TaskResult`, `Executor`), `src/services/telemetry.ts`
(append-only log, currently `{agentId}`, no harness field), `src/core/
registry.ts` (the pattern I'm mirroring for a new `HarnessPool`), and
`src/api/server.ts`'s `GET /agents` (the pattern for a new `GET
/harnesses`). Also re-read `docs/SDD-openclaw-agents-for-wissel.md` in
full for the credentials-boundary language quoted in §2, and confirmed
`~/.claude/` has no existing local file exposing usage/rate-limit
numbers (checked directly — `policy-limits.json` is org policy flags,
not consumption data). That gap drives §7's split into "buildable now"
vs. "needs a spike."

## 4. Data model: `Harness`

New file `harnesses.yaml` (repo root, sibling to `agents/manifest.yaml`
— a different axis, not a section of the same file):

```yaml
harnesses:
  - id: claude-personal
    tool: claude-cli
    label: "Claude — personal"
    enabled: true
    env: { CLAUDE_CONFIG_DIR: "~/.claude" }
  - id: claude-work
    tool: claude-cli
    label: "Claude — work"
    enabled: true
    env: { CLAUDE_CONFIG_DIR: "~/.claude-work" }
```

```ts
export type HarnessTool = "claude-cli"; // extend as real adapters land — see §6
export interface Harness {
  id: string;
  tool: HarnessTool;
  label: string;
  enabled: boolean;
  /** Env overrides applied to the spawned process — how a harness picks
   *  an already-authenticated account without wissel holding a secret
   *  itself. Never a raw API key/token value; a pointer (config dir,
   *  profile name) to credentials that already live somewhere else. */
  env?: Record<string, string>;
}
```

`HarnessPool` (new, `src/core/harness-pool.ts`) mirrors `Registry`
exactly: `load(path)`, `from(harnesses)`, `all()`, `get(id)`. Loaded once
per process, same as `Registry.load()` in `server.ts`.

## 5. Selection: which harness runs a given task

`ReadOnlyExecutor`/`WriteExecutor` currently hardcode one `runner`/
`model`. They gain a `HarnessPool` and a selection strategy instead:

- **v1 strategy**: enabled harnesses matching the executor's tool
  (`claude-cli` today — the only tool actually wired, see §6), picked
  round-robin, or least-currently-active if two are tied (reuses the
  same active-task-count computation the status strip needs anyway —
  one function, two callers).
- `runClaude()` gains an `env` field on `CommandRunner`'s `opts`
  (alongside the existing `cwd`), populated from the picked harness's
  `env` map. `runViaBun` passes it straight to `Bun.spawn`.
- `TaskResult` gains `harnessId?: string`, set by the executor to
  whichever harness it actually ran under — the record of what
  happened, not just what was configured.
- `TaskCard` gains `harness?: string`, set once execution actually
  starts (mirrors how `routedTo` is set once routed) via a new
  `Board.setHarness(taskId, harnessId)` (+ SQLite column) called from
  `Orchestrator.process()` right before `board.move(task.id, "running")`.
- Telemetry's `dispatch`/`result` event variants gain `harnessId`.

**Manual pinning** (a human choosing "run this under claude-work"
specifically) is not in v1 — automatic selection only. Flagged in §8;
straightforward to add later as a per-task override, same shape as the
existing "Advanced: override agent" pattern in the New Task tab.

## 6. Non-goal: other tools

You said a harness should cover both accounts *and* tools (claude-cli,
cursor, aider, codex, ...). The schema (`Harness.tool`) is built to hold
any of those, but **this pass wires up `claude-cli` only** —
`ReadOnlyExecutor`/`WriteExecutor` already exist for it; a `cursor-cli`
or `aider` executor is a real, separate integration (different CLI
flags, different output-parsing contract, possibly no headless
`--output-format json` equivalent) that deserves its own SDD once a
specific second tool is actually wanted. A harness entry naming an
unwired tool renders in the strip (§7) as present but not runnable,
rather than being silently dropped — honest about what's configured vs.
what wissel can actually use today.

## 7. Utilization: two different numbers, two different confidence levels

**Task load — buildable now.** Count of tasks currently assigned to a
harness (`task.harness === h.id && task.status === "running"`) — same
shape as the active-count logic already in `board.html`'s
`isActive()`/`fleetRow()`, just keyed by `harness` instead of
`routedTo`. This is exact, not estimated: wissel set `harness` itself
moments before spawning the process, for exactly the tasks it's running
right now.

**Usage/rate-limit quota — spike done, result is negative.** Ran the
spike directly against the local `claude` install (v2.1.277) rather than
speculating:
- `claude --help` lists every top-level command (`agents`, `attach`,
  `auth`, `auto-mode`, `doctor`, `gateway`, `import`, `install`, `logs`,
  `mcp`, `plugin`, `project`, `respawn`, `rm`, `setup-token`,
  `ultrareview`, `update`) — **no `usage` command, no usage/quota flag
  anywhere in the ~130-option flag list.** `claude usage --help` falls
  through to the generic top-level help, confirming `usage` isn't a
  recognized subcommand.
- `claude auth status --json` returns identity/plan info —
  `{loggedIn, authMethod, apiProvider, projectsDirectory,
  configDirectory, email, orgId, orgName, subscriptionType}` — useful
  (see below) but **no consumption/remaining-quota numbers**.
- `claude doctor` reports install/version/update health, not usage.
- No file under any `CLAUDE_CONFIG_DIR` (checked this machine's active
  one directly) contains cached usage/rate-limit numbers — `cache/` and
  `telemetry/` hold a changelog cache and an empty directory,
  respectively.

**Conclusion**: the interactive `/usage` panel's data isn't exposed
through any scriptable surface in this CLI version. There is nothing to
build a real quota gauge against today. **The interim proxy from §7
(original) is now simply the plan, not a fallback**: utilization ships
as (a) task load (exact, §7 above) and (b) a wissel-visible spend figure
— sum of `actualCost ?? estimatedCost` from the telemetry log in a
rolling window, per harness, labeled in the UI as "spend wissel dispatched,
not a real quota reading" so it's never mistaken for the account's
actual remaining budget. A true quota gauge is **not planned** unless a
future CLI version adds a scriptable surface for it — noted as a gap,
not designed around a guess.

**Bonus finding, worth keeping.** `claude auth status --json` *is* a
clean, cheap, scriptable per-harness **health/identity check** — confirms
a given `CLAUDE_CONFIG_DIR` is actually logged in, and which
email/org/plan it resolves to, before wissel ever spawns work under it.
Concretely useful on this very machine: this session's own
`configDirectory` is `/Users/milton.cyrus/.claude-personal` — i.e.
`claude-personal` in the harness examples above isn't a hypothetical
label, it's this machine's real, already-authenticated config dir.
Worth folding a `harness-health` check built on `claude auth status
--json` (run with `CLAUDE_CONFIG_DIR` set per harness) into Phase 1 as a
cheap "configured but not logged in" guard before a harness is offered
as a selection candidate — separate from, and much cheaper than, the
abandoned quota-gauge idea.

**v1 of this SDD ships task load + wissel-visible spend.** No further
phase is blocked on external research — see §9's revised plan.

## 8. Open questions requiring your call

1. **Credential storage.** §2 proposes harnesses reference
   already-authenticated local profiles (`CLAUDE_CONFIG_DIR`, etc.),
   never holding a secret value in `harnesses.yaml` itself. Confirm
   that's right, or say if you actually want wissel to hold API
   keys/tokens directly (a real security-scope increase — separate
   storage, access control, and probably out of `harnesses.yaml`
   entirely if so).
2. **Manual harness pinning.** v1 is automatic-selection-only (§5). Say
   if you want per-task manual override in this same pass rather than
   as a fast-follow.
3. **Where do harness accounts actually come from on your machine right
   now?** Partially answered by the spike: this session's own
   `CLAUDE_CONFIG_DIR` is already `~/.claude-personal`, a real,
   logged-in profile — so `claude-personal` is demoable immediately as
   one harness. Still open: do you have (or want to set up) a second
   distinct `CLAUDE_CONFIG_DIR` (e.g. `~/.claude-work`) so Phase 1 has
   more than one harness to actually show selection/load-balancing
   across, or should Phase 1 ship and demo against a single harness for
   now, with a second added whenever you have one?

## 9. Phased implementation plan

Nothing here is blocked on external research anymore — §7's spike closed
that out. Phases are about sequencing, not unknowns.

**Phase 1 — registry, selection, task-load strip** (once §8.1–8.3
answered):
- `harnesses.yaml` + `Harness` type + `HarnessPool` (`src/core/
  harness-pool.ts`), mirroring `registry.ts`.
- `CommandRunner`'s `opts` gains `env`; `runViaBun` passes it through.
- `ReadOnlyExecutor`/`WriteExecutor` take a `HarnessPool`, pick a
  harness per run (§5), return `harnessId` on `TaskResult`.
- `TaskCard.harness` + `Board.setHarness()` + SQLite column;
  `Orchestrator.process()` sets it before moving a task to `running`.
- Telemetry events gain `harnessId`.
- `GET /harnesses` endpoint (mirrors `GET /agents`).
- `board.html`: new `.harness-strip` above the header/toolbar (same
  placement rationale as before — visible in both Board and New Task
  views), one pill per harness: tool+account label, active dot (task
  load > 0, reusing `activeDot()`), a task-load count badge. Unwired
  tools (§6) render greyed with a "not yet runnable" note instead of an
  active dot.

**Phase 2 — spend badge + health check** (additive, same strip):
- Per-harness spend aggregation from the telemetry log (§7's interim
  proxy), rendered as a small labeled figure on the pill — explicitly
  captioned so it reads as "spend wissel dispatched," never as a quota
  reading.
- `harness-health` check: shell `claude auth status --json` with each
  harness's `env` applied, cache briefly (seconds-to-minutes, not
  per-render), surface a "not logged in" state distinctly from "idle" on
  the pill — reuses the red/amber-dot visual language already scoped for
  this in `SDD-openclaw-agents-for-wissel.md` §4.3, now with a concrete
  data source instead of a hypothetical one.

**Tests**: unit tests for `HarnessPool` (mirrors `registry.test.ts`),
selection-strategy tests with a fake `CommandRunner` (mirrors existing
executor tests — no real `claude` process spawned), a fake for the
`claude auth status` shell-out (same injectable-runner pattern, no real
process spawned in tests), manual smoke test via a live server for the
strip itself (same pattern as prior UI SDDs in this repo — no browser
test harness exists yet).

## 10. What I need from you

§7's spike is done — no quota API exists, plan updated accordingly, no
further research blocking this doc. Answer §8.1–8.3 (credential storage,
manual pinning, whether to set up a second `CLAUDE_CONFIG_DIR` before
Phase 1 or demo against just `claude-personal` first) and approve or
redirect the overall shape (§4's schema, §5's selection strategy, §9's
phasing).

## 11. Auto-detection (built as a follow-up, on request)

You said `harnesses.yaml` should stop being the only way a harness
exists — wissel should notice, on its own, when there's more than one
authenticated account available.

**Heuristic**: candidate config directories are anything under `$HOME`
whose name starts with `.claude` (`.claude`, `.claude-personal`,
`.claude-work`, ...) — the naming convention already in use on this
machine, not an invented one. Each candidate is probed with `claude auth
status --json` and `CLAUDE_CONFIG_DIR` pointed at it; only a candidate
that comes back `loggedIn: true` becomes a `Harness`. This distinction
matters in practice, not just in theory: this machine's own default
`~/.claude` exists as a directory but was never logged into (`claude
auth status --json` there returns `loggedIn: false` — confirmed
directly), so a naive "list directories" approach would have offered a
dead harness. Probing, not listing, is the actual detection step.

**Id/label derivation**: the directory name minus its leading dot
becomes the id (`.claude-personal` → `claude-personal`, matching the
manual example already in `harnesses.yaml` on purpose — see the merge
rule below). The label defaults to `"Claude — <email>"` from the auth
status response, falling back to the bare id if no email comes back
(possible for non-`claude.ai` auth methods).

**`src/core/harness-discovery.ts`**: `discoverHarnesses({runner?,
homeDir?})` — both injectable, so tests never touch the real filesystem
or spawn a real `claude` process (see `test/harness-discovery.test.ts`).
Never throws: a missing `claude` binary, an unreadable `$HOME`, or one
candidate's spawn failing all degrade to "that candidate isn't
included," never a startup failure.

**Merge with `harnesses.yaml`**: `HarnessPool.autoload(path?,
discoverOpts?)` — the new real startup path (`server.ts`'s bootstrap
calls this instead of `load()`) — runs discovery, then layers the
manifest file on top: a manual entry's id colliding with a discovered
one wins outright (its label/enabled/env replace the discovered values,
not merge field-by-field — simpler to reason about than a partial
merge, and the only case in the manifest file today, `claude-personal`,
uses this to pin a friendlier label than auto-generation would produce).
A manual entry with no discovered match is kept as-is — the escape hatch
for a future non-`claude-cli` tool discovery can't probe, or an account
you want listed even while logged out. A missing `harnesses.yaml` is
**not** an error for `autoload()` (unlike `load()`, which still throws
on a missing file — kept for any caller that wants the old, manifest-is-
required contract): discovery alone is a complete, valid starting point.

**Verified live**, not just by test: ran the real server with
`harnesses.yaml` deleted from its effective config — same result,
`claude-personal` still detected, no manual entry needed. Then ran it
with the manifest's override in place — the pinned label
(`"Claude — personal"`) won over what auto-generation would have
produced (`"Claude — milton.cyrus@gmail.com"`), confirming the
precedence rule, not just that both paths independently work.

**Known limitation, not addressed here**: discovery runs once at
startup, not on a timer or a filesystem watch — logging into a new
account while wissel is already running needs a restart to be picked
up, same as `agents/manifest.yaml` and `harnesses.yaml` themselves
(neither is live-reloaded either). Consistent with the rest of wissel's
manifest-loading behavior, not a new gap this feature introduces.
