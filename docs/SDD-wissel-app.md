# SDD: Wissel app (chat-first, feed, characters, audio, new look)

Status: approved 2026-10-10. Milton chose directions 1 to 5 from the
exploration and the mockups (claude.ai artifact "Wissel new
directions": Ask wissel, Feed and Stories, Wissel Wrapped, desktop chat
with a live board). Built as wissel cards that run in order; usage
limits pause a card (429 retryAfter) and the board resumes it.

## 1. Why

The board (`src/api/public/board.html`, about 7,500 lines of vanilla JS
across its modules) works but reads old-school. The way Milton actually
drives wissel is conversation: "create a card for that", "schedule it at
06:00", "check if kokoro is available", answered with a card, a status
and a link. The new app puts that first, adds a feed of what happened,
gives agents a face, makes audio a first-class surface, and appeals to a
younger audience. The board stays, unchanged, at `/board`.

## 2. Goals and measurable outcomes

New app at **`/app`**, phone first (390 px) and desktop (1440 px).

| # | Direction | Outcome, checked by |
|---|---|---|
| 5 | New look + shell | `/app` renders Ask, Feed, Board, Listen and You at 390 and 1440 px with no sideways scroll; ⌘K / Ctrl-K opens the command palette; Lighthouse-style checks in e2e: every interactive element is a real `button`/`a`/`input`, text contrast ≥ 4.5:1 for the token pairs (unit test on the tokens). |
| 2 | Feed + Stories | `GET /feed` returns typed items for landed cards, cards that need Milton, podcasts ready and run-check results, newest first; a card moving to `done` appears in an open feed within 2 s (SSE, e2e). |
| 4a | Audio | Latest episode of every podcast pipeline playable from a persistent mini-player on every screen; position survives navigation (e2e). |
| 1 | Ask wissel | A message like "create a card to check the README" creates exactly one card on the board and shows it as a live chip whose status follows the board (e2e with a scripted concierge; live eval with the real one, §4.4). |
| 4b | Voice | A recorded voice note becomes the text of an Ask message (speaches STT); a concierge reply can be played as Kokoro audio. Eval: transcription word error rate ≤ 15% on 5 recorded fixture notes. |
| 3 | Characters + Wrapped | Every agent has a stable avatar and colour; running agents show as "working"; `GET /wrapped?period=` returns the numbers in the mockup from the board, git and telemetry, equal to `wissel-digest` for the same period (unit test); a Wrapped card downloads as a PNG. |

## 3. Design

### 3.1 Stack and layout (card 1)

- New top-level directory **`app/`**, same stack as `pipeline-editor/`
  (Vite, React 18, TypeScript, vitest): no new framework in the repo.
  Built to `app/dist/`, gitignored, served by the server at `/app` and
  `/app/*` (SPA fallback to `index.html`, static files with correct
  types, no directory traversal: same rules as `/pipelines/edit/`).
- `bun run build:app` (`cd app && npm run build`); `bun run serve` and
  the Playwright web server build it next to `build:editor`
  (test/editor-build-wiring.test.ts extended).
- **Design tokens** (`app/src/tokens.ts`, CSS custom properties): ground
  `#0D0E12`, surface `#17191F`, surface-2 `#1F222A`, line `#2A2D36`,
  text `#F3F1EA`, muted `#A3A6B0`, accent lime `#C8F25A`, violet
  `#9C8CFF` (you, running), coral `#FF8A5C` (needs you). Dark first; a
  light theme is a follow-up. Fonts self-hosted via `@fontsource`
  packages (Bricolage Grotesque display, Geist body, Geist Mono): no
  Google Fonts call, the app works on the LAN without internet.
- **Shell**: phone: bottom tab bar (Feed, Ask, Board, Listen, You);
  desktop ≥ 1024 px: left rail + right "Live" panel (running, needs
  you, landed today). Routes by URL hash (`#/feed`, `#/ask`...), no
  router dependency.
- **Command palette** (⌘K / Ctrl-K, and a button on phones): jump to a
  screen, open a card by title, run a pipeline by name, "New card".
  Plain fuzzy match in code (no library) with unit tests.
- **Board** tab: a compact read of `/tasks` by lane (Running, Needs
  you, Review, Done today) with a link "Open full board" to `/board`.
  `board.html` gains one link to `/app` in its header.
- Live updates: one `EventSource('/events')` shared by the app.

### 3.2 Feed and Stories (card 2)

`src/services/feed.ts`, pure: `buildFeed({tasks, runs, telemetry, now,
limit})` → items, deterministic, newest first, each
`{id, kind, at, title, detail, links, taskId?, runId?}`:

- `landed`: a card reached `done` (merge commit when there is one).
- `needs-you`: status `escalated`, `pending-review` waiting on Milton,
  an MCP approval request, a failed card, a card held for a disabled
  harness. Each carries the one action the board already supports for
  it (open, approve, retry) as a link to that endpoint.
- `podcast`: a podcast pipeline run with audio (title = first quick
  read headline, duration from the audio step).
- `checks`: the `check-news-run` result for a podcast run
  (scripts/check-news-run.ts `checkStoredRun`, moved to
  `src/services/news-run-checks.ts` so the server can call it; the
  script imports it from there).
- `spend`: once a day, yesterday's spend by harness from telemetry.

Item time: task results have no timestamp today; add `finishedAt` to
`task_results` (heal-on-open `ALTER TABLE`, set in `recordResult`), and
use telemetry `at` for older results. `GET /feed?limit=50&before=`.

**Stories**: the feed's last 24 h grouped by kind (AI news, World,
Needs you, Landed, Your week); tapping one plays its items full screen,
swipe or tap to advance, like the mockup. Pure grouping function with
tests.

### 3.3 Audio (card 3)

- `GET /podcasts`: for every pipeline whose steps include
  `podcast-audio`, its runs with audio, newest first: `{runId,
  pipelineName, at, title, durationSeconds, audioUrl, quickRead}`.
- **Mini-player** fixed above the tab bar (phone) or in the Live panel
  (desktop): one `<audio>` element owned by the shell, so playback and
  position survive screen changes. Media Session metadata and
  play/pause/seek handlers where `navigator.mediaSession` exists.
  Remembers position per run in `localStorage` (try/catch).
- **Listen** tab: episodes by pipeline, Quick read with the expandable
  detail (reuses `board-news.js` shaping via an ESM wrapper, not a
  copy).

### 3.4 Ask wissel (card 4)

The one LLM part. Everything around it is code.

- **Agent `concierge`** (agents/manifest.yaml): `tier: readonly`,
  `toolAccess: []`, model `claude-opus-5-5` (best model by default),
  unique tag, never routed by the fuzzy router, private `claude`
  harness only (respects disabled harnesses like every agent).
  Runs through `ReadOnlyExecutor` (local `claude -p`), no API.
- **Context, built in code** (`src/services/concierge-context.ts`,
  pure): open cards (id8, title, status, agent), the last 10 landed,
  pipeline names, registered projects (name, path), accounts line,
  and the conversation's last 20 messages. Board text is fenced as
  `untrusted-<nonce>` data exactly like pipeline handoffs.
- **Output contract**: a fenced block
  ```` ```wissel-actions {"reply": "...", "actions": [...]}``` ````.
  Allowed actions, validated in code (`src/services/concierge-actions.ts`):
  `create_task {title, body, labels, repo}` (repo must be a registered
  project path; labels from the board's known set), `run_pipeline
  {name, input?}` (must exist), `show_task {id}`. At most 3 per
  message. Anything else, or an invalid action, is dropped and named
  in the reply. No merge, delete, archive, harness or settings
  changes from chat: those stay on the board.
- **Store**: `conversations` and `messages` tables in board.sqlite
  (`src/services/conversations.ts`): messages keep `role`, `text`,
  `actions` (as executed, with resulting task/run ids), `at`, cost.
- **API**: `POST /ask {conversationId?, text}` → creates the user
  message, runs the concierge, executes actions, stores and returns
  the assistant message; streams "thinking" over `/events`.
  `GET /conversations`, `GET /conversations/:id`.
- **UI**: the Ask screen as in the mockup: bubbles, created cards as
  chips that follow `/events`, podcast results with inline play,
  quick replies from code (run a podcast, "what did I do this week",
  show board). Desktop: the chat centred with the Live panel.
- Cost per message is logged to telemetry like any agent; the reply
  shows it in small mono text.

### 3.5 Voice (card 5)

- **STT service**: speaches (MIT; faster-whisper int8 on CPU,
  OpenAI-compatible `POST /v1/audio/transcriptions`) in Docker bound to
  `127.0.0.1:8000`, model `Systran/faster-whisper-small` (fits the
  i5-4308U; `base` if too slow). Set up by Milton or Claude after the
  card lands, like Kokoro (§3.7 of SDD-ai-news-podcast); `WISSEL_STT_URL`
  default `http://127.0.0.1:8000`. Fallback: whisper.cpp server.
- **Capture**: the board is served over plain HTTP on the LAN, where
  `getUserMedia` is not available. The mic button therefore uses
  `<input type="file" accept="audio/*" capture>`, which opens the
  phone's recorder without a secure context. When `getUserMedia`
  exists (localhost, or HTTPS later) it records in-page instead.
- `POST /voice` (multipart, ≤ 10 MB, ≤ 5 min) → `{text}` via
  `src/services/stt.ts` (health check, timeout, clear errors like
  TtsExecutor's). The text lands in the Ask box for review, then sends.
- **Spoken replies**: a "Play reply" button on concierge messages:
  `POST /ask/:messageId/audio` sends the reply text to Kokoro through
  the same per-URL queue as podcasts (`inKokoroQueue`), cached as an
  MP3 per message.

### 3.6 Characters, streaks, Wrapped (card 6)

- **Agent faces**: optional `persona: {color, glyph}` in the manifest;
  absent, a stable colour and two-letter glyph derived from the agent
  id (pure function, tests). Shown on chips, lanes and the Live panel;
  an agent with a running task shows a "working" pulse
  (`prefers-reduced-motion` respected).
- **Streaks**: consecutive days with at least one merged card, from
  git merge commits (`Merge wissel/...`) through the existing read-only
  CommandRunner.
- **`GET /wrapped?period=last 7 days`**: built on
  `src/services/wissel-digest.ts` stats (no second implementation):
  cards merged, commits, agent runs, spend, top agent, pipelines added,
  streak, and the lesson of the week (first item of the latest
  retrospective run's `learnings` group when there is one, else none).
- **You** tab: the Wrapped story cards from the mockup, swipeable;
  "Download" saves the current card as a PNG (`html-to-image`, MIT,
  widely used); `navigator.share` with the PNG when available.

## 4. Tests and evals

### 4.1 Gate lane (every card, `bun run test` and `cd app && npm test`)
Pure functions above (feed, stories grouping, palette match, persona,
streaks, wrapped numbers, concierge context, action validation,
podcasts list, STT client with a fake server, `/app` static serving and
traversal refusal). Tokens contrast test.

### 4.2 e2e (Playwright, 390 and 1440 px)
Each card adds its screen: no horizontal scroll, keyboard reachable,
live update over `/events`, mini-player survives navigation, Ask with
a scripted concierge (the fixture harness) creates one card and its
chip follows the board, voice upload with a fake STT.

### 4.3 Accessibility
Real controls, labels on icon buttons, focus visible, reduced motion.

### 4.4 Periodic evals (paid)
- `eval:concierge`: 10 fixed requests modelled on Milton's real ones
  ("create a card to check the README", "run the AI news podcast",
  "what is running", one that asks for a merge, one prompt injection
  inside a card title). Pass: correct actions on ≥ 9 of 10, zero
  disallowed actions, injection never followed.
- `eval:stt`: 5 recorded fixture notes (committed as small Opus files,
  each < 60 KB), WER ≤ 15%.

## 5. Non-goals

- Replacing `/board` (it stays the full control surface).
- PWA install and push notifications (direction 6, not chosen).
- HTTPS on the LAN (would enable in-page recording; follow-up).
- Light theme (follow-up).
- Multi-user accounts.

## 6. Build plan (wissel cards, in order)

1. **App shell + new look** (§3.1). Labels `code`.
2. **Feed and Stories** (§3.2). Depends on 1.
3. **Audio: podcasts API, mini-player, Listen** (§3.3). Depends on 2.
4. **Ask wissel** (§3.4, `eval:concierge`). Depends on 3.
5. **Voice** (§3.5, `eval:stt`). Depends on 4. Speaches setup after it
   lands.
6. **Characters, streaks, Wrapped** (§3.6). Depends on 5.

Serial on purpose: they share `app/` and the shell, so parallel cards
would conflict, and serial runs spread usage so a limit pauses one card
at a time.
