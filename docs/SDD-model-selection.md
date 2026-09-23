# SDD — Model selection per harness, and in new-task creation, with daily-refreshed model lists

Status: **design**, decomposed into 7 subtasks. This doc (subtask 1/7) is
the shared spec every other subtask implements against — the design
questions below are resolved, not open, going into subtasks 2–7.

## 1. Goal

Today the model a task actually runs under is picked once, statically,
by whoever wrote `AgentDef.costProfile.model` in `agents/manifest.yaml`.
Four of the five CLI/API-backed executors already resolve
`this.model ?? agent.costProfile.model` (`readonly.ts:41/59`,
`write.ts:56/81`, `codex-write.ts:53/75`, `codex-readonly.ts:41/55`) —
`this.model` is a constructor-only override no UI or task can reach.
The fifth, `anthropic-api.ts`, has no such field yet: `ApiExecutorOptions`
(`anthropic-api.ts:36-44`) has no `model?: string`, and `run()` calls
`client.messages.create({ model: agent.costProfile.model, ... })`
unconditionally (`anthropic-api.ts:86`), with no override of any kind.
Adding that constructor override to `ApiExecutor` is part of this SDD's
new work (subtask 3), not pre-existing infrastructure.
There is no way for a human to say "run this specific task on a
different model" or "this harness should default to a cheaper/faster
model than whatever the manifest says" without editing
`agents/manifest.yaml` and restarting the server.

This SDD adds two new override layers — per-harness (`Harness.model`)
and per-task (`TaskCard.model`) — on top of the existing
`AgentDef.costProfile.model` default, plus a way to know what model
names are actually valid to pick from, refreshed daily rather than
hand-maintained forever.

## 2. This revises a prior decision — named, not silently contradicted

`docs/SDD-new-task-tab.md` §7/§8 explicitly scoped model selection out:

> §7, Non-goals for this pass: "Model/effort/mode selection — not part
> of wissel's per-task contract."
>
> §4's field table, Model/Effort row: "Not part of `TaskCard` or the
> per-task contract; model lives on `AgentDef.costProfile`, chosen by
> the agent definition, not the submitter."

That was the right call at the time — wissel had no mechanism for a
per-task override to mean anything, and §8 of that doc made the same
kind of call about a different field (the backlog hold-state question):
a wissel feature shouldn't exist just because agetor has one, absent "a
wissel-shaped reason." Model/effort selection was scoped out under that
same discipline. This SDD is that wissel-shaped reason: once
`TaskCard.model` exists and the precedence chain in §4 below is real,
letting the New Task form set it is a thin UI layer over a mechanism
that already resolves correctly, not a speculative field with nowhere
to go. **Superseded**: `SDD-new-task-tab.md` §4's Model/Effort row and
§7's "Model/effort/mode selection" non-goal no longer hold — subtask 6
(new-task UI) adds the field. Everything else in that SDD (no
worktree/branch, no mode pills, no Fast/Max toggle) is untouched; this
is a narrow, named revision of one row, not a reopening of that whole
design.

Precedent for calling out a reopened decision by name instead of
quietly overriding it: `docs/SDD-harness-enable-disable.md` §2, which
named commit `51904ff` and Milton's prior "hide disabled harnesses from
the strip" call before explaining what stays and what changes.

## 3. What I looked at

`src/core/types.ts` (`Harness` at line 209, `TaskCard` at line 109,
`CostProfile`/`AgentDef` at lines 11–97), `src/core/harness-pool.ts`
(`HarnessPool.acquire`, lines 96–102, and its "zero candidates" doc
comment, lines 90–95), every executor under `src/executors/`
(`readonly.ts`, `write.ts`, `codex-readonly.ts`, `codex-write.ts` — four
of the five CLI/API-backed executors already have a private
`model?: string` constructor option that shadows `agent.costProfile.model`;
`anthropic-api.ts` is the outlier, see §1), `agents/manifest.yaml`
(every entry's `costProfile.model` is `claude-sonnet-5` today), `src/api/server.ts`
(`CreateAppOptions`, `GET /harnesses` at line 197, the
`harnessesPath`/`harnessRunner` injection pattern already established
for `docs/SDD-harness-enable-disable.md`), and `src/api/public/board.html`
(the "Manage harnesses" drawer, `#harnessPanel`/`#hmList`, lines 618–629
and its render logic, `renderHarnessPanel()` at line 1350; the New Task form,
`#newTaskPanel`/`#newTaskForm`, lines 488–547, including the existing
`<details id="ntAdvanced">` "Advanced: override the router" section at
lines 533–539).

**Verified live** (per the parent card's shared context, not re-derived
here): `claude --help` and `codex --help` have no list-models
subcommand — neither CLI exposes a way to ask "what models can I pick
from" at runtime. `@anthropic-ai/sdk` is already a dependency
(`package.json`, `^0.127.0`, used today only for `messages.create` in
`anthropic-api.ts`) and exposes a real `client.models.list()` call.

## 4. Precedence order — non-negotiable

Four layers, highest wins, documented as a comment beside
`CostProfile`/`Harness` in `types.ts`:

1. **Executor constructor override** (a `model?: string` constructor
   option) — tests/evals only, never reachable from a task or the UI.
   This layer already exists today in four of the five executors
   (`this.model ?? agent.costProfile.model` in `readonly.ts`, `write.ts`,
   `codex-readonly.ts`, `codex-write.ts`); `ApiExecutorOptions` needs the
   same field added (subtask 3) since `anthropic-api.ts` doesn't have it
   yet (§1).
2. **`TaskCard.model`** — a human's explicit per-task choice, set at
   task-creation time (subtask 6) or later.
3. **`Harness.model`** — a per-harness default, set in `harnesses.yaml`
   or via the Manage Harnesses panel (subtask 4/6).
4. **`AgentDef.costProfile.model`** — the manifest default, unchanged
   from today.

Each executor's `run()` resolves this as
`this.model ?? task.model ?? harness?.model ?? agent.costProfile.model`
— layer 1 is a constructor field so it's always checked first
syntactically; layers 2–4 are the new fallback chain inserted where
`agent.costProfile.model` is used unconditionally today (e.g.
`readonly.ts:59`, `write.ts:81`, `anthropic-api.ts:86`).

This order is deliberate, not arbitrary: a human overriding a single
task (layer 2) should win over a harness-wide default (layer 3), which
in turn should win over the manifest's generic default (layer 4) —
narrower scope always beats broader scope. Layer 1 sits above all three
because it only exists for tests/evals that need to pin a model
regardless of what a real task or harness says.

## 5. Fail loud on an unresolvable override — and why this differs from pool exhaustion

**Rule**: if `TaskCard.model` or `Harness.model` (or the new
`TaskCard.harnessOverride`, §6) names something that doesn't resolve —
an unknown model id, a harness id that doesn't exist in the pool — the
task fails outright with a clear error. No silent fallback to the next
precedence layer, no silent fallback to "no harness."

This is a deliberate contrast with `HarnessPool.acquire()`'s existing
behavior (`src/core/harness-pool.ts:90-95`):

> "Returns undefined when no enabled harness exists for the tool —
> callers fall back to running with no harness at all, identical to
> wissel's behavior before harnesses existed (whatever `claude` is on
> PATH, under the ambient environment)."

That silent tolerance is correct for *pool exhaustion* — "no harness of
this tool is currently enabled" is an ambient, expected state (harnesses
are optional infrastructure; wissel worked before they existed, and
still works with zero configured). It is not a human's explicit
instruction being ignored.

An **explicit** model or harness override is different in kind: a human
(or the New Task form) *said* "use `claude-opus-5`" or "use harness
`codex-personal`." If that name doesn't exist, silently falling back to
whatever the manifest would have picked anyway means the override had
no effect and nobody finds out. That's worse than an error — it looks
like the override worked. So this SDD's new resolution logic (§4) fails
the task with a message naming exactly what didn't resolve (e.g.
`model override "claude-opus-4-6" is not in the known model list for
harness "claude-personal"`, or `harnessOverride "codex-staging" does not
exist in the harness pool`) instead of falling through to layer 3 or 4.
This does not touch `acquire()`'s own pool-exhaustion path at all — that
stays exactly as tolerant as it is today.

## 6. Storage

```ts
// types.ts — Harness (existing interface, new field)
export interface Harness {
  id: string;
  tool: HarnessTool;
  label: string;
  enabled: boolean;
  env?: Record<string, string>;
  apiKeyEnv?: string;
  disabledReason?: string;
  /** Per-harness default model, overriding AgentDef.costProfile.model
   *  for any task run under this harness. Undefined means "no
   *  harness-level default" — falls through to costProfile.model. See
   *  docs/SDD-model-selection.md §4 for the full precedence chain. */
  model?: string;
}
```

```ts
// types.ts — TaskCard (existing interface, two new fields)
export interface TaskCard {
  // ...existing fields unchanged...
  /** A human's explicit per-task model override, set at creation
   *  (New Task form, subtask 6) or later. Wins over Harness.model and
   *  AgentDef.costProfile.model — see docs/SDD-model-selection.md §4.
   *  Unresolvable names fail the task loudly (§5); never silently
   *  falls through. */
  model?: string;
  /** A human's explicit per-task harness override — distinct from
   *  `harness` above, which is output-only (set once wissel starts
   *  executing locally, to show the board which harness actually ran
   *  it). `harnessOverride` is an input: "use this harness id
   *  specifically," checked before HarnessPool.acquire()'s normal
   *  least-loaded selection. Unknown id fails the task loudly (§5). */
  harnessOverride?: string;
}
```

`Harness.model` persists in `harnesses.yaml` the same way every other
`Harness` field does (`HarnessPool.load`/`autoload`, `src/core/harness-pool.ts:21-59`);
setting it via the Manage Harnesses panel reuses the existing
`setHarnessEnabled`-style read-modify-write-preserving-comments pattern
from `src/core/harness-manifest.ts` (subtask 4 adds the model-setting
analogue). `TaskCard.model`/`harnessOverride` persist wherever the rest
of `TaskCard` already does (the board's SQLite store) — no new
migration needed beyond the standard heal-on-open `ALTER TABLE ... ADD
COLUMN` pattern already used for `harness`/`parentTaskId`.

## 7. Model list sourcing — per harness tool

No single mechanism covers all three `HarnessTool` values
(`claude-cli`, `codex-cli`, `anthropic-api`) — confirmed live, per the
parent card's shared context:

| Tool | Source | Why |
|---|---|---|
| `claude-cli` | **Static maintained list**, hand-updated in code (subtask 2) | `claude --help` has no list-models subcommand. No live introspection possible; the list is a checked-in constant, refreshed by a human/agent editing it when new models ship, not by a runtime call. |
| `codex-cli` | **Static maintained list**, hand-updated in code (subtask 2) | Same reasoning — `codex --help` has no list-models subcommand either. |
| `anthropic-api` | **Live**, via `client.models.list()` (subtask 3) | The already-installed `@anthropic-ai/sdk` (`^0.127.0`) exposes a real models-listing endpoint. This is the one tool where "daily-refreshed" means an actual network call, not a manual edit. |

"Daily-refreshed" therefore means two different things depending on
tool: for `claude-cli`/`codex-cli` it's a static list that a human
keeps current (no automation can do better without a CLI subcommand to
call); for `anthropic-api` it's a real cache with a real TTL (§8).

## 8. Cache — file-based, same convention as every other wissel state file

**Revises this section's own first draft, named here per §2's own
precedent-callout discipline**: the JSON shape below is keyed by
`Harness.id`, not by `HarnessTool` as this section originally
documented (a 3-key `anthropic-api`/`claude-cli`/`codex-cli` example).
Reason: `Harness.apiKeyEnv` (`types.ts:220-227`) is set per harness, not
per tool — two `anthropic-api` harnesses pointing at different API keys
(e.g. `api-key-1`/`api-key-2`) can legitimately see different model
lists from `client.models.list()`, and a tool-keyed cache would
silently collapse both into one shared, last-write-wins entry.
Subtask 2's implementation (`src/core/model-refresh-scheduler.ts:26-31`)
caught this during its own review and keys by harness id instead; this
section, §9, and §10 below are updated to match. **Superseded**: every
`HarnessTool`-keyed JSON example and "one entry per tool" prose
originally in this doc's §8/§9/§10 no longer holds — read "harness id"
everywhere those said "tool name". This changes nothing observable when
every harness has a distinct tool (the common case today); it only
matters once two harnesses share a tool, e.g. two `anthropic-api`
harnesses on different keys, or (once subtask 6 adds harness-level
model overrides) two `claude-cli` harnesses that still get the same
static list either way (§7).

New file, `~/.wissel/models-cache.json`, override
`WISSEL_MODELS_CACHE_PATH` — matching the existing
`WISSEL_DB_PATH`/`WISSEL_TELEMETRY_PATH` convention
(`src/api/server.ts:524-525`) and the `~/.wissel/worktrees/<id>`
convention (`src/services/worktree.ts:28-30`).

Format:

```json
{
  "api-key-1": {
    "fetchedAt": "2026-09-23T00:00:00.000Z",
    "models": ["claude-sonnet-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "..."]
  },
  "claude-personal": {
    "fetchedAt": "2026-09-23T00:00:00.000Z",
    "models": ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "..."]
  },
  "codex-personal": {
    "fetchedAt": "2026-09-23T00:00:00.000Z",
    "models": ["gpt-5.1-codex"]
  }
}
```

One entry per `Harness.id`. `claude-cli`/`codex-cli` harnesses' entries
are populated from the static list (§7) every time the cache is
written — "refreshed daily" for these just means the cache file's
`fetchedAt` rolls forward and re-copies the current static list, so
every harness shares one refresh mechanism and one file format even
though only `anthropic-api` harnesses do a real network call.
`anthropic-api` harnesses' entries are refreshed by calling
`client.models.list()` when `fetchedAt` is more than 24h old; a fetch
failure keeps that harness's existing cached entry rather than clearing
it (stale-but-present beats empty), and never blocks any other
harness's refresh in the same tick. This refresh function is subtask
2's deliverable; subtask 5 wires it to run daily (a
`setInterval`-based scheduler, same shape as
`src/core/memory-scheduler.ts`/`src/core/archive-scheduler.ts`).

## 9. Endpoints

- **`GET /models`** — returns the full cache contents (every harness,
  keyed by id per §8), reading from disk and triggering a refresh (§8)
  if any entry is missing or stale. Used by both the Manage Harnesses
  panel and the New Task form to populate model pickers. (subtask 5)
- **`PATCH /harnesses/:id`** (or a narrower `POST /harnesses/:id/model`
  — subtask 4 decides the exact verb, following the existing
  paired-action convention `POST /harnesses/:id/enable`/`/disable`
  already established in `docs/SDD-harness-enable-disable.md` §8)
  — sets `Harness.model`, persisted via the `harness-manifest.ts`
  read-modify-write pattern. `404` unknown id; `409` (per §5) if the
  named model isn't in that harness's tool's known list.
- Task creation/update (`POST /tasks`, and wherever a task's fields can
  be edited post-creation) accepts `model`/`harnessOverride` in the
  request body — validated against §5's fail-loud rule at the point
  the task is actually dispatched/run, not at creation time (a model
  that's valid today and removed from the static list tomorrow
  shouldn't retroactively invalidate an already-created task before it
  runs — but a task that reaches execution with an unresolvable
  override fails immediately per §5, since a stale field is exactly one
  of the reasons blind fallback is worse than an error here).

## 10. UI plan

**Manage Harnesses panel** (`board.html`, `#harnessPanel`/`#hmList`,
existing drawer from `docs/SDD-harness-enable-disable.md` §9, lines
618–629): each harness row gets a model `<select>` populated from
`GET /models`' entry for that harness's own id (§8), defaulting to "use
agent default" (i.e. `Harness.model` unset) plus every known model name
for that harness. Changing it calls the new endpoint from §9 and
re-fetches the harness list, same pattern the existing enable/disable
toggle already uses.

**New Task form** (`board.html`, `#newTaskPanel`/`#newTaskForm`, lines
488–547): the existing `<details id="ntAdvanced">` "Advanced: override
the router" section (lines 533–539) gains two more fields alongside the
agent-override button grid — a harness `<select>` (populated from
`GET /harnesses`, defaulting to "auto-select") and a model `<select>`
(populated from `GET /models`, scoped to whichever harness id is
selected, or the union of every harness's list if no harness is picked
yet; defaulting to "use default"). Both submit as `harnessOverride`/
`model` on the `POST /tasks` body (§9). This is the field this SDD's §2
explicitly reopens from `SDD-new-task-tab.md` §4/§7 — everything else
in that form (Title/Description/Repo/Labels/Depends-on/live routing
preview) is untouched.

## 11. Subtask breakdown (7 total)

1. **This doc** — `docs/SDD-model-selection.md`.
2. Static model lists for `claude-cli`/`codex-cli` + the precedence
   resolution helper (`resolveModel(task, harness, agent)` or
   equivalent) that every CLI-backed executor calls instead of the bare
   `this.model ?? agent.costProfile.model` it has today.
3. `anthropic-api` live model listing via `client.models.list()`, plus
   the cache read/write module (`~/.wissel/models-cache.json`, §8).
4. `Harness.model` storage + the harness-manifest.ts write path +
   the model-setting endpoint (§9).
5. `GET /models` endpoint + the daily refresh scheduler (§8).
6. `TaskCard.model`/`harnessOverride` storage + New Task form UI (§10)
   + Manage Harnesses panel UI (§10) — the `SDD-new-task-tab.md` §2
   revision lands here.
7. Fail-loud resolution wiring end-to-end (§5) across every executor +
   the full test/eval suite tying subtasks 2–6 together.

Each subtask ships its own gate tests in its own commit, per the house
rule. This doc's own acceptance criteria (existence, real citations,
named `SDD-new-task-tab.md` reconciliation, precedence + fail-loud
stated as decisions) have no code to test — subtasks 2–7 carry the test
plan below.

## 12. Test plan (unit + e2e, per subtask)

- **Subtask 2**: `test/model-lists.test.ts` (or folded into a shared
  `resolveModel` test file) — precedence resolution unit tests: task
  wins over harness, harness wins over costProfile, constructor
  override wins over all three, unresolvable override throws with a
  message naming what didn't resolve.
- **Subtask 3**: `test/models-cache.test.ts` — cache read/write against
  a real tmpfile (mirroring `harness-manifest.test.ts`'s
  `mkdtemp(join(tmpdir(), "wissel-harness-manifest-test-"))` convention,
  `harness-manifest.test.ts:10`), `client.models.list()` call mocked via
  an injectable
  client factory (same `AnthropicMessagesClient`-style injection
  `anthropic-api.ts:30-34` already establishes), stale-cache-keeps-old-
  data-on-fetch-failure case.
- **Subtask 4**: `test/harness-pool.test.ts` additions for
  `Harness.model` round-tripping through `harnesses.yaml`;
  `test/api.test.ts` additions for the model-setting endpoint (404/409
  cases per §5).
- **Subtask 5**: `test/api.test.ts` — `GET /models` returns all three
  tools' entries, triggers refresh on stale/missing data (fake clock or
  injectable "now").
- **Subtask 6**: `test/api.test.ts` — `POST /tasks` accepts and
  persists `model`/`harnessOverride`; `e2e/new-task.spec.ts` (real
  Playwright, existing `playwright.config.ts` infra — `bun run
  test:e2e`) — selecting a harness and model override in the New Task
  form's Advanced section and confirming the created task carries both
  fields.
- **Subtask 7**: end-to-end fail-loud tests per executor (`write.ts`,
  `readonly.ts`, `codex-write.ts`, `codex-readonly.ts`,
  `anthropic-api.ts` test files) — an unresolvable `TaskCard.model` or
  `harnessOverride` fails the run with a clear message, never falls
  through to the next precedence layer; a full precedence-chain
  integration test (task model > harness model > costProfile model)
  exercised through at least one real executor, not just the resolver
  in isolation.

## 13. What I need from you

Nothing — every design question in this doc was already resolved live
by the planner before this doc was written (see the parent card's
shared context: no list-models subcommand on either CLI, `@anthropic-ai/sdk`
already installed, cache convention matching existing state files).
Subtasks 2–7 build against this spec as settled.
