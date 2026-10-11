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

**As built (card 1).** Where the build fills in or departs from the above:

- Serving lives in `src/api/serve-app.ts` (`serveAppAsset`), not inline
  in server.ts. It decodes the path and resolves it against `app/dist/`
  itself, because an encoded slash (`..%2f`) survives `new URL()`
  normalisation. A missing file name (`x.js`) is a 404, not
  `index.html`; hashed `assets/` are cached for a year, everything else
  revalidates; 503 while unbuilt.
- `/app` with no hash opens **Ask** (chat-first). Unknown hashes fall
  back to Ask.
- "Open a card by title" opens `#/board/<id>`, a read-only card view in
  the app (status, agent, account, labels, repo, body, link to the full
  board), since `/board` has no deep link to a card and card 1 must not
  change its behaviour.
- "New card" opens `/board#/new` (the board's New drawer) until Ask
  (card 4) can create cards. "Run a pipeline" posts
  `/pipelines/:id/run` with no repo or input, which suits the repo-less
  podcast pipelines; others fail with the server's message in a status
  line.
- Board tab lanes: Running = `running` + `dispatched`; Needs you = the
  board's set (review, escalated, failed, no-match, open MCP approval);
  Review = `pending-review`; Done today = `done` with `doneAt` since
  local midnight. Inbox and ready are left to the full board.
- The hub closes the EventSource when the last subscriber leaves and
  reopens on the next; the shell subscribes for its lifetime, so in
  practice there is one connection.
- Tokens are injected as a `<style>` from `tokens.ts` at startup, so
  the TS object is the only copy. The contrast test covers every text
  colour on ground, surface and surface-2, plus ground on the three
  accent fills.
- `e2e/app.spec.ts` adds `app.spec.ts` to the e2e-affected map (`app/**`
  and `serve-app.ts` map to it; a board.html change also runs it, for
  the header link).

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

**As built (card 2).** Where the build fills in or departs from the above:

- `buildFeed` takes `{tasks, results, runs, telemetry, disabledHarnesses,
  now, limit, before}`: `results` is each task's latest result
  (`Board.listResultMeta`, one query, no summaries) and `runs` are podcast
  runs already read off disk. The I/O lives in
  `src/services/feed-sources.ts` (`createFeedSource`), which caches parsed
  telemetry on file size + mtime and a settled podcast run's facts on its
  status + MP3 size, so a run is checked once, not per request.
- Items carry extra optional fields the app draws: `show` (ai, world,
  retro, other) on podcast/checks, `audioUrl` and `durationSeconds` on
  podcast, `pass` on checks, `undated` on a needs-you card with no
  recorded time (its `at` is the request's `now`; the app shows
  "Waiting").
- `landed` is dated by `doneAt`, then the result's `finishedAt`, then
  the task's last telemetry event; with none of the three it is left
  out. Pipeline step cards and reviewer cards are not landings, and a
  podcast run's root shows as its `podcast` item instead.
- `needs-you` actions: Approve (`POST /tasks/:id/mcp-approval/approve`)
  for an open MCP approval, Retry (`POST /tasks/:id/run`) for failed,
  Open (`/app#/board/<id>`) otherwise. POST actions confirm first.
- `podcast` covers any pipeline with a `podcast-audio` step and an MP3
  on disk; duration is the CBR estimate from the MP3's head and size
  (same arithmetic as `checkAudio`). `checks` is its own item, right
  after its podcast, only for kinds `checkStoredRun` knows.
- `spend` is one item per past local day with spend, dated the midnight
  that closed it, so "yesterday" appears at 00:00 and older days stay
  in the feed's history.
- Paging: `next` is `<iso>~<id>`; `before` takes that or a bare ISO
  time. `limit` 1 to 200, else 400.
- `checkStoredRun` moved with `loadStoredRun`, `runTelemetry`,
  `readTelemetryLines`, `firstHeadline` and `mp3DurationSeconds` into
  `src/services/news-run-checks.ts`; `scripts/check-news-run.ts` keeps
  its CLI and re-exports the old names. It still imports the checks
  from `eval/ai-news-checks.ts`, as the script did.
- Stories: podcasts and checks go to AI news or World by show; the
  retro, other podcasts and spend go to Your week. Items play oldest
  first. A ring is "new" until its newest item has been shown; the
  mark is in `localStorage` (`wissel.app.storiesSeen`). No auto-advance,
  so nothing moves by itself and reduced motion needs nothing extra. The
  viewer is a native modal `<dialog>` (Escape closes); arrow keys step.
- Live: the Feed refetches `/feed` on any `/events` message (150 ms
  debounce) through the shared EventSource, at the size already shown
  so "Load more" pages stay put.
- e2e: `e2e/feed.spec.ts`; `app/**` now maps to both `app.spec.ts` and
  `feed.spec.ts`, and the three feed services map to `feed.spec.ts`.

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

**As built (card 3).** Where the build fills in or departs from the above:

- `GET /podcasts?limit=` returns a bare array, newest first (run id
  breaks a tie), at most `limit` episodes **per pipeline** (1 to 50,
  default 10, else 400) so a daily show can't push a weekly one out.
  Each item also carries `pipelineId` and `show`. `title` is the first
  Quick read headline, else the pipeline's name. A run with audio but
  nothing to date it by is left out, as in the feed. Pure shaping in
  `src/services/podcasts.ts` (`buildPodcasts`, `podcastQuickRead`); the
  runs come from `createFeedSource`'s `podcasts()`, through the same
  per-run cache as the feed's podcast items, so a settled run is read
  once for both endpoints.
- `quickRead` is not rows: it is the parsed handoff data rows are made
  from, `{items, gatherSources, explain}` (`items` is the script step's
  `quickRead` list, `gatherSources` the gather step's URLs via
  `gatherUrlSet`, `explain` the explain step's stories cut to the fields
  `joinExplained` reads), or null when there is no `quickRead` list. The
  app shapes rows with the board's code, so the two can't drift.
- `board-news.js` gains `quickReadView(quickRead, urls, explainData)`:
  `newsView`'s row loop, pulled out unchanged (same rows, same reasons;
  `newsView` now calls it). The board's behaviour is unchanged.
- The ESM wrapper: `app/vite.config.ts`'s `browserScript` plugin loads a
  board script imported with `?browser-script` as is, with a local
  `module` before it and `export default module.exports` after (works
  in `vite build` and vitest alike, no eval). `app/src/news.ts` types it
  from `board-news.d.ts` and exports `quickReadView` and
  `episodeQuickRead`.
- The player is `app/src/player.ts` (`createPlayer`, no React, tested
  with a fake `<audio>`); `app/src/usePlayer.tsx` is the React glue and
  `PlayerContext`. The `<audio>` sits outside everything that changes
  with the route or the 1024 px breakpoint, so neither stops playback.
  `localStorage`: `wissel.app.positions` (run id to seconds, newest 50,
  saved every 5 s while playing, on pause and on `pagehide`; a spot in
  the last 10 s, or an episode that ended, starts over) and
  `wissel.app.nowPlaying` (the last track, restored paused after a
  reload; only an `/pipeline-runs/` URL is accepted back).
- Media Session: metadata (title, pipeline name, "wissel"), playback
  state, position state, and play, pause, seek back/forward (15 s / 30 s
  default) and seek-to handlers. An action the browser refuses is
  skipped.
- The feed's podcast items lose their own `<audio>` and get a Play
  button that plays in the mini-player (same in the story viewer), so
  there is one player in the app. Feed podcast items gain
  `pipelineName` for the player's second line.
- Listen: the latest episode per pipeline shows its Quick read open;
  earlier ones fold it in a `<details>`. Each row's "More" is a
  `<details>` with the detail, "Why it matters" and "Not known yet". An
  episode shows "Resume at 3:12" when it has a saved spot.
- e2e: `e2e/listen.spec.ts`. The e2e board has no podcast runs (one
  needs Kokoro), so the page serves `/podcasts` and the MP3s from the
  checked-in fixtures (`silence.mp3` repeated to about 30 s, with Range
  support), as `pipelines.spec.ts` does for its run drawer; the real
  endpoint is checked on its own and over a real board in
  `test/podcasts.test.ts`. `app/**`, the feed services, `podcasts.ts` and
  `board-news.js` now map to `listen.spec.ts` too.

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

**As built (card 4).** Where the build fills in or departs from the above:

- The agent has `executor: concierge` and the tag `ask-chat-concierge`.
  `ReadOnlyExecutor.canHandle` refuses `executor: concierge`, so no pool
  can pick it for a card; Ask (`src/services/concierge.ts`) calls the
  executor's `run` itself. Startup's harness check skips an agent no pool
  runs. Ask acquires the `claude` harness per message; off, missing or
  busy, the reply says so and nothing runs or is spent.
- Context (`concierge-context.ts`): at most 40 open cards, newest first,
  with a count of the rest; pipeline step cards are left out (their run's
  root stands for them); the 10 newest landed by `doneAt`; the last 20
  messages, each cut to 2,000 characters; the labels a chat card may
  carry (`chatLabels`: every agent's tags minus the concierge's and the
  `-step` tags of pipeline-only agents). The nonce is fresh per message;
  the data is one JSON block, so no title can put a fence line in it.
- Validation (`concierge-actions.ts`): the last ` ```wissel-actions `
  block wins; no block or broken JSON takes no action and shows the prose
  with a note. `create_task` takes a project's path or its name (stored
  as the path); without a repo it is dropped when its labels route
  confidently to an agent with write or bash access, the same rule as
  `POST /tasks`. Title at most 200 characters, body and input 8,000.
  `run_pipeline` matches the exact name in any case, or the id; a
  pipeline with a step that needs a repo is dropped (Ask has no repo to
  give it). `show_task` takes a full id or a unique prefix of 8 or more.
  The same action twice is dropped once. `DroppedAction.disallowed` marks
  a type outside the three.
- Store: messages also keep `dropped` (proposed, not taken). A chat's
  title is its first message, 60 characters at most.
- `POST /ask` answers once the actions ran; a pipeline run counts as run
  when its root card exists (`onRootCreated` on the pipeline runner's
  context), not when it settles. Text is 1 to 4,000 characters; a usage
  limit names its reset time. Telemetry: a `dispatch` and a `result` for
  task id `ask-<user message id>`, model and cost included. The cwd is
  one shared empty scratch dir (`~/.wissel/scratch/ask-concierge`).
- "Thinking" goes out on `/events` as a named SSE event `ask`
  (`ask.thinking`, `ask.replied`). `/board` reads only plain messages,
  so it never sees them; the app's hub has `subscribeAsk` for them on
  the same one connection.
- UI: the shell holds the chat (`app/src/useAsk.ts`), so a reply that
  lands while another tab is open is there on return; the open chat's id
  is in `localStorage` (`wissel.app.askConversation`). "New chat" and
  "Earlier chats" (`GET /conversations`). Enter sends, Shift-Enter is a
  new line. A reply is shown only after a `/tasks` refetch, so a card it
  just made has the right chip even when its board event was missed;
  until `/tasks` first answers an unknown card reads "Loading", after
  that "Gone". Chips read Queued, Running, In review, Needs you (with
  why) or Done. A podcast run's chip gets Play once `GET /podcasts` has
  the run. Quick replies: "Run <name>" for up to two pipelines with a
  `podcast-audio` step, "What did I do this week?", "What is running?",
  and "Show board" as a plain link (no model call). Palette "New card"
  now opens Ask instead of `/board#/new`.
- e2e: `WISSEL_CONCIERGE_SCRIPT` (set by playwright.config.ts) makes the
  server run the concierge on a scripted `claude -p`
  (`src/services/concierge-script.ts`, script in
  `e2e/fixtures/concierge-script.json`) on a one-harness pool of its own:
  the real executor, parsing, validation and board, no model. Specs in
  `e2e/ask.spec.ts`; `app/**` and the concierge services map to it.
- `eval:concierge` runs each request on a fresh seeded board through the
  real `POST /ask`, judged in code; pipeline steps are faked, so a run
  starts but no other agent runs. "Zero disallowed actions" is counted
  on what the model proposed, since validation already makes executing
  one impossible. `test/concierge-eval.test.ts` checks every case's judge
  passes a right scripted answer and fails a wrong one, for free.

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

**As built (card 5).** Where the build fills in or departs from the above:

- `src/services/stt.ts` (`SttClient`): one `/health` try (any 2xx;
  speaches answers a plain `OK`), then `POST /v1/audio/transcriptions`
  with `model` (`WISSEL_STT_MODEL`, default `Systran/faster-whisper-small`),
  `response_format=verbose_json` and `language` only when
  `WISSEL_STT_LANGUAGE` is set. 10 minute timeout. Every failure is an
  `SttError` with the HTTP status `POST /voice` answers: 400 bad upload,
  413 over 10 MB or 5 min, 415 not audio, 422 no speech heard, 502
  speaches answered wrong (a model that isn't downloaded names the `curl`
  that downloads it), 503 not reachable, 504 too slow.
- The 5 minute cap: the in-page recorder stops itself at 5:00; a picked
  file is checked in the browser when it reports a length; the server's
  own check uses the `duration` speaches reports, so it lands after the
  transcription (no ffmpeg or container parsing in wissel). The 10 MB cap
  is checked on `Content-Length` and while reading the body, before
  speaches is asked.
- Bun types a multipart part by its file name, so the note keeps its name
  and gets an extension from its type when it has none (`noteFileName`).
- **Bun's idle timeout**: Bun drops any request with no response after
  10 s by default (measured: the client sees the socket close). `POST
  /voice`, `POST /ask/:id/audio` and also card 4's `POST /ask` now call
  `server.timeout(req, 0)`; before this, a real concierge answer over 10 s
  never reached the app. `POST /pipelines/:id/run` (the board's Run) has
  the same issue and is left as is, since card 5 must not change /board.
- Spoken replies: `TtsExecutor.speak(text, file, {maxQueueWaitMs})` is the
  one Kokoro call for podcasts and replies; `inKokoroQueue` gained
  `maxWaitMs`, so a reply waits at most 60 s behind a podcast, then
  answers 503 "Kokoro is busy" and is skipped when its turn comes. Replies
  use one `/health` try (a podcast waits up to 10 min). The text is
  shaped by `spokenText` (no Markdown, code or URLs, cut at a sentence
  end past 4,000 characters). `src/services/reply-audio.ts` caches
  `<audioDir>/ask/<messageId>.mp3`, shares one synthesis between two taps,
  and `GET`/`HEAD /ask/:id/audio` serve it with Range. Nothing prunes the
  folder; a reply is about 1 MB a minute.
- "Play reply" plays in the shell's one player (no second `<audio>`): a
  track `reply-<messageId>` titled by the reply's first line, "wissel
  reply" as its second line, and the mini-player's title links to
  `#/ask`. A restored now-playing track may be an `/ask/` URL too.
- Mic button: left of the box. `canRecordInPage` (getUserMedia and
  MediaRecorder) picks in-page recording, Opus first at 32 kbit/s,
  otherwise the button clicks a hidden `<input type="file"
  accept="audio/*" capture>`. A recording bar shows the clock, Stop and
  Cancel. The text goes into the box (after what is already there) and
  focus returns to it; nothing is sent until Enter.
- e2e: `e2e/voice.spec.ts`. playwright.config.ts starts a fake speaches
  (`e2e/fixtures/fake-stt-server.ts`, port 8791) in the web server's
  command. In-page recording uses a Web Audio tone as the microphone, so
  the real MediaRecorder runs. Kokoro stays port 9 in e2e (pipelines.spec
  depends on it failing), so Play reply's success path serves the MP3
  from the fixture by route, and its failure path hits the real server.
- `eval:stt`: `eval/stt.eval.ts` with `eval/stt-checks.ts` (WER by word
  edit distance after normalising case, punctuation and 0 to 12). The
  five notes' text is in `eval/fixtures/stt/notes.json`; the Opus files
  (each under 256 KB) come from `bun run scripts/make-stt-fixtures.ts`
  against Kokoro, or are recorded by Milton. They are not committed (no
  binaries in the repo; `.gitignore` keeps `eval/fixtures/stt/*.opus`
  out): `eval:stt` makes any missing note from Kokoro before it runs,
  and exits 2 naming the files only when that fails.

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
- `eval:stt`: 5 fixture notes (Opus, each < 256 KB, made from Kokoro on
  first run and not committed), WER ≤ 15%.

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
