# The app

`app/` (Vite, React, TypeScript, vitest), served at `/app`
(`docs/SDD-wissel-app.md`). Phone first (390 px) and desktop. The board
stays at `/board`, unchanged apart from a "Try the new app" link in its
top bar.

- **Shell.** Phone: a bottom tab bar (Feed, Ask, Board, Listen, You).
  Desktop (1024 px and up): a left rail and a right **Live** panel
  (at work, running, needs you, landed today). Screens are hash routes
  (`#/feed`, `#/ask`, ...); `/app` opens Ask.
- **Command palette.** Cmd-K or Ctrl-K (or the search button): jump to a
  screen, open a card by title, run a pipeline by name, New card (opens
  Ask).
- **Board tab.** Running, Needs a human, Next step, Review and Done today from `/tasks`,
  a read-only card view at `#/board/<id>`, and a link to the full board.
- **Live.** One shared `EventSource('/events')` keeps every screen
  current.
- **Look.** A news-site layout (white ground, heavy sans headlines, one
  green, hairline-ruled lists, header nav on desktop). Light tokens by
  default and dark ones under `prefers-color-scheme`, both in
  `app/src/tokens.ts` (contrast checked by a unit test), self-hosted
  fonts (Figtree, Geist Mono via `@fontsource`): no internet needed on
  the LAN. Reference mockups: `docs/mockups/techcrunch/`.
- **Feed.** What happened, newest first, from `GET /feed?limit=&before=`
  (`src/services/feed.ts`, pure `buildFeed`): cards that landed, cards
  that need you (review, escalated, failed with Retry, no match, an MCP
  approval with Approve, a card held for a switched-off harness),
  podcasts with Play (in the mini-player), their `check-news-run`
  results, and each past day's spend by harness. Updates live over
  `/events`; "Load more" pages back.
- **Stories.** Rings for the last 24 hours (AI news, World, Needs you,
  Landed, Your week). A ring opens a full-screen viewer: tap or swipe
  left/right, arrow keys, swipe down or Escape to close. Watched rings go
  grey (kept in `localStorage`).
- **Mini-player.** One player for the whole app, above the tab bar on a
  phone and in the Live panel on desktop: play/pause, back 15 s,
  forward 30 s, a position slider. It keeps playing while you change
  screens, remembers where you stopped in each episode (and what was
  playing, across a reload) in `localStorage`, and shows the episode on
  the lock screen and headset keys through Media Session.
- **Listen.** Every podcast pipeline's episodes from `GET /podcasts`
  (`?limit=` per pipeline, 1 to 50, default 10), latest first, with the
  same Quick read as the board's run drawer: sources as links, invented
  sources flagged, and "More" for the explain step's detail. The app
  runs the board's own `board-news.js` for it through `app/src/news.ts`.
- **Ask.** Chat with wissel (`POST /ask`, `GET /conversations`,
  `GET /conversations/:id`; `docs/SDD-wissel-app.md` §3.4). The
  `concierge` agent (claude-fable-5-1, no tools, private `claude` harness
  only) reads the board as fenced data and proposes actions, checked in
  code before anything happens, at most three per message: create a
  card (labels from the board's set, repo only a registered project),
  run a pipeline, show a card, or press one of the board's own buttons
  (§3.7). Those run the same functions as the board's endpoints
  (`src/services/board-actions.ts`), on cards found in code by id8 or
  title words (zero or several matches is a question, never a guess),
  and only when the board would allow it. At once: move, run now,
  retry, stop, approve or deny an MCP request, grant and retry, abandon,
  archive, unarchive, add a dependency, set a card's harness, enable or
  disable a harness or MCP server, set a harness model. After a Confirm
  tap in the app (`POST /ask/actions/:id/confirm`, 10 minutes, once,
  never from a "yes" in chat): merge, discard, delete a card or a
  pipeline, grant tools, trust an MCP tool, remove a project, and any
  batch of more than three cards ("retry everything that failed"
  expands in code, at most 10). Never from chat: secrets, accounts,
  `agents/manifest.yaml`, pipeline contents, restarting the server.
  Archive, move and harness changes get an Undo chip. Every control
  action is stored on its message and logged as an `ask.action`
  telemetry row. Cards it makes show as chips that follow the board
  live; a podcast run gets Play once its audio is ready. Quick replies
  (run a podcast, what needs me, retry failed, show harnesses, what did
  I do this week, what is running, show board) come from code. Each
  reply shows its cost, which also goes to telemetry. The open chat
  survives a reload; "Earlier chats" lists the rest. Palette "New card"
  now opens Ask.
- **Voice.** The mic button in Ask turns a voice note into text
  (`POST /voice`, multipart, at most 10 MB and 5 minutes;
  `docs/SDD-wissel-app.md` §3.5) through the local speaches service
  (`WISSEL_STT_URL`). The text lands in the box to check before sending.
  On the board's plain-HTTP LAN address the mic opens the phone's own
  recorder; on localhost (or HTTPS) it records in the page and stops by
  itself at 5:00. "Play reply" on a wissel message has Kokoro read it
  (`POST /ask/:messageId/audio`, the podcasts' queue, one MP3 per message
  in `<WISSEL_AUDIO_DIR>/ask/`) and plays it in the mini-player. Set up
  speaches once: `docker run -d --name speaches --restart unless-stopped
  -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:latest-cpu`, then
  `curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small`.
- **Agent faces.** Every agent has an avatar: a colour and a one or two
  letter glyph. Set one with `persona: { color: "#RRGGBB", glyph: "Im" }`
  in `agents/manifest.yaml` (checked at load); without it the app derives
  a stable one from the agent id (`app/src/persona.ts`). Faces show on
  Board and Live rows and on Ask's chips; an agent with a card running
  pulses as "working" (a still ring with reduced motion). The Live panel
  and You list who is at work right now.
- **You: Wissel Wrapped.** `GET /wrapped?period=last 7 days` (or `last
  30 days`, `since YYYY-MM-DD`; `docs/SDD-wissel-app.md` §3.6): cards
  merged, commits, agent runs, spend and the top agent straight from the
  retrospective's digest (`src/services/wissel-digest.ts`), plus
  pipelines added, the merge streak (days in a row with a `Merge
  wissel/...` commit, read-only git) and the lesson of the week (the
  latest retrospective run's first learning). The You tab shows them as
  story cards you swipe (or Previous/Next, arrow keys), with 7 and 30 day
  views. Download saves the current card as a PNG; Share sends it through
  the phone's share sheet where the browser has one.

Tests: `cd app && npm test` (vitest), `e2e/app.spec.ts`,
`e2e/feed.spec.ts`, `e2e/listen.spec.ts`, `e2e/ask.spec.ts` and
`e2e/ask-control.spec.ts` (with a scripted concierge),
`e2e/voice.spec.ts` (with a fake speaches) and `e2e/you.spec.ts` at 390
and 1440 px. `bun run eval:concierge` is the paid eval of the real
concierge (`--suite basic` or `--suite control`, both by default; the
control suite's 41 requests report a pass rate per category);
`bun run eval:stt` checks the real speaches on five fixture
notes (word error rate at most 15%, `eval/fixtures/stt/`);
`bun run eval:ask-schedules` checks Ask's schedule actions (see
[Pipelines and schedules](pipelines-and-schedules.md)).

---

[Back to the README](../../README.md)
