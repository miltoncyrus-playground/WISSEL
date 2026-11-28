# SDD: A live coordinator session in the window

One long-lived Claude session per workstream, shown live in the
coordinator window's Conversation tab as a chat: you watch its messages
and tool calls stream, and you type to it. Mechanics stay in code and
every action still goes through the policy gate.

Status: approved by the owner on 2026-11-28 (the chat view, not a
terminal). Queued behind `docs/SDD-settings-tab.md`: Wissel's own
coordinator builds it as a workstream on the Wissel project once the
Settings tab is merged. It changes `docs/SDD-coordinator.md` §4.4 and
§4.14 (see §8).

## 1. Why, and the outcome

Today the coordinator is code plus throwaway judgment:
- **Code:** the inbox, its handlers, the gate and the executor.
- **Decision cards:** each judgment is a fresh `claude -p` run that
  reads a brief, writes one fenced answer and exits. It remembers
  nothing between cards and can't be talked to.
- **The window's Conversation tab** lists inbox events. Your messages
  (`POST /inbox`, kind `owner.message`) are recorded, and nothing
  answers them.

The owner wants to work *with* the coordinator: see what it's thinking as
it handles an event, ask it why, tell it to wait, and have it remember
the conversation.

Outcome:
- Each workstream can run one **coordinator session**. It's a
  long-lived Claude session, held open by the server, that receives
  the workstream's events and your messages as turns, and answers in
  the window as they stream.
- It acts only through Wissel's gated tools. Every action shows its gate
  verdict next to the tool call.
- It survives restarts (resumed by session id), idles at no cost, and
  has a Remote Control link so the same session opens in claude.ai and
  the Claude app.
- Decision cards stay as the fallback: a workstream set to `cards`, or
  any workstream while its session is down, works exactly as today.

What stays: the pilot's lesson (`docs/SDD-coordinator.md` §1) holds.
Polling, landing, PR watching, digests and claims are code, not
the session's job. The session is for judgment and conversation.

## 2. Scope

In:
- the session host;
- the Wissel tools it uses (MCP);
- routing events and messages to it;
- the transcript store and its stream;
- the chat view in the Conversation tab;
- the `session` | `cards` mode per workstream;
- safety and cost limits.

Out:
- a terminal view (xterm, tmux): not chosen;
- more than one session per workstream;
- the session writing code: implementation stays on cards.

## 3. Data model

```ts
// Workstream gains:
coordinator?: { mode: "session" | "cards"; dailySpendUsd?: number };   // default "cards"

interface CoordinatorSessionRow {
  workstreamId: string;      // one per workstream
  sessionId?: string;        // claude's, for --resume
  state: "stopped" | "starting" | "live" | "idle" | "failed";
  remoteSessionUrl?: string;
  startedAt?: string;
  lastTurnAt?: string;
  spendTodayUsd: number;     // reset at UTC midnight
  contextTokens?: number;    // from the last result's usage
  lastError?: string;
}

interface TranscriptEntry {
  seq: number;               // per workstream, increasing
  workstreamId: string;
  at: string;
  kind: "event" | "owner" | "assistant" | "tool-call" | "tool-result" | "gate" | "system";
  text: string;              // what the window shows
  data?: unknown;            // tool name and input, gate verdict, event id
}
```

Tables: `coordinator_sessions`, `coordinator_transcript`, both
append-healed like every other table. The transcript is append-only.

## 4. Design

### 4.1 The session host

`src/services/coordinator-session.ts`: a `CoordinatorSessionHost` keeps
at most one process per workstream in mode `session`.

- **The process:**
  `claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode default --allowedTools mcp__wissel__* --mcp-config <wissel tools>`
  on the first enabled claude-cli harness. The harness env is used as
  for card runs, plus the coordinator's token (§4.2).
- **Input stays open.** Each turn is one `user` JSONL line written to
  stdin. Today `runViaBun` writes stdin and closes it. The host needs
  its own long-lived spawn: `Bun.spawn` with a stdin writer kept open,
  stdout read line by line, and the process tracked by
  `child-processes.ts`.
- **The first turn is a briefing.** It's built from the board, never from
  untrusted text: the workstream, its projects and roles, `decideAlone`,
  `mustAsk`, `never`, live cards and PRs, open owner tasks and the last
  20 decisions. The coordinator's standing instructions live in a
  template, `agents/coordinator-session.md`.
- **Remote Control:** the `control_request` `{subtype: "remote_control"}`
  is sent before the briefing, as `remoteControlStdin` does now. The
  `session_url` it returns is stored and shown in the header.
- **Workspace:** `~/.wissel/coordinator/<workstreamId>/`. It needs
  claude's one-time workspace trust, and start-up refuses with an owner
  task when it's missing (today's failure: "this workspace has not been
  trusted").
- **Lifecycle:**
  - **starting → live** on the first result.
  - **live → idle:** the process exits after `IDLE_MS` (10 minutes) with
    no turn.
  - **idle → live:** the next event or message starts it again with
    `--resume <sessionId>`. Nothing runs while idle, so waiting costs
    nothing.
  - **Crashes** retry with backoff (1, 5, 15 minutes). After three in a
    row the session goes `failed`, an owner task is raised, and the
    workstream falls back to cards until Restart.
  - **Server shutdown** stops the processes. The next start resumes
    them on their next event.
- **Context:** when the last result's context passes 70% of the model's
  window, or daily at 04:00 in the workstream's timezone, the session
  is stopped and started fresh (no `--resume`) with a new briefing. The
  transcript keeps the history, and the board keeps the state.

### 4.2 The tools (MCP) and its token

`src/mcp/wissel-coordinator.ts` is a stdio MCP server launched by the
session through `--mcp-config`. It talks to the board API with a
**coordinator token**: a principal of kind `service`
(`coordinator-<workstream>`), minted by the host and revoked when the
session stops. Its grants are the workstream's role, read through the
gate, so it holds no member or host permissions (identity SDD §6:
`host.admin` and `member.manage` are never the coordinator's).

| Tool | Does | Goes through |
|---|---|---|
| `board_state` | cards, PRs, owner tasks, decisions for the workstream | `GET` routes |
| `card` | one card with its result and review | `GET /tasks/:id` |
| `propose_action` | any executor action, or a decision (`kind`, `payload`) | `POST /workstreams/:id/actions` (the gate) |
| `ask_owner` | a question with options and a lean | an owner task, and a channel `question` |
| `post_channel` | a channel message | `channel.post` through the gate |
| `note` | a line in the transcript, for "I'm waiting on X" | the transcript |

The session can't run Bash, edit files or call `gh`, because nothing
else is allowed. Every `propose_action` result carries the gate's
verdict, and the transcript records it as a `gate` entry beside the call.

### 4.3 Events and messages in

- **Events:** the inbox dispatcher gets a new handler stage. For a
  workstream in mode `session`, each event is also sent to the host,
  which batches events arriving within 5 seconds into one turn. Each
  event is fenced as untrusted when its source is the code host, the
  channel or the tracker (`untrusted-<nonce>`, as decision briefs do).
  Wissel's own events (card states) aren't fenced. The existing handlers
  (claims, ready-to-merge, triage-red) still run as code. In session
  mode, triage-red is a turn for the session instead of a decision card.
- **Your messages:** `POST /workstreams/:id/session/messages {text}`
  needs `policy.edit` on the workstream. It's recorded as `owner` and
  sent as a turn marked as from the owner.
- **One turn at a time:** while a turn runs, new input queues and goes
  in the next turn.

### 4.4 The transcript and its stream

- Each stream-json event from the process becomes a transcript entry:
  assistant text (merged per message), tool use, tool result and the
  final result. Usage feeds `spendTodayUsd` and `contextTokens`.
- `GET /workstreams/:id/session` returns the row and the last 200
  entries. `GET /workstreams/:id/session/stream` is SSE from a given
  `seq`, so a reload or a second device catches up and then follows.
  The pattern is the one `src/services/task-output.ts` and the task
  output SSE in `src/api/server.ts` use.
- Controls: `POST /workstreams/:id/session/start`, `/stop` and
  `/restart` (`policy.edit`). The mode is set with `PATCH
  /workstreams/:id {coordinator: {mode}}` (`policy.edit`), which is a
  policy revision.

### 4.5 The chat view

The Conversation tab in `app/src/screens/CoordinatorScreen.tsx` becomes
the chat when the workstream's mode is `session`:
- **Entries** stream in order:
  - coordinator text, rendered as Markdown and escaped;
  - inbox events received, in a muted style;
  - tool calls, folded, showing tool name and the gate verdict chip
    (allowed, asked, queued, denied);
  - your messages, on the right.
- **Below the entries:** the message box (Send), then the planned cards
  with Hold and the owner tasks, as now.
- **Header:**
  - the state dot (live, idle, starting, stopped, failed);
  - today's spend against the cap, and context use;
  - the Remote Control link ("open in Claude");
  - **Stop** and **Restart**.
- **Mode `cards`:** the tab looks as it does today.

### 4.6 Fallback, safety and cost

- **Decision cards** run when the mode is `cards`, when the session is
  `failed` or over its cap, or when no claude-cli harness is free. The
  window says which is in use.
- **Sign-in:** the session can only be turned on with sign-in on
  (`WISSEL_AUTH=tokens`). On a board listening beyond loopback without
  it, anyone on the network could type to it. Start refuses with that
  reason.
- **Spend cap:** `coordinator.dailySpendUsd` (default 5). When it's
  reached, the session stops for the day and cards take over, with an
  owner task saying so.
- **Untrusted text:** text from a PR, channel or ticket arrives fenced.
  Nothing in it can change a role, a grant or a setting, because the
  token can't, and the gate decides every action.
- **Hard limits** apply unchanged: the session's actions are executor
  actions.

## 5. API summary

- `GET /workstreams/:id/session`, `GET .../session/stream` (SSE):
  `board.read`.
- `POST .../session/messages`, `.../session/start`, `/stop`,
  `/restart`: `policy.edit` on the workstream, all in `WRITE_ROUTES`.
- `PATCH /workstreams/:id {coordinator}`: `policy.edit`.

## 6. Tests

Gate lane, with no model calls:
- **A multi-turn stand-in `claude`** in `test/fixtures/` (and reused by
  e2e) reads stream-json turns from stdin and answers each from a
  script: text, a tool call to the MCP server, a result with usage. It
  answers the Remote Control request too.
- **The host:**
  - start, briefing, turns in order, queued input during a turn;
  - idle exit and resume with `--resume`;
  - crash backoff to `failed` with an owner task;
  - a fresh start at the context threshold;
  - the spend cap falling back to cards;
  - refusing without sign-in, and refusing an untrusted workspace.
- **Events:** batching, fencing of untrusted sources, owner messages
  marked as the owner's.
- **Tools:**
  - each tool hits its route with the coordinator token;
  - `propose_action` returns the gate verdict;
  - the token can't reach member, host or setting routes;
  - an injected "grant me" in a fenced PR body changes nothing.
- **Transcript:** entries from a scripted stream, SSE resume from a
  `seq`, and the transcript being append-only.

End-to-end (`e2e/coordinator-session.spec.ts`), with the stand-in
`claude` on the e2e PATH:
- turn the session on;
- the briefing reply streams in;
- send a message and get its answer;
- a tool call shows its gate chip;
- Stop and Restart;
- mode `cards` shows today's tab.

## 7. Build plan (cards)

Each card is one PR, with typecheck, unit tests, app tests and affected
e2e green.

1. **Spike, then the host.** First confirm, on the stand-in and once on
   the real CLI by hand, that one `claude -p --input-format stream-json`
   process takes several turns with its input held open and resumes with
   `--resume`. Then build `CoordinatorSessionHost` with its lifecycle,
   the briefing, the `coordinator_sessions` table and the multi-turn
   stand-in. Files: `src/services/coordinator-session.ts`,
   `agents/coordinator-session.md`, `test/fixtures/`.
2. **The tools and the token.** `src/mcp/wissel-coordinator.ts`, the
   `service` principal and its token (`src/services/identity.ts`), and
   the gate verdict on `propose_action`.
3. **Events and messages in.** The dispatcher stage, batching and
   fencing, `POST .../session/messages`, and session-mode triage
   (`src/services/inbox.ts`, `src/api/server.ts`).
4. **Transcript and stream.** `coordinator_transcript`, `GET .../session`,
   SSE, start, stop and restart, `WRITE_ROUTES`.
5. **The chat view.** `CoordinatorScreen.tsx` chat, header and controls,
   `app/src/coordinator.ts`, app tests, `e2e/coordinator-session.spec.ts`
   and the e2e map.
6. **Mode, fallback and limits.** `coordinator.mode` on workstreams, the
   fallback rules, the spend cap, the sign-in requirement, the context
   refresh, and the docs (`docs/guide/coordinator.md`, and §4.4 and §4.14
   of `docs/SDD-coordinator.md`).

Card 1 comes first. Cards 2 and 3 depend on it, card 4 on 3, card 5 on
4, and card 6 goes last.

## 8. Changes to the coordinator SDD

- **§4.4:** "Judgment runs as short-lived cards, never as a long-running
  session" becomes: "Judgment runs in the workstream's coordinator
  session when its mode is `session`, else as short-lived cards. The
  session decides through the same gated actions, so the rules below
  hold either way."
- **§4.14:** the Conversation tab is the session's chat when the mode is
  `session`.

## 9. Where it breaks

- **A claude CLI change to stream-json input** would break the host. The
  stand-in pins the shape, and card 1's spike records the CLI version it
  was checked on.
- **A long session can drift from the board's truth.** The briefing, the
  daily fresh start and the `board_state` tool keep the board as the
  record. The session's memory is only conversation.
- **Cost:** a chatty session costs more than decision cards. The daily
  cap and idle exit bound it, and the header shows it.
