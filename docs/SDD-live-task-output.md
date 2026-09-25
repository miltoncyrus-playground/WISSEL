# SDD: Live task output

## 1. Problem

Today, a running task is a black box until it finishes. `runClaude` (`src/executors/claude-cli.ts:113`) spawns `claude -p ... --output-format json`, buffers the entire stdout with `new Response(proc.stdout).text()` (`src/executors/claude-cli.ts` via `runViaBun`), and only has anything to show once the process exits and the single JSON blob parses. `runCodex` (`src/executors/codex-cli.ts:106`) does the same thing against `codex exec --json`'s JSONL stdout — it already gets one JSON object per line from the CLI, but still buffers the whole thing and calls `parseJsonl(stdout)` only after exit (`src/executors/codex-cli.ts:130`). Either way: while a task shows `running` on the board, there is nothing to look at except "still running" — no way to see what the agent is actually doing, which file it's editing, which command it's running, or whether it's stuck.

Milton asked for what agetor has: a live view of a task's current output while it's in flight.

## 2. Prior art, and why not copy it 1:1

Read directly from `/home/mcyrus/agetor` (real source, not the PR description): agetor hosts Claude Code's actual interactive REPL inside a per-task tmux session (`src/bun/claude-tmux.ts`, ~9,900 lines) and gets structured streaming by tailing the JSONL file Claude writes under `~/.claude/projects/` as the REPL runs. On top of that sits `src/bun/terminals.ts` (real PTYs via `Bun.Terminal`, WebSocket-streamed, ring-buffered for reconnect replay), `src/bun/interactions.ts` and `src/bun/claude-questions.ts` (detecting and answering Claude's interactive prompts by screen-scraping tmux panes), `src/bun/session-liveness.ts` (death probes for a tmux session), and a ~6,900-line `RunPanel.tsx` to render all of it.

That entire subsystem exists to solve a problem Wissel doesn't have: agetor's tasks are long-lived, interactive sessions a human can send follow-up input to mid-run, so it needs a real persistent PTY, session liveness tracking, and modal/prompt detection. Wissel's tasks are one-shot, headless, non-interactive `claude -p`/`codex exec` dispatches (see `runClaude`'s own doc comment, `src/executors/claude-cli.ts:106-111`) — there is no follow-up-input concept, no session to keep alive, nothing to answer. Importing tmux/PTY/JSONL-file-tailing to solve "show me the live output of a call I already own the subprocess of" would be adopting ~17,000 lines of infrastructure to reinvent something Claude Code's CLI already does natively for a headless call: `--output-format stream-json` (confirmed via `claude --help`; live-tested below).

The right-sized equivalent: stream the *same* per-task subprocess Wissel already spawns, instead of buffering it.

Live-tested (`/tmp`, `--permission-mode plan`, trivial prompt, real cost $0.11 — see confirmation below) — `claude -p "..." --output-format stream-json --include-partial-messages --verbose` emits one JSON object per line:

```
{"type":"system","subtype":"init","cwd":"/tmp","session_id":"...","tools":[...]}
{"type":"stream_event","event":{"type":"message_start",...},"session_id":"...","uuid":"..."}
{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"p"},...},...}
... (per-character/per-chunk text and thinking deltas, tool_use/tool_result content blocks, one line each) ...
{"duration_api_ms":2364,"stop_reason":"end_turn","session_id":"...","total_cost_usd":0.1088,"usage":{...},"is_error":false,"num_turns":1,"subtype":"success","result":"pong","type":"result",...}
```

The critical finding: **the final `type: "result"` line is byte-identical in shape to today's whole `--output-format json` response.** Every field `runClaude` already parses (`total_cost_usd`, `result`, `is_error`, `permission_denials`, `subagent_stats`, `api_error_status`) is present on that one line, unchanged. `--verbose` is required for `--print --output-format stream-json` to actually emit the intermediate `stream_event` lines rather than just the final result (confirmed by testing without it first, then with it, per Claude Code's own CLI behavior for this flag combination).

This means the migration from buffered to streaming reading requires **zero changes to any existing parsing logic** (`parseReviewVerdict`, `parseSubtaskPlan`, `parsePipelineHandoff`, cost/denial/subagent extraction) — only a change to *how* `runClaude` reads stdout (incrementally instead of all-at-once) and *which line* it hands to that unchanged logic (the last one, not the whole string).

## 3. Design decisions, stated plainly

**3.1 — Executor change: read the stream incrementally, keep parsing the last line exactly as today.** `runViaBun`/`runClaude` switch from `new Response(proc.stdout).text()` (waits for EOF, returns one string) to reading `proc.stdout` via `getReader()`/async iteration, splitting on newlines as chunks arrive. Each parsed JSON line is handed to a new optional `onChunk(taskId, line: object)` callback *and* accumulated into the same full-stdout string the rest of the function already expects — so `JSON.parse(stdout)` at the end of `runClaude` (`src/executors/claude-cli.ts:151`) still gets the exact same input it gets today (the LAST line, since every prior implementation already effectively only ever used the final line's fields — full stdout under `json` mode was never more than that one blob to begin with). Same idea for `runCodex`, whose stdout was already JSONL — this is a smaller lift there since no CLI flag changes, just the read strategy.

**3.2 — A shared, executor-agnostic output store, not two.** New `src/services/task-output.ts`, mirroring `src/services/memory.ts`'s plain-module style (no class, a handful of exported functions). Holds, per `taskId`: an in-memory ring buffer (cap 256 KB, same constant agetor's `terminals.ts` uses and for the same reason — plenty for a screen of scrollback, bounded so a runaway loop can't grow memory unbounded) for live tailing, and appends every line to a durable file at `~/.wissel/task-output/<taskId>.jsonl` (directory created lazily, same pattern as `~/.wissel/board.sqlite`/`~/.wissel/worktrees/`). Both `ReadOnlyExecutor` and `WriteExecutor` (and `CodexReadOnlyExecutor`, if in scope — see §6) call the exact same `appendTaskOutput(taskId, line)` on every chunk; the executor doesn't know or care whether anyone's watching live.

**3.3 — Durable, not just live.** The JSONL file persists after the task reaches a terminal status — unlike agetor's terminals (explicitly not persisted, PTYs die with the process, see `terminals.ts`'s own comment), a task's own output is worth keeping the same way `TaskResult.summary` already is kept forever in SQLite. This lets you inspect what a *finished* (done/failed) task actually did, not only a running one — genuinely useful given this session's own repeated need to hand-inspect background task output after the fact. No cleanup/pruning in v1 (one small JSONL file per task, same non-goal as `task_results` never being pruned today) — see §5.

**3.4 — API: reuse the board's existing SSE pattern, don't invent a second one.** `GET /tasks/:id/output` returns the current full buffered/persisted content (a point-in-time snapshot — useful for a task that already finished, or a client that just wants to load-then-poll). `GET /tasks/:id/output/stream` is SSE, built the same way `sseStream(board)` already is (`src/api/server.ts:666-690`): a `ReadableStream` that subscribes a listener and unsubscribes on cancel, `content-type: text/event-stream`. Unlike `/events` (one global stream, every board event, client filters), this one is scoped server-side to a single `taskId` — the store's `onChunk` emitter takes a taskId key so the SSE handler only forwards that task's lines. Sends a final `event: done` (or the connection just ends) when the task's own result lands, so the client knows to stop listening rather than hang forever on a finished task.

**3.5 — Render the JSONL into something a human reads, not raw JSON.** Both the snapshot and stream endpoints return the raw JSONL — rendering is a client concern, same division of labor as every other endpoint in this codebase (server returns data, `board.html` renders it). The UI turns each line into one compact row:
  - `stream_event` / `content_block_delta` with `text_delta` or `thinking_delta` → append to the current streaming text line (thinking rendered visually distinct, e.g. dimmed/italic, from the final answer text).
  - `stream_event` / `content_block_start` with `content_block.type === "tool_use"` → `→ Bash: <command>` / `→ Edit: <file_path>` / `→ Read: <file_path>` etc. — tool name plus its most identifying input field.
  - a subsequent tool_result line → `✓` or `✗` plus a truncated one-line preview.
  - the final `type: "result"` line → the same completed-task summary the board already shows elsewhere (cost, verdict if any) — this line is the signal the stream is over.
  This needs no new client-side JSON schema beyond "the same shapes Anthropic's streaming Messages API already documents" — no new contract to invent, just a rendering function.

**3.6 — UI surface: a modal, not a new tab.** A "Live output" action on any task whose `taskDisplayColumn(t)` is `running`/`reviewing`/`dispatched` (kanban card menu + swimlane card), opening a modal with a scrolling monospace panel fed by `EventSource` against `/tasks/:id/output/stream`. Also reachable from a finished task's drawer (reading the snapshot endpoint, no live connection) so the same view works for "what did this already-done task actually do" — one component, two data sources (SSE vs. one-shot fetch), matching §3.4's split. No new nav link, no new board.html tab — consistent with the project's existing modal patterns (task drawer, escalation dialogs).

**3.7 — Scope: claude-cli only for v1, codex included if it lands clean, no scope for `anthropic-api`/`readonly` executors beyond what §3.2 already covers for free.** `ReadOnlyExecutor` and `WriteExecutor` both route through `runClaude`, so claude-tier live output is one change, not two (§3.1). `codex-cli.ts` gets the same treatment as a normal part of this same feature (§3.2's store is executor-agnostic) since its lift is smaller (already-JSONL stdout, just needs streamed reads) — but if it turns out to need real rework beyond "read incrementally instead of all at once," split it into its own follow-up card rather than block claude's launch on it (same split-when-it's-clearly-two-things discipline as the Pipelines feature).

## 4. Implementation shape

- `src/services/task-output.ts` (new): `appendTaskOutput(taskId, line)`, `getTaskOutput(taskId): Promise<string[]>` (reads the JSONL file), `TASK_OUTPUT_EVENTS: EventEmitter` (or equivalent) for the SSE layer to subscribe to, `DEFAULT_TASK_OUTPUT_DIR` (`~/.wissel/task-output`), ring-buffer cap constant.
- `src/executors/claude-cli.ts`: `RunClaudeOptions` gains `onChunk?: (line: unknown) => void`; `runClaude` reads `proc.stdout` incrementally (new reading path in `runViaBun`, or a new `runViaBunStreaming` variant — caller's choice at implementation time, but the *parsing* of the final line must stay the exact same code path already at `claude-cli.ts:150-181`, not a rewrite).
- `src/executors/codex-cli.ts`: same idea, `onChunk` wired into `parseJsonl`'s equivalent incremental read.
- `src/executors/readonly.ts` / `src/executors/write.ts`: both pass `onChunk: (line) => appendTaskOutput(task.id, line)` into their `runClaude` call.
- `src/api/server.ts`: `GET /tasks/:id/output` (snapshot), `GET /tasks/:id/output/stream` (SSE, mirrors `sseStream` at `server.ts:666-690` but scoped to one taskId via `TASK_OUTPUT_EVENTS`).
- `src/api/public/board.html`: render function for JSONL → human-readable rows (§3.5), a "Live output" modal, wiring from kanban card menu / swimlane card / task drawer.

## 5. What this deliberately does not do

- No tmux, no PTY, no interactive REPL, no follow-up-input-mid-task. Wissel's tasks stay one-shot headless dispatches — this is observability only, never control.
- No ask-modal/interactive-prompt detection or answering (agetor's `claude-questions.ts`/`interactions.ts`) — not applicable, since headless `-p` mode has no interactive prompts to answer in the first place.
- No pruning/retention policy for `~/.wissel/task-output/*.jsonl` in v1 — same non-goal as `task_results` never being pruned today.
- No live output for `anthropic-api.ts`'s executor (a direct API call, not a CLI subprocess — genuinely nothing to stream from in the same shape; out of scope, not forgotten).
- No changes to `runClaude`'s/`runCodex`'s parsing, cost tracking, or any output-contract logic (`parseReviewVerdict`, `parseSubtaskPlan`, `parsePipelineHandoff`) — the final-line shape is unchanged, so none of that code moves.

## 6. Subtasks

**1. Executor streaming (claude-cli.ts + codex-cli.ts).** Switch stdout reading from buffered to incremental for both. `claude-cli.ts` additionally adds `--include-partial-messages --verbose` to the spawned command when streaming is requested. `onChunk` callback fires per JSONL line, in order. The final parsed `TaskResult` returned by `runClaude`/`runCodex` is byte-for-byte identical to what today's buffered path produces (existing tests for both must pass unmodified — this is the acceptance bar for "zero regression risk"). New tests: a fake streaming `CommandRunner` that yields chunks over several ticks, asserting `onChunk` fires per line in order and the final result matches the non-streaming case for the same input.

**2. Task output store.** `src/services/task-output.ts` per §4. Ring buffer + durable JSONL file. Tests: append then read-back round-trip, ring buffer eviction at the byte cap, concurrent appends from two different taskIds never cross-contaminate, file persists and is readable after the emitter has no more listeners (i.e., after the task and any live viewer are both gone).

**3. API endpoints.** `GET /tasks/:id/output`, `GET /tasks/:id/output/stream`. Wire `onChunk` from subtask 1 into `appendTaskOutput` from subtask 2, from both `ReadOnlyExecutor` and `WriteExecutor` (and `CodexReadOnlyExecutor` if subtask 1 covered it cleanly). Tests: snapshot endpoint returns 404 for an unknown task, returns accumulated lines for a known one; SSE endpoint delivers chunks as they're appended (integration test driving a real fake executor through the store) and the stream ends/signals completion when the task's result lands.

**4. UI: Live output modal.** Render function (§3.5) as a pure function taking a JSONL line array and returning render-ready rows — unit-testable without a browser. Modal wiring: "Live output" action on running/reviewing/dispatched kanban+swimlane cards and on any task's drawer (live via SSE for in-flight, snapshot fetch for finished). Manual browser verification with a screenshot is a required acceptance criterion (per house rule) — not optional, given this is 100% UI-observable.

**5. Docs + eval.** Update this doc's own precedent-callout style if implementation deviates from §3's decisions. One eval (`eval/live-task-output.eval.ts` or similar) that drives one real, cheap `claude -p` call through the full pipeline end to end (spawn → stream → store → SSE) and asserts the human-readable render contains the expected tool-use/text content — written and disclosed as unrun-by-default in its README note, matching the existing precedent for `eval/pipeline-review-handoff.eval.ts` and friends (real spend, not run by an implementer/reviewer session without authorization).

## 7. Sequencing

1 blocks everything. 2 can be built in parallel with 1 (no dependency between them until wiring). 3 needs 1 and 2 both done. 4 needs 3 (the API). 5 (docs/eval) trails, written alongside but the eval itself not run until subtask 3+4 are both merged.

## 8. Verification standard

`bun run typecheck` and `bun test test/` clean, per every other SDD in this repo. Subtask 1's "identical final result" claim is the single highest-value thing to verify hard — a regression there breaks every existing task, not just this feature. Subtask 4's UI claim needs a real browser screenshot, not just "the code looks right" (same house rule every prior UI subtask in this repo has been held to). The eval in subtask 5 is written but not run by the implementer/reviewer — same disclosed-not-executed precedent already established and accepted twice this session.
