# SDD — Pipelines: authored, reusable multi-step agent graphs, with a canvas editor

Status: **Draft, not built.** Written per Milton's ask, following the design
conversation in this session about agetor PR #244 (`alamops/agetor#244`,
"Pipelines: canvas-built multi-agent step graphs with a handoff runner").
Milton has already resolved the single biggest fork: a real drag-and-drop
canvas (React Flow, matching agetor's own choice), not a form-based editor —
Wissel's first frontend framework and build step, a deliberate, confirmed
departure from the zero-build-tooling convention every other tab in
`board.html` follows.

## 1. Goal

Two things, in order:

1. A **Pipeline** becomes a first-class, storable, reusable object: a graph
   of steps, each bound to a Wissel agent, authored once via a canvas editor,
   run as many times as wanted.
2. Wissel's own existing review-handoff loop (implementer → reviewer →
   pushback re-attempt × up to 5 → escalate, today hardcoded across
   `finishResult`/`spawnReviewerTask`/`handleReviewVerdict`/
   `spawnPushbackImplementer`/`buildEscalationContext` in
   `src/core/orchestrator.ts`) gets **recreated as a pipeline definition**
   running on the new engine — proof the engine is actually general enough
   to replace hand-written orchestration code, not just handle new cases.

## 2. What I looked at

`alamops/agetor#244` in full (PR description, review-history notes, the
four listed migrations) — specifically its **step-graph model** (labelled
edges, choose/all transitions, any/all joins, fan-out), its **handoff
contract** (`<handoff>` JSON block, nonce-fenced untrusted previous
handoffs, linear last-block parser with per-field/array/total caps, `next`
resolved by name → id → edge-label), and its **round-4 reliability fixes**
(every terminal spawn path must emit a status event; a quadratic parser
became a linear scanner over a bounded tail). None of agetor's own source
was read — the PR description and review notes are the only agetor
material this doc draws from; everything below is designed against
Wissel's actual code.

On Wissel's side: `src/core/orchestrator.ts` (`finishResult`'s full
branch set — the thing being generalized; `spawnReviewerTask`/
`handleReviewVerdict`/`spawnPushbackImplementer`/`buildEscalationContext`
as the concrete pattern the first real pipeline definition has to
reproduce; `wireAutoIntegrator`/`maybeSpawnIntegrator` as the existing
precedent for "watch board events, react when a whole subtree settles"),
`src/executors/claude-cli.ts` (`outputContractFormat`'s existing
discriminator — `"review-verdict"`/`"subtask-plan"` — the mechanism a
third value slots into), `src/executors/parse-review-verdict.ts` and
whatever `parse-subtask-plan.ts` has become (the existing "trailing
fenced block, parsed deterministically, fails closed on anything
malformed" pattern this doc's own parser follows), `src/api/public/
board.html` (`findLineageRoot`/`renderSwimlanes` — confirmed a pipeline
run's step cards, grouped by `parentTaskId`, already render correctly as
one lane with zero changes, since a pipeline run *is* a lineage tree),
`package.json` (confirms zero frontend framework/build step exists
anywhere in this project today — the canvas editor is a genuinely new
kind of thing here, not an extension of an existing pattern).

## 3. Design decisions, stated plainly

**3.1 — Steps stay fully visible `TaskCard`s. This is a deliberate,
confirmed departure from agetor's hidden-step model**, not an oversight.
Milton's own earlier, explicit ask this session was "fan-out to subtasks
needs to be visible" — and the instruction to "recreate Wissel's current
pipeline" is itself an instruction to reproduce today's fully-visible
implementer/reviewer/pushback cards, not agetor's single-parent-card-plus-
hidden-steps shape. A pipeline run is: one root `TaskCard` (the "pipeline
task," matching agetor's own term for it) plus one real, board-visible
`TaskCard` per step actually executed, connected by the existing
`parentTaskId` mechanism. **Swimlanes already renders this correctly with
zero changes** — a pipeline run is exactly the lineage-tree shape
Swimlanes was built for.

**3.2 — Canvas-authored, drag-and-drop, React Flow (`@xyflow/react`) +
Vite.** Per Milton's confirmed choice. Same library agetor itself uses —
not re-litigated, it's the standard tool for this and already proven at
the scale this needs. Lives in its own directory (`pipeline-editor/`, own
`package.json`/`vite.config.ts`, own build step), built to static
assets served by the existing Bun server at `/pipelines/edit` — **not**
merged into `board.html`'s single-file vanilla-JS bundle. Keeps every
existing tab (Board/Swimlanes/New task/Memory/Archive) completely
untouched; the new build tooling is isolated to exactly the one place
that needs it.

**3.3 — New engine ships additively; migrating existing `handoffs:
[reviewer]` agents onto it is a separate, later phase, not bundled here.**
The current review-handoff loop is Wissel's most exercised, most
battle-tested subsystem — real work has run through it dozens of times
this session alone. Phase 1 (this doc's full scope) builds the generic
engine and proves it by defining the review-handoff pattern as a real
pipeline template that a human can choose to run — coexisting with, not
replacing, the existing hardcoded path. `agents/manifest.yaml`'s
`handoffs: [reviewer]` mechanism keeps working exactly as it does today.
Phase 2 (explicitly out of scope, named here so it isn't forgotten) is
retiring `spawnReviewerTask`/`handleReviewVerdict`/
`spawnPushbackImplementer`/`buildEscalationContext` in favor of routing
every write-tier agent through the new engine — only once Phase 1's
recreated pattern has actually proven itself equivalent on real work.

**3.4 — The handoff contract is a new `outputContractFormat` value,
`"pipeline-handoff"`, generic across every step — not review-verdict
reused.** A step's final message must end:

```pipeline-handoff
{"next": "<step name, id, or outgoing edge label>", "data": {...}, "note": "..."}
```

`next` resolves the same way agetor's does — by exact step name, then
step id, then outgoing edge label — the first match wins, an ambiguous or
unresolvable value fails the run closed (never guesses, matching
`parseReviewVerdict`'s own "never default to approve" discipline). `data`
is a free-form object the next step's prompt is built from. A step
declaring `transitions: "all"` (fan-out) doesn't need `next` at all — the
engine activates every outgoing edge regardless of what the block says;
`next` only matters for a `"choose"` step (agetor's term, kept as-is).
Recreating `review-verdict` behavior inside this system (§6's Subtask 5)
means the reviewer step's own prompt instructs it to emit `next: "retry"`
or `next: "escalate"` or `next: "approve"` — `review-verdict`'s
`{verdict, feedback}` shape isn't reused or extended; it's superseded by
the general contract for anything running as a pipeline step. Non-pipeline
uses of the reviewer agent (today's hardcoded loop) keep using
`review-verdict` untouched, per §3.3.

**3.5 — Untrusted prior-step data gets nonce-fenced before reaching the
next step's prompt.** Directly from agetor's round-4 hardening, and a
real, currently-unaddressed gap in Wissel: `spawnPushbackImplementer`
today embeds a reviewer's raw `reviewFeedback` text straight into the
next attempt's task body, unsanitized — text a prior step produced (which
could itself contain something shaped like a fenced contract block, by
accident or by a confused/manipulated model) flows verbatim into a later
step's own prompt. Every `data`/`note` field composed into a step's
prompt gets wrapped in a random-per-run nonce fence
(` ```untrusted-<nonce>` / ` ``` `) with an explicit prompt instruction
that content inside it is data from a prior step, never instructions to
follow — the same shape agetor's PR describes. This is worth a matching
follow-up on the *existing* pushback path too (flagged, not built here —
out of scope per §3.3's phasing, but real).

**3.6 — Joins: `"any"` and `"all"`, matching agetor's own two modes.** A
step with multiple incoming edges either fires the moment the first
predecessor completes (`"any"`) or waits for every predecessor under the
same `pipelineRunId` to reach a terminal state first (`"all"`). Computed
by the same kind of "check every sibling under this scope" query
`maybeSpawnIntegrator` already does for subtask-set completion — no new
traversal primitive needed, the existing one generalizes.

**3.7 — Storage: one `pipelines` table for definitions, three new
`TaskCard` fields for a run.** `pipelines(id, name, description, graph
JSON, createdAt, updatedAt)` — `graph` is the step/edge/transition
definition the canvas reads and writes, opaque to everything else.
`TaskCard` gains `pipelineId?`, `pipelineRunId?` (defaults to the root
task's own id, same "reuse the originating id, no separate id to keep in
sync" pattern `reviewLineageId` already established), `pipelineStepId?`
(which step in the definition this card is an instance of). All three
`undefined` for every non-pipeline task — zero effect on anything that
isn't one.

## 4. Implementation shape

**Schema** (`src/services/board.ts`): `pipelines` table, heal-on-open
migration for the new `TaskCard` columns, following the exact
`ALTER TABLE ... ADD COLUMN` try/catch pattern every prior column
addition already uses.

**`src/services/pipelines.ts`** (new — storage layer, mirrors
`src/services/board.ts`'s own shape): CRUD for pipeline definitions
(`create`/`get`/`list`/`update`/`delete`), no execution logic here.

**`src/executors/parse-pipeline-handoff.ts`** (new, mirrors
`parse-review-verdict.ts` exactly): pure parser for the
`pipeline-handoff` fenced block — same "trailing block, strict shape,
null on anything malformed, never a fallback guess" contract. Wired into
`runClaude`'s result mapping (`src/executors/claude-cli.ts`) the same way
`outputContractFormat === "review-verdict"` already triggers
`parseReviewVerdict` — a third `else if` branch, not a rewrite.

**`src/core/pipeline-runner.ts`** (new, mirrors `memory-scheduler.ts`/
`archive-scheduler.ts`'s "one file per concern" convention):
- `startPipelineRun(board, registry, pipelineDef, repo, input): Promise<TaskCard>`
  — creates the root pipeline task, creates every entry step (a step
  with no incoming edges) as its own child `TaskCard`.
- `handlePipelineStepResult(board, registry, result): Promise<void>` —
  the `finishResult` hook (called the same way `handleReviewVerdict`
  already is, keyed off `result` carrying a parsed pipeline-handoff
  instead of a review-verdict): resolves `next`, checks join conditions
  for the target step (§3.6), nonce-fences `data`/`note` (§3.5), creates
  the next step `TaskCard`(s), and — when a step has no satisfied
  outgoing transition (a real terminal step) and every other in-flight
  step under this `pipelineRunId` has also settled — moves the root
  pipeline task to `done`.
- Nonce generation and fencing live here, not in the executor — one
  place owns "what untrusted text looks like inside a composed prompt."

**`src/core/orchestrator.ts`**: `finishResult` gains one more branch,
parallel to the existing `result.verdict !== undefined` check —
`result.pipelineNext !== undefined` (or however the parsed handoff
surfaces on `TaskResult` — mirrors `verdict`/`reviewFeedback`'s own
"flattened onto TaskResult so the caller doesn't need a second lookup"
shape) routes to `handlePipelineStepResult` instead of the existing
done/review logic entirely — a pipeline step's own done-vs-review
decision is owned by the pipeline definition, not `finishResult`'s
default policy.

**`src/api/server.ts`**: `GET/POST/PUT/DELETE /pipelines`,
`GET /pipelines/:id`, `POST /pipelines/:id/run` (body: `{repo, input}`,
returns the created root `TaskCard`), `GET /pipelines/:id/runs` (every
root task with this `pipelineId`, most recent first — mirrors
`getMemoryCurationHistory`'s own shape). New static route serving
`pipeline-editor/`'s built output at `/pipelines/edit`
(and `/pipelines/edit/:id` for editing an existing one).

**`pipeline-editor/`** (new top-level directory — own `package.json`,
`vite.config.ts`, React + `@xyflow/react`): step nodes (agent picker,
name), labelled edges, a transition-type toggle per step (`choose` vs
`all`), a join-mode toggle per multi-input step (`any` vs `all`), save/
load against the new `/pipelines` API, a "Run" button that calls
`POST /pipelines/:id/run` and redirects to the board (filtered to that
run's lane in Swimlanes — the existing view, no new run-viewer needed,
per §3.1).

**`src/api/public/board.html`**: one more nav link out to `/pipelines/edit`
(not a `data-view` tab — it's a separate page/bundle, per §3.2) —
everything else in this file is untouched. `renderSwimlanes` needs no
change; a pipeline run's cards already group correctly by
`findLineageRoot`.

## 5. What this deliberately does not do

- **No CLI/TUI parity.** Agetor's `agetor pipeline ls|show|rm|...` isn't
  ported — Wissel's existing `bun run agents`/`why`/`team` CLI surface
  is untouched; revisit only if the board UI genuinely isn't enough day
  to day.
- **No per-step subagent persona/cap declarations.** Wissel's existing
  subagent-visibility feature (`TaskResult.subagents`) stays purely
  observational; a pipeline step doesn't get its own subagent policy in
  this phase.
- **No migration of existing `handoffs: [reviewer]` agents onto the new
  engine.** Explicit, named Phase 2 — see §3.3.
- **No retroactive nonce-fencing of the existing pushback path.** Named
  as a real, related gap in §3.5; not built here.
- **No pipeline versioning/history of a definition's own edits.** Editing
  a saved pipeline overwrites it in place, same as every other
  `PUT`-style resource in this codebase (`harnesses.yaml`'s own
  enable/disable persistence, for comparison) — a past *run*'s own step
  cards are unaffected either way, since they're real, independent
  `TaskCard`s, not references back to a live definition.

## 6. Subtasks

### 1. Data model: `pipelines` table + `TaskCard` pipeline fields
`pipelines` schema, `TaskCard.pipelineId`/`pipelineRunId`/`pipelineStepId`,
heal-on-open migrations for both.

**Acceptance criteria**
- Round-trip test: create/get/list/update/delete on `pipelines`, and
  the three new `TaskCard` fields surviving `create`/`get` exactly like
  every other optional field already does in `test/board.test.ts`.
- Heal-on-open test: a pre-existing on-disk DB from before this schema
  existed opens and writes both cleanly.

### 2. `pipeline-handoff` parser + `outputContractFormat` wiring
`parse-pipeline-handoff.ts`, the new `runClaude` branch, `TaskResult`
gains whatever flattened fields the handoff needs (mirroring
`verdict`/`reviewFeedback`'s existing shape).

**Acceptance criteria**
- Gate tests: valid `choose` handoff, valid `all`/fan-out handoff (no
  `next` needed), missing block, malformed JSON, an unresolvable `next`
  value — each asserted against exact expected output/failure, never a
  guessed fallback.
- `runClaude` regression test: an agent with `outputContractFormat:
  "review-verdict"` is completely unaffected by this addition.

### 3. `pipeline-runner.ts`: run creation, step transitions, joins, nonce-fencing
`startPipelineRun`, `handlePipelineStepResult`, the join-satisfaction
check, nonce generation/fencing for composed prompts.

**Acceptance criteria**
- A linear 3-step pipeline (A → B → C) run end-to-end against real
  SQLite + a fake `CommandRunner` (no real `claude` process): 3 real
  child `TaskCard`s created in order, root reaches `done` once C
  settles.
- A fan-out step (`all` transition) creates every outgoing step at once;
  an `any` join fires on the first predecessor; an `all` join waits for
  every predecessor under the same `pipelineRunId`.
- A step's `data`/`note` reaching the next step's composed prompt is
  wrapped in the nonce fence — a test asserts the fence is actually
  present and the nonce differs run to run.
- `finishResult`'s new branch never fires for a non-pipeline
  `TaskResult` (no `pipelineId` set) — the entire existing review-handoff
  test suite (`test/orchestrator-review-lifecycle.test.ts`, etc.) passes
  completely unchanged.

### 4. API endpoints
`/pipelines` CRUD, `/pipelines/:id/run`, `/pipelines/:id/runs`.

**Acceptance criteria**
- Standard REST-shape tests matching this project's existing endpoint
  test conventions (`test/api.test.ts`) — status codes, real `BoardEvent`
  emission on run-creation, 404s for unknown ids.

### 5. Recreate Wissel's review-handoff loop as a pipeline definition
The actual proof-of-generality piece: a real `PipelineDef` — implementer
step → reviewer step (`choose`: `approve` → done, `changes_requested` →
back to a fresh implementer step, capped the same 5-retry way
`handleReviewVerdict` already enforces) → escalate step on cap-out.

**Acceptance criteria**
- A live smoke test (real `claude`, real worktree — same standard
  `docs/SDD-pipeline-automation.md`'s own subtask 3 was held to): a
  seeded task run through this pipeline reaches the same outcome the
  existing hardcoded loop would for equivalent input.
- Explicit written comparison (in the PR/commit description, not just
  code) against `handleReviewVerdict`'s real behavior: same pushback
  cap, same worktree-reuse-via-lineage behavior, same escalation
  trigger — named point by point, not asserted vaguely.

### 6. Pipeline editor (`pipeline-editor/`)
Vite + React + `@xyflow/react` app: node/edge canvas, agent picker per
step, transition/join-mode toggles, save/load against the API, a Run
button, served at `/pipelines/edit`.

**Acceptance criteria**
- Manual browser verification (per house UI-testing rule) with a real
  screenshot: build a small graph, save it, reload the page, confirm it
  loads back identically, run it, confirm a real pipeline task appears
  on the board (and its lane in Swimlanes).
- `bun run build` (or the editor's own equivalent) produces static
  output `server.ts` can actually serve — verified by hitting
  `/pipelines/edit` against a real running server, not just a dev
  server.

## 7. Sequencing

1 blocks everything. 2 and the editor's own scaffolding (6, minus its
"Run" button) can start in parallel with 3 once 1 lands. 3 needs 2. 4
needs 1 and 3. 6's "Run" button needs 4. 5 needs 3 and 4 both fully
working — it's the integration proof, not a standalone piece, and
should land last.

## 8. Verification

Same standard every prior subtask in this project has been held to:
gate tests for every pure function (the handoff parser, join-satisfaction
check) with no real process spawn, integration tests against real
SQLite + real git worktree fixtures for the runner, a real live smoke
test (actual `claude`, actual spend) for subtask 5 specifically since
that's the one claiming behavioral equivalence with existing production
code, e2e/manual-browser verification for the canvas editor, and
independent verification (`bun run typecheck` + `bun test test/` green,
the editor's own build succeeding) before any of this is called done.

## 9. Subtask 5 — built, and compared point-by-point against `handleReviewVerdict`

**Built.** `src/core/review-handoff-pipeline.ts` (`buildReviewHandoffPipelineGraph`)
constructs the recreated `PipelineDef`'s graph: `REVIEW_HANDOFF_PUSHBACK_LIMIT
+ 1` (6) `implementer` step / `pipeline-reviewer` step pairs, chained
`retry` edges between consecutive pairs, an `approve` edge from every
reviewer step to a shared `approved` terminal, and an `escalate` edge
from only the final (6th) reviewer step to a shared `escalated` terminal.
`agents/manifest.yaml` gained one new agent, `pipeline-reviewer`
(`outputContractFormat: pipeline-handoff`) — deliberately a *separate* id
from `reviewer`, not a modification of it (see the agent's own manifest
comment for why: `outputContractFormat` is static per agent, so the same
id can't emit both `review-verdict` for the hardcoded loop and
`pipeline-handoff` for a pipeline step). The two terminal "notice" steps
reuse the existing `quick-answer` skill as-is — no new agent needed for a
step whose own output is never read. `implementer` (the real, existing
write-tier agent) is reused completely unchanged for every implementer
step, with `transition: "all"` so it never needs a `pipeline-handoff`
contract at all — see the graph builder's own doc comment for why giving
`implementer` one would have broken the hardcoded loop's own, unrelated
implementer runs. `test/review-handoff-pipeline.test.ts` (gate lane, real
manifest via `Registry.load()`, scripted `claude`/Anthropic responses)
proves: the graph's shape, an approve-on-first-try run reaching `done` via
`approved` after exactly 1 implementer attempt, a reject-every-time run
reaching `done` via `escalated` after exactly 6 implementer attempts, and
—concretely, not just asserted — that a literal retry cycle has no valid
entry step at all and fails before a single step runs, which is why this
graph unrolls the bounded loop into 6 distinct step-id pairs instead of a
real cycle. `eval/pipeline-review-handoff.eval.ts` is the live smoke test
(real `claude`, real git worktrees, real tiny Anthropic calls for the
terminal steps) — see its own doc comment and `eval/README.md`'s matching
section for the two fixtures and pass bar; **not yet empirically run**,
for the same reason `eval:implementer-reviewer` originally wasn't (no
subprocess-spawn access in the session that wrote it — see that eval's
own "Status" note) — run it before relying on this pipeline for anything
real.

**Point-by-point comparison against `handleReviewVerdict` and its
neighbors (`spawnReviewerTask`/`spawnPushbackImplementer`/
`buildEscalationContext`, all in `src/core/orchestrator.ts`, none touched
by this subtask):**

| Behavior | Legacy hardcoded loop | Recreated `PipelineDef` | Match? |
|---|---|---|---|
| Pushback cap | `pushbackCount >= 5` checked in code (`handleReviewVerdict`) — 1 initial attempt + up to 5 re-attempts, escalate on the 6th rejection | 6 static implementer/reviewer step-id pairs, escalate edge only from the 6th reviewer | **Yes** — same effective cap, same trigger point |
| Who decides retry-vs-escalate | Deterministic code, off `pushbackCount` — the reviewer agent never sees or reasons about the cap, it only ever says `approve`/`changes_requested` | The `pipeline-reviewer` LLM itself, informed only by its own step's title text ("FINAL attempt... you MUST respond next: escalate") | **No** — a real, load-bearing behavior change: a step that mis-reads its own title and answers "retry" on the final attempt fails the run (closed, not silently), where the legacy loop can't ever make this mistake because code decides, not the model |
| Worktree reuse across pushback rounds | `WriteExecutor`/`CodexWriteExecutor` key the worktree off `task.reviewLineageId ?? task.id` (`src/services/worktree.ts`'s `createTaskWorktree`) — every re-attempt in a lineage reuses the exact same worktree/branch, so a fix lands on top of the previous attempt's own (possibly uncommitted) edits | `pipeline-runner.ts`'s `runStepAndSuccessors` never sets `reviewLineageId` on a step's `TaskCard` — each `impl-N` step gets its own fresh worktree keyed by its own task id, cloned off whatever commit `impl-(N-1)`'s worktree was at (its own edits, if uncommitted, are simply not there) | **No** — confirmed by tracing `createTaskWorktree`/`WriteExecutor.run`, not assumed: an uncommitted implementer edit from attempt N is invisible to attempt N+1, unlike the legacy loop where it's still sitting in the working tree waiting to be revised |
| Auto-merge on approval | `resumeAfterApproval` calls `tryAutoMerge` for an `autoMerge: true` + `trustLevel: "high"` agent — a real `git merge --no-ff` lands the diff | `finishResult`'s pipeline branch (`task.pipelineId !== undefined`) returns before ever reaching the `autoMerge`/`handoffs` code — no merge is ever attempted for a pipeline step, approved or not | **No** — an approved pipeline run leaves its final diff sitting uncommitted in its own worktree; landing it is a manual step outside this pipeline in Phase 1 |
| Feedback carried to the next attempt | `spawnPushbackImplementer` appends **every** prior round's feedback, cumulatively, to the next attempt's body | `handlePipelineStepResult`'s `buildNextStepBody` composes the next step's body from `root.body` plus only the **immediately preceding** step's own `note` — this is `pipeline-runner.ts`'s own existing (already-shipped, subtask 3) behavior, not something this subtask changed | **No** — a pre-existing engine limitation, not introduced here: multi-round review history isn't threaded forward the way the legacy loop's body-accumulation does |
| Escalation's final state | `board.escalate(id, escalationContext)` — a dedicated `"escalated"` `TaskCard.status`, with `escalationContext` set | The `escalated` terminal step's own `TaskCard` (and the root) land on the engine's ordinary `"done"` — there's no bespoke terminal status for the generic engine to move a run to | **No** — functionally similar (a human still finds a clearly-labelled card to act on) but not the same status value; a human/tool that filters on `status === "escalated"` specifically won't find a pipeline run's escalation this way |
| Untrusted prior-step text reaching the next prompt | `spawnPushbackImplementer` embeds the reviewer's raw `reviewFeedback` unsanitized — the real, named gap in §3.5 | `buildNextStepBody` nonce-fences the reviewer's `note` before it reaches the next implementer's prompt, exactly per §3.5 | **Better, not just matching** — this is the one place the recreation improves on the legacy loop's own real, still-open gap |
| Reviewer sees the right diff | `spawnReviewerTask` sets the reviewer's `repo` to `result.worktree?.path ?? implementerTask.repo` | `handlePipelineStepResult` sets `repoForNext` the same way, off `result.worktree?.path ?? task.repo` | **Yes** |

**Worth reconsidering in §3, now that this is built:**

- **§3.3's framing ("proves it by defining the review-handoff pattern as
  a real pipeline template") needs a caveat.** This subtask proves the
  engine can reproduce the loop's *routing shape* — the attempt cap, the
  choose/retry/escalate branching, the escalate-only-at-the-cap trigger —
  convincingly. It does **not** yet prove behavioral equivalence on the
  four items marked "No" above. Anyone reading §3.3 as "the engine is a
  drop-in replacement, Phase 2 is just flipping a switch" would be wrong;
  Phase 2 needs to actually decide what to do about worktree continuity,
  auto-merge, and cumulative feedback before it can retire the hardcoded
  path without a real regression.
- **A bounded retry loop only works unrolled, and that doesn't scale to a
  runtime-decided bound.** `startPipelineRun`'s entry-step rule (a step
  with zero incoming edges) means a literal cycle has no entry point at
  all and fails immediately — see this doc's own Subtask 5 test coverage.
  A fixed cap of 5 unrolls fine; a cap that needs to change per-run (not
  just per-graph-edit) has no expression in this engine today. If bounded
  retry loops turn out to be a common pipeline pattern, the engine may
  need a first-class "loop with a counter" primitive rather than making
  every author hand-unroll their own cap.
- **Moving the retry-vs-escalate decision from code into the reviewing
  agent's own prompt-reading is a real trust shift**, worth a deliberate
  callout, not a side effect users discover by reading this doc closely.
  The legacy loop can never escalate one round early or retry one round
  late; the recreated pipeline can, if the model misreads its own step's
  title. The gate test suite proves the *fail-closed* behavior when this
  happens (an invalid `next` fails the run rather than guessing), but
  "the run fails" is a worse outcome than "the loop makes the right call
  because code enforces it," which is what the legacy loop guarantees
  today.
- **Worktree-reuse-via-lineage and auto-merge are real, missing pieces of
  parity**, not stylistic differences — a future Phase 2 that just
  "routes implementer through the pipeline engine instead" without first
  adding some equivalent of `reviewLineageId`-keyed worktree reuse and an
  auto-merge hook would silently make every real pushback round redo work
  from scratch instead of revising it, and leave every approved diff
  sitting unmerged. Both are pipeline-runner.ts/finishResult concerns,
  deliberately untouched by this subtask (see the card's own hard
  constraint) — flagged here for whoever picks up Phase 2.
