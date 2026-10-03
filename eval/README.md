# Periodic evals

Not run by `bun test` (the gate lane — deterministic, free, <2s per house
rule). These make real `claude` calls, cost real money, and take real
wall-clock time. Run explicitly before ship, and nightly.

| Eval | Command | What it proves |
|---|---|---|
| `eval/readonly.eval.ts` | `bun run eval:readonly` | ReadOnlyExecutor's plan-mode enforcement actually holds against a subprocess that tries to write. |
| `eval/implementer-reviewer.eval.ts` | `bun run eval:implementer-reviewer` | The automatic implementer→reviewer loop (`src/core/orchestrator.ts`'s `finishResult`/`handleReviewVerdict`) converges correctly against a *real* reviewer, not a scripted one. |
| `eval/planner-subtask-plan.eval.ts` | `bun run eval:planner-subtask-plan` | The real planner agent reliably produces a well-formed ```subtask-plan``` block against a vague card, and `finishResult`'s `spawnSubtasksFromPlan` turns it into real child cards with correct `dependsOn` chaining. |
| `eval/pipeline-review-handoff.eval.ts` | `bun run eval:pipeline-review-handoff` | The review-handoff loop recreated as a real `PipelineDef` (`src/core/review-handoff-pipeline.ts`) actually converges through `startPipelineRun` end to end against real `implementer`/`pipeline-reviewer` agents — see docs/SDD-pipelines.md §6 Subtask 5. |
| `eval/pipeline-full-lifecycle.eval.ts` | `bun run eval:pipeline-full-lifecycle` | The full task lifecycle `PipelineDef` (`src/core/full-lifecycle-pipeline.ts` — triager in front of the same review-handoff loop) actually converges end to end against real `triager`/`implementer`/`pipeline-reviewer` agents — see docs/SDD-pipelines.md §10. |
| `eval/pipeline-mcp-integration.eval.ts` | `bun run eval:pipeline-mcp-integration` | A heterogeneous pipeline (a file-editing coding step bound to `implementer`, then an MCP-tool-calling step bound to `mcp-tool-caller`) actually composes end to end through `startPipelineRun` against a real, attached MCP server — see docs/SDD-mcp-orchestration.md §6 Subtask 7. |
| `eval/live-task-output.eval.ts` | `bun run eval:live-task-output` | A real `claude -p` call's streamed stdout actually lands in the durable task-output store and is deliverable live over a real HTTP SSE connection, end to end — spawn -> stream -> store -> SSE -> render — see docs/SDD-live-task-output.md §6 Subtask 5. |

## implementer-reviewer eval

`test/orchestrator-review-lifecycle.test.ts` (gate lane) already proves
the state machine transitions correctly — approve, pushback, escalate —
against a scripted reviewer verdict fed in by hand. What that can't
prove is whether the real reviewer agent produces the *right* verdict
against real implementer output. This eval checks that, end to end, with
no mocks: real `claude -p` calls for both roles, real git worktrees, the
real agent manifest (`agents/manifest.yaml`).

Six fixtures, each in its own throwaway git repo:

- **4 fixable** — two trivial single-function tasks (pass-first-try is
  the expected case) and two with several precise, easy-to-get-subtly-
  wrong acceptance criteria (a real pushback round or two is plausible,
  but always resolvable).
- **1 unfixable** (`contradictory-parity`) — acceptance criteria that
  directly contradict each other (criterion 3 requires
  `isEvenSpecial(7) === false` because 7 is odd; criterion 4 requires
  `isEvenSpecial(7) === true`). No implementation can satisfy both, so a
  reviewer reading the criteria correctly must reject every attempt.

Each fixture is driven through 6 rounds (a round = the pending
implementer attempt running, then its reviewer running — see
`driveRounds` in the gate test for the same pattern). Six is not an eval
knob: it's `handleReviewVerdict`'s own `pushbackCount >= 5` escalation
limit in `src/core/orchestrator.ts` — if that limit ever changes,
`ROUNDS` in the eval script must change with it, and the eval script
comment says so at the point it's used.

### Pass bar

- **Fixable fixtures**: ≥80% must reach `review` or `done` within the 6
  allowed attempts (currently 4 fixtures, so this means at least 4 of
  4 — see the note below on tightening this if the fixture count grows
  and some slack is wanted).
- **Unfixable fixture**: must reach `escalated` with **exactly 6**
  implementer attempts in its lineage — every run, not just on average.
- Both conditions must hold for the eval to pass; the script exits 1 and
  prints a per-fixture PASS/FAIL breakdown (plus total real spend) if
  either fails.

### Status — not yet empirically run

This eval script was written without Bash access in this session (the
implementer task that produced it was scoped read/write-file only), so
**the pass rate above has not been observed against real `claude`
calls**. The fixtures and the 80%/exactly-6 thresholds are a considered
design, not a measured result — the first real run (see the scheduled
command below) is also the first empirical check of whether the
`contradictory-parity` fixture reliably provokes rejection from the real
reviewer model every time, and whether the two "needs 1-2 rounds"
fixable fixtures actually need rounds rather than passing first try
(harmless either way for the pass bar, since both outcomes land in
`review`/`done`). If the first real run shows the unfixable fixture
occasionally getting approved by mistake, or a fixable fixture
oscillating past 6 rounds, that's a real finding about the reviewer
prompt/manifest — file it, don't just loosen the threshold to make the
eval green.

### Scheduling — before ship and nightly

This needs cron/CI config access wissel itself doesn't have. Milton runs
these:

**Cron (nightly, e.g. 2am local), from the repo root:**

```bash
crontab -e
# add:
0 2 * * * cd /path/to/wissel && /usr/bin/env timeout 1800 bun run eval:implementer-reviewer >> ~/.wissel/eval-implementer-reviewer.log 2>&1
```

`timeout 1800` (30 min) bounds a hung `claude` subprocess — the eval
script has no internal timeout of its own, this is the standard,
already-installed tool for it rather than bespoke process-timeout code.
Adjust the path and the cron time to taste.

**Before ship (CI), as a required step on the release/merge workflow:**

```yaml
- name: Periodic eval — implementer/reviewer loop
  run: timeout 1800 bun run eval:implementer-reviewer
```

Needs `claude` authenticated in the CI environment the same way any
other write-tier harness does (see `docs/SDD-execution-harnesses.md`) —
this is real local-Claude-Code usage per the house LLM-access rule, not
a hosted API call, so it needs a real authenticated `claude` CLI
session available to the runner, not just an API key.

## planner-subtask-plan eval

`test/parse-subtask-plan.test.ts` and `test/orchestrator.test.ts` (gate
lane) already prove the parsing and card-spawning logic is correct
against a scripted plan fed in by hand. What that can't prove is whether
the real planner — running in real plan mode, with zero write access —
actually respects the `outputContractFormat: subtask-plan` contract
(`agents/manifest.yaml`) often enough to be useful: does it reliably end
its message with a well-formed `\`\`\`subtask-plan` block, and does its
`dependsOnIndex` chaining hold up against real model output rather than
a hand-written fixture. This eval runs two vague, `whenToUse`-shaped
cards through the real planner and confirms `finishResult` turns the
real response into real child cards on a real board.

### Pass bar

Every fixture must: come back `ok: true` (which already implies
`parseSubtaskPlan` accepted the block), produce at least 2 subtask
items, and — once `finishResult` spawns them — leave the planner task
`done` with exactly that many real child cards, every declared
`dependsOnIndex` resolved to the right sibling's real id. 100% of
fixtures, every run — same "no silently discarded decomposition" bar
this feature exists to guarantee, never loosened to make the eval green.

### Scheduling

Same pattern as `eval:implementer-reviewer` above — add a nightly cron
line and a required CI step for `bun run eval:planner-subtask-plan`,
same `timeout 1800`, same real-authenticated-`claude` requirement.

## pipeline-review-handoff eval

`test/review-handoff-pipeline.test.ts` (gate lane) already proves the
recreated `PipelineDef`'s *shape* is correct — the right number of
implementer/reviewer step pairs, the escalate-only-on-the-6th-rejection
cap, fail-closed on an unresolvable `next` — against a scripted
claude/Anthropic stand-in. What that can't prove is whether the real
`implementer` and `pipeline-reviewer` agents (`agents/manifest.yaml`)
actually converge through `startPipelineRun` end to end: does the
reviewer reliably emit a well-formed `\`\`\`pipeline-handoff` block, does
it correctly read its own step's title to know whether "retry" or
"escalate" is the right choice on the final attempt, and does the whole
graph reach the same terminal outcome the legacy hardcoded loop would for
equivalent input. Two fixtures, reused from `eval:implementer-reviewer`'s
own roster so the two systems are compared against literally the same
inputs:

- **trivial-sum** (fixable) — expected to reach `done` via the
  "approved" terminal step after exactly 1 implementer attempt.
- **contradictory-parity** (unfixable) — expected to reach `done` via the
  "escalated" terminal step after exactly `REVIEW_HANDOFF_PUSHBACK_LIMIT + 1`
  (6) implementer attempts, the same cap `handleReviewVerdict` enforces
  in the legacy loop.

### Pass bar

Both fixtures must land on `done`, each via its own expected terminal
step (`approved`/`escalated`) with the exact expected implementer-attempt
count. Either fixture landing on `failed` instead — a violated
pipeline-handoff contract, an unresolvable `next`, a missing agent — is a
real finding about the recreated pipeline, not something to paper over by
loosening the bar.

### Status — not yet empirically run

Same situation as `eval:implementer-reviewer` when it was first written
(see that eval's own "Status" note above): this script was written
without subprocess-spawn access in this session (the implementer task
that produced it was scoped to file reads/writes and `bun test`/`bun run
typecheck` only — real `claude`/git-worktree calls require approval this
session's sandbox doesn't grant), so **it has not yet actually been run
against real `claude` calls**. The graph and fixtures were traced by hand
against `pipeline-runner.ts`'s real code (see docs/SDD-pipelines.md §6
Subtask 5's comparison section for the full trace), and the gate test
(`test/review-handoff-pipeline.test.ts`) proves the shape end to end with
a scripted stand-in — but the first real run of this eval is also the
first empirical check that `pipeline-reviewer` reliably produces a
well-formed `\`\`\`pipeline-handoff` block against real model output, and
correctly reads its own step's title to choose "retry" vs "escalate" on
the final attempt. Run it (`bun run eval:pipeline-review-handoff`) before
relying on this pipeline for anything real, and update this note with the
actual result once it's been observed.

### Scheduling

Same pattern as the other evals above — add a nightly cron line and a
required CI step for `bun run eval:pipeline-review-handoff`, same
`timeout 1800`, same real-authenticated-`claude` requirement.

## pipeline-mcp-integration eval

`test/mcp-integration-pipeline.test.ts` (gate lane) already proves the
recreated `PipelineDef`'s *shape* is correct — two steps, the right
agent ids, a single "all"-transition edge between them — and
`test/pipeline-runner.test.ts` already proves, against a scripted
stand-in, that a pipeline step whose result carries a pending MCP
approval request correctly parks on `"review"` with `pendingMcpApproval`
set, and that the run stays `"running"` rather than being declared
`"done"` around it (the real bug this eval's own Scenario 2 found and
drove the fix for — see `src/core/orchestrator.ts`'s `finishResult` and
`src/core/pipeline-runner.ts`'s `settleRoot`, and this eval's own header
comment for the full story). What neither gate test can prove is whether
the real `implementer` and `mcp-tool-caller` agents (agents/manifest.yaml)
actually converge through `startPipelineRun` against a *genuine* attached
MCP server (`eval/fixtures/mcp-echo-server.ts`, a real hand-rolled stdio
JSON-RPC 2.0 server — not the official SDK, not a mock) — this is also
the first real, unscripted round trip confirming the `stream-json`
tool-call event shape docs/SDD-mcp-orchestration.md's "Revision (subtask
2, shipped)" callout flagged as corroborated-but-not-observed.

Two scenarios, reusing the same stored `PipelineDef` with different
`input` (see the eval's own header comment for the full design):

- **Scenario 1** — the coding step adds a trivial file, the MCP step
  calls the granted `echo` tool (`trust: "auto"`). Expected: the whole
  run reaches `done`, and the MCP step's own result carries a real,
  non-empty `mcpCalls`.
- **Scenario 2** — the MCP step is asked to call `echo_sensitive`
  instead (`trust: "approval-required"`, so it can't actually be called).
  Expected: the MCP step's own `TaskCard` lands on `"review"` with
  `pendingMcpApproval` set (not silently `"done"`, not `"failed"`), and
  the whole run stays `"running"`.

### Pass bar

Both scenarios must pass, every run. Either scenario landing on a
different outcome — Scenario 1 failing to reach `done`, or missing
`mcpCalls`; Scenario 2's step landing on `"done"`/`"failed"` instead of
`"review"`, or the run settling `"done"`/`"failed"` instead of staying
`"running"` — is a real finding about this composition, not something to
paper over by loosening the bar.

### Status — not yet empirically run

Same situation as this project's other evals when first written (see
e.g. `eval:pipeline-review-handoff`'s own "Status" note above): this
script, `src/core/mcp-integration-pipeline.ts`,
`eval/fixtures/mcp-echo-server.ts`, and the `mcp-tool-caller` manifest
entry were all written and hand-traced in a session whose sandbox
blocked every subprocess spawn (`bun run eval/fixtures/mcp-echo-server.ts`
itself couldn't be run to confirm it completes a real JSON-RPC
handshake, let alone a full `claude -p` + attached-MCP-server round
trip), so **none of this has actually been run against a real `claude`
process or a real spawned MCP server yet**. The gate tests
(`test/mcp-integration-pipeline.test.ts`, the new case in
`test/pipeline-runner.test.ts`) prove the shape and the orchestrator fix
correct against scripted stand-ins — but the first real run of this eval
(`bun run eval:pipeline-mcp-integration`) is also the first empirical
check that: the hand-rolled echo server actually speaks MCP's stdio
transport correctly against the real `claude` CLI client, a granted
`auto`-trust tool call really does surface as `mcp__wissel-echo-mcp__echo`
in the `tool_use` block the way `parse-mcp-calls.ts`'s own doc comment
predicts, and `mcp-tool-caller` reliably follows the pending-approval
instruction for `echo_sensitive` rather than ignoring it or malforming
the `mcp-approval-request` block. Run it before relying on this
composition for anything real, and update this note with the actual
result once it's been observed.

### Scheduling

Same pattern as the other evals above — add a nightly cron line and a
required CI step for `bun run eval:pipeline-mcp-integration`, same
`timeout 1800`, same real-authenticated-`claude` requirement.

## live-task-output eval

`test/task-output.test.ts`, `test/claude-cli.test.ts`, `test/codex-cli.test.ts`,
`test/render-task-output.test.ts`, and `test/api.test.ts` (all gate lane)
already prove every stage of the pipeline correct in isolation against
scripted/fake stand-ins: incremental stdout reads firing `onChunk` per
line, the ring buffer + durable file store, the pure JSONL-to-rows
render function, and the SSE endpoint's backlog/live-delivery/`event:
done` contract driven by a synthetic `board.recordResult` call. What
none of those can prove is whether a *real* `claude -p --output-format
stream-json --include-partial-messages --verbose` process's actual
stdout timing and shape flow correctly through the whole chain at once:
does streaming really happen incrementally (not just get buffered and
flushed as one write at process exit), does the real HTTP SSE endpoint
actually deliver lines live over a real socket while the subprocess is
still running, and does the terminal `type: "result"` line still parse
into the exact same `TaskResult` today's non-streaming callers get.

This eval spins up a real `Bun.serve` HTTP server backed by `createApp`
(the same construction `src/api/server.ts`'s own entrypoint uses, with
`taskOutputDir` pointed at a disposable tmp dir), creates one task with
the trivial "Reply with exactly the single word: pong" instruction
(same fixture `eval/readonly.eval.ts`'s first case uses, chosen for the
same reason — cheap and not gameable by a wording variation), opens the
SSE stream *before* triggering the run so it's guaranteed subscribed
before the first chunk can land, triggers `POST /tasks/:id/run`, and
waits on the SSE connection's own `event: done` as the completion
signal (no polling loop).

### Pass bar

All four checks must pass, every run: the run was accepted (202), the
SSE connection delivered at least one live JSONL line before closing,
it closed with `event: done`, at least one line landed in the durable
store, and `renderTaskOutputRows` over the snapshot endpoint's lines
produces exactly one `result` row with `ok: true` whose text contains
"pong". Any single check failing is a real finding about the pipeline,
not something to loosen the bar over.

### Status — not yet empirically run

Same situation as `eval:pipeline-review-handoff` when it was first
written (see that eval's own "Status" note above): this script was
written without subprocess-spawn/network-bind access in this
implementer session (real `claude` calls and a real listening HTTP
server both require approval this session's sandbox doesn't grant), so
**it has not yet actually been run against a real `claude` process**.
The full request/response/SSE-framing logic was traced by hand against
the real `src/api/server.ts` code it exercises (see
docs/SDD-live-task-output.md §9 for the implementation notes from the
same session), and every stage it touches has its own passing gate test
in isolation — but the first real run of this eval is also the first
empirical check that streaming actually happens incrementally against a
real subprocess, not just correct in the synthetic-timing tests. Run it
(`bun run eval:live-task-output`) before relying on the live-output
feature for anything real, and update this note with the actual result
once it's been observed.

### Scheduling

Same pattern as the other evals above — add a nightly cron line and a
required CI step for `bun run eval:live-task-output`, same `timeout
1800`, same real-authenticated-`claude` requirement.
