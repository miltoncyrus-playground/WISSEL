# SDD: Remote Control for card runs

Status: built 2026-10-12. Code: `src/executors/claude-cli.ts`
(`remoteControlStdin`, `parseRemoteControlResponse`,
`RunClaudeOptions.remoteControl`).

## 1. Goal

Every claude-cli card run (board cards and pipeline steps) is a
Remote Control session, so Milton can follow and steer it from
claude.ai/code or the Claude app while it runs.

Outcome: each run's result carries `remoteSessionUrl`, its live output
shows a "Follow this run in claude.ai" link, and the session appears in
that harness account's claude.ai/code list as `wissel: <card title>`.

## 2. What works and what doesn't (measured, claude 2.1.296)

| Tried | Result |
|---|---|
| `claude -p --remote-control <name>` | Runs, no bridge. The flag is for interactive sessions only. |
| `claude -p --settings '{"remoteControlAtStartup":true}'` | Runs, no bridge. The setting is honored at user scope only and not in print mode. |
| `claude -p --input-format stream-json` with a `control_request` `{subtype: "remote_control", enabled: true, name}` before the user message | Bridge connects. The `control_response` carries `session_url`. `bridge_state: connected` follows. |

The working path held in every case wissel uses:

- stdin closed right after the two lines (how `runViaBun` writes stdin);
- `--resume <session>` (a 429 retry). The resumed run reattaches to the
  same claude.ai session, so a card keeps one link across retries;
- both harness accounts (`claude`, `claude-adevinta`). Corporate runs
  show up under the corporate claude.ai login.

## 3. Design

- `runClaude` with `remoteControl: true` adds `--input-format
  stream-json` (which needs stream-json output, so streaming is forced
  on) and writes two JSONL lines to stdin: the control request
  (`request_id: "wissel-remote-control"`) and the prompt as one user
  message. Off, the command line and stdin are unchanged.
- `parseRemoteControlResponse` reads the answer from stdout. A URL lands
  on `TaskResult.remoteSessionUrl` (stored in `task_results`). A refusal
  or no answer is logged (`remote control: task <id> ran without it`)
  and the run carries on: Remote Control never fails a card.
- `render-task-output.js` turns the control line into a `remote` row;
  `board.html` renders it as a link, only for `https://claude.ai/`
  addresses.
- Threading follows the memory-injection toggle: `WISSEL_REMOTE_CONTROL`
  is read once in the server bootstrap (on unless `0`/`false`), passed
  through `CreateAppOptions.remoteControl` to the claude `ReadOnlyExecutor`
  and `WriteExecutor`. Executors never read `process.env`.
- Ask's chat executor gets no Remote Control: its replies are short, and
  a session each would flood the claude.ai list.
- Codex harnesses have no Remote Control; nothing changes there.

## 4. Failure modes

- Org policy blocks Remote Control on an account: the request is
  refused, the run goes on without a link, the log line says why.
- The bridge drops mid-run: the run is unaffected (the bridge only
  mirrors it).
- A future CLI drops or renames the control request: claude answers with
  an error or ignores it; same as a refusal. `eval:remote-control`
  catches it.
- Session list clutter: every card run is one session. Turn it off with
  `WISSEL_REMOTE_CONTROL=0` and a restart.

## 5. Tests

- Gate: `test/remote-control.test.ts` (stdin shape, parsing, command
  line on and off, refusal, 429, resume, both executors),
  `test/render-task-output.test.ts`, `test/board.test.ts` (round trip),
  `e2e/live-task-output.spec.ts` (the link in the browser).
- Eval: `bun run eval:remote-control`. Real runs on every enabled
  claude-cli harness: connected session with a URL, resume keeps the
  conversation and gets a URL, off switch gives none. First run
  2026-10-12: 5/5, $0.31.
