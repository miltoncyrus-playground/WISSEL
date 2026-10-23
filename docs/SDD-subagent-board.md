# SDD — Sub-agents spawned by a run show on the board, live

Status: **Built.** `src/services/subagent-runs.ts`, `GET /tasks/:id/subagents`,
chips on the lane cards and a drawer section. `test/subagent-runs.test.ts`.

## 1. The problem

A claude-cli agent can spawn sub-agents (the `Agent` tool) and work on
independent reads in parallel; nothing stops it (docs/SDD-subagent-visibility.md).
But the board only showed a count in the Result card after the run ended, so a
card looked idle while four Explore agents were working under it.

## 2. Design

- **Source of truth is the run's own output file** (`~/.wissel/task-output`,
  docs/SDD-live-task-output.md). An `Agent` (older: `Task`) `tool_use` with no
  `parent_tool_use_id` is a spawn; its `tool_result` is the hand-back
  (`is_error` marks a failure); lines carrying `parent_tool_use_id` = that
  call's id count the sub-agent's own tool calls. Only complete `assistant` /
  `user` lines are read, never `stream_event` deltas. Checked against three real
  run files (Explore agents of 8, 24 and 66 tool calls, all `done`).
- **`GET /tasks/:id/subagents`** returns `{runs, total, running, failed}`. While the
  card runs it is live; once the result lands anything still `running` is closed
  (`done`, or `failed` when the run failed). A background spawn (`run_in_background`)
  stays `running` past its tool result until then.
- **Board.** Each lane card carries one chip per sub-agent (type: description,
  coloured by status, at most four and a `+N`). The drawer lists every sub-agent
  with status, tool calls and background flag. The page polls every 4 s for running
  cards, for cards whose sub-agents were still running at the last read (one final
  read), and for the open drawer; the poll is skipped while the tab is hidden.

## 3. Not here

- Sub-agents are rows inside their card, not cards of their own: they run inside the
  parent's process, share its worktree and cost, and cannot be run, reviewed or merged
  separately. Separate parallel work is a separate card (the planner's subtask plan
  already makes those; independent cards already run at once up to the harness cap).
- No cost or duration per sub-agent: the output file does not carry them per call.
- No change to what an agent may do: spawning was never gated.
