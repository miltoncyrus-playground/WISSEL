# SDD: Board UI cleanup (phase A) and first-class pipelines (phase B)

Status: approved by Milton 2026-10-06. Phase A first, then phase B.
Decisions: merge the 11 statuses into four lanes; show a pipeline run as
one card with step progress, and clicking it shows the full detail.
Nothing that exists today may become unreachable; it may move.

## 1. Why: measured on the live board (1440x900, 2026-10-06)

- About 300px of controls before the first card: title, intro text,
  version, harness chips, two "Manage" buttons, six view tabs, project
  switcher, pipeline editor link, theme toggle, task count.
- Work and setup are mixed. The Board view ends with the full Agents and
  Skills lists. The Projects summary renders on every view, even New
  task. Harness and MCP settings are header buttons.
- The board is cramped. With 11 status columns the empty ones collapse
  and Done gets about 90px, so every title is truncated. A row of 12
  count tiles repeats the column counts. The page is 2,208px tall.
- Nothing answers "what needs me?". Review, escalated, failed, no-match
  and MCP approvals sit in separate columns among the rest.
- Pipelines live in a separate app (`/pipelines/edit`, "↗" link) with its
  own look and its own Run box. A pipeline run shows on the board as one
  card per step (steps carry `pipelineRunId`; board.html ignores it).
- The New task form is long. "Depends on" lists every stale
  pending-review card; "Follow-up of" is a plain dropdown.

## 2. Measurable targets

Each card states which of these it moves and proves it with a
screenshot or an e2e assertion at 1440x900.

| # | Target | Today | Goal |
|---|---|---|---|
| T1 | Height of controls above the first board card | ~300px | ≤ 120px |
| T2 | Truncated card titles in any lane | all of Done | none (wrap to 2 lines max, full title on hover) |
| T3 | Clicks to start a pipeline run from the board | leave page, ≥ 4 actions | ≤ 3, never leaving the page |
| T4 | Cards needing a human, shown in one place | 0 (spread over 5 columns) | 100% in "Needs you" |
| T5 | Board cards per pipeline run | 1 + one per step | 1 |
| T6 | Setup items on the Board view | Agents, Skills, Projects summary, harness chips | 0 (all under Setup) |

## 3. Phase A: reorganize the existing page

Still the single `board.html` and vanilla JS. No framework.

### 3.1 Shell and navigation (card A1)

- A left sidebar with two groups:
  - **Work:** Board, Pipelines, Archive.
  - **Setup:** Agents & skills, Harnesses, MCP servers, Projects, Memory,
    Settings.
- A compact top bar: project switcher, "+ New" button, live status dot
  with the task count, version in small text. The page title and intro
  paragraphs go.
- **Setup pages replace the floating panels.** Harnesses and MCP servers
  become full pages that reuse the existing panel content and endpoints.
  Agents & skills moves off the Board view. The Projects summary renders
  only on the Projects page. The theme toggle moves to Settings.
- Swimlanes stays reachable as a view switch on the Board page (Lanes /
  By feature), since it's another way to look at the same work.
- The current view is reflected in the URL hash (`#/board`,
  `#/setup/harnesses`, ...) so reload and back/forward work.
- The sidebar collapses to icons below 1100px. No horizontal scroll at
  1280px.

**A1 revision notes (as built).**
- Routes live in `src/api/public/board-routes.js` (`BOARD_ROUTES`,
  `parseBoardRoute`): `#/board`, `#/board/features` (By feature),
  `#/archive`, `#/new` (a redirect since A3, see §3.3),
  `#/setup/{agents,harnesses,mcp,projects,memory,settings}`.
  An empty hash is the board; an unknown hash falls back to the board
  and is rewritten to `#/board`. Each page is a `<section data-page>`
  in `<main>`; `test/board-routes.test.ts` and `test/board-html.test.ts`
  keep the table, the sidebar links and the markup in sync.
- The Lanes / By feature switch sits in the top bar, shown only on the
  Board page, rather than in a toolbar row inside the page. A row inside
  the page costs ~40px and pushes the first card past T1's 120px.
- The count tiles moved below the kanban instead of being deleted, so
  A1 doesn't do A2's job; A2 still removes them.
- Harness and MCP pages keep the old panel element ids (`#harnessPanel`,
  `#mcpPanel`, `#hmList`, `#mcpList`, `#mcpAddForm`), so their render
  code and endpoints are unchanged. The "Available now" harness strip
  moved to the top of the Harnesses page.
- The Projects summary renders only while the Projects page is showing.
  That also stops the board from requesting a project ELI5 (an LLM call)
  on every page load.

### 3.2 Board: "Needs you" and four lanes (card A2)

- **"Needs you" strip** at the top. It holds every card whose status is
  `review`, `escalated`, `failed` or `no-match`, plus any card with a
  pending MCP approval. Each shows why it's there ("review", "escalated
  after 6 rejections", ...) and opens the existing task drawer. Hidden
  when empty.
- **Four lanes** replace the 11 columns:

  | Lane | Statuses |
  |---|---|
  | Queued | inbox, ready |
  | Working | running, dispatched, reviewing |
  | In review | pending-review |
  | Done | done (default: last 24h, "show all" toggle) |

  `review`, `escalated`, `failed` and `no-match` appear only in "Needs
  you", never in a lane, so nothing shows twice. Each card carries its
  exact status as a small tag.
- Remove the row of count tiles; counts go in the lane headers.
- Superseded cards stay hidden from lanes by default (they're history),
  with a "show superseded" toggle.
- Titles wrap to 2 lines and show in full on hover (T2).
- `STATUS_COLOR`, `STATUS_LABEL` and `COLUMNS` (board.html ~886-905)
  are replaced by a single status→lane table. The lessons.md rule
  "adding a status means changing types.ts + these lists" must be
  updated to match.

**A2 revision notes (as built).**
- The status→lane table is `STATUS_DISPLAY` in
  `src/api/public/board-lanes.js`, next to the pure placement logic
  (`taskPlacement`, `needsYouReason`, `partitionBoard`), so bun test
  covers it directly. `test/board-lanes.test.ts` reads
  `TaskCard.status` out of `src/core/types.ts` and fails if any value
  has no lane. A status the table doesn't know lands in Needs you, not
  nowhere.
- "Reviewing" (a reviewer's own `running` card) stays a display status:
  it sits in Working with a "Reviewing" tag.
- "Any card with a pending MCP approval" means `pendingMcpApproval` set
  and status still `review`, the same gate the drawer's approval panel
  uses (the field is never cleared). Its reason names the call:
  "MCP approval: slack · send_message".
- Escalated reasons read "escalated after N rejections" with N =
  `pushbackCount + 1`: the orchestrator escalates on the rejection that
  arrives once `pushbackCount` hits its limit.
- Done's 24h window uses `doneAt`. A done card without one (older than
  the field) stays visible. The header reads "Done (3 of 10)" while
  some are hidden, with a "Show all" / "Last 24h" toggle.
- "Show superseded" is a checkbox in the top bar (Lanes view only), so
  it costs no height above the first card (T1). Superseded cards show
  in their own column after Done, never in Needs you or a lane.
- The bulk Clear moved with the statuses: Done keeps it (it clears the
  cards Done shows), and Needs you has "Clear failed / no match" for
  those two terminal statuses. Review and escalated get none.
- Every lane takes an equal share of the board width, empty or not, so
  a card keeps the same size whatever the other lanes hold. An empty
  lane only dims its header. (Revision 2026-10-07, Milton: the earlier
  "empty lane collapses to its header" rule let a lone Done lane stretch
  its cards across the whole screen.)

### 3.3 "+ New" drawer (card A3)

A side drawer with two tabs.

**Task.** The current New task form, cleaned up:
- "Depends on" becomes a search box over live cards (not done, not
  archived, not superseded), not a checkbox list of everything.
- "Follow-up of" becomes the same search.
- The routing preview stays.
- The router override stays under "Advanced".

**Pipeline run.**
- Pick a saved pipeline, a repo (the same project-aware picker as
  Task), and the input.
- Submit calls the existing `POST /pipelines/:id/run`.

The "New task" view tab goes away; its URL redirects to the board with
the drawer open.

**A3 revision notes (as built).**
- The drawer is `#newDrawer` (the task drawer's overlay + slide-in,
  560px wide) with `role="tab"` buttons Task / Pipeline run. "+ New"
  opens it over whatever page is showing and doesn't touch the URL or
  history. `openNewDrawer(tab, { pipelineId })` in board.html is the one
  entry point; A4's per-pipeline Run calls it with the pipeline id.
- `#/new` is now `BOARD_ROUTE_REDIRECTS.new` in board-routes.js:
  `parseBoardRoute` returns `{ route: "board", redirected: true,
  openNew: "task" }`, and `applyRoute` rewrites the address bar to
  `#/board` (replaceState) so a reload doesn't reopen the drawer.
- "Live card" is `isLiveCard` in `src/api/public/board-new.js`: not done,
  not archived, not superseded. Failed, escalated and no-match cards are
  live. `searchLiveCards` matches every query word against title, id,
  status and routed agent, newest first (GET /tasks is in creation
  order), 8 results max; `test/board-new.test.ts` covers it.
- "Follow-up of" additionally needs a routed card (`routedOnly`), as the
  old dropdown did: the restriction is the parent's declared handoffs,
  and an unrouted card has none. One parent at most; the hidden
  `#ntParentTask` keeps the pick for the submit handler and preview.
- A pick stays until removed or until its card leaves the project-scoped
  list (deleted, or switched away from), not when its card changes
  status, so a dependency doesn't vanish while the form is open.
- Pipeline run shares the Task tab's repo datalist and project lock
  (`applyProjectLockToNewTaskForm` locks `#ntRepo` and `#prRepo`). The
  list is refetched from `GET /pipelines` every time the tab opens.
  `POST /pipelines/:id/run` only responds once the run settles, so the
  tab says the run is already on the board while it waits, then reports
  the root's final status.
- e2e runs the Pipeline run tab against the real endpoint with a
  pipeline whose two steps point at each other: no entry step, so
  `startPipelineRun` fails the root at once without spawning an agent.

### 3.4 Pipelines page (card A4)

Lists saved pipelines (`GET /pipelines`): name, description, step count,
last run and its outcome. Each has **Run**, which opens the "+ New"
drawer on the Pipeline run tab with that pipeline preselected (T3), and
**Edit**, which opens the existing editor at `/pipelines/edit/<id>`.
Also a "New pipeline" button that opens the editor. The editor itself
is unchanged in phase A.

**A4 revision notes (as built).**
- The page is `#/pipelines` (`BOARD_ROUTES.pipelines`, section
  `#pipelinesPage`); the sidebar's Pipelines link points there instead
  of out to `/pipelines/edit`. The editor is still reachable: New
  pipeline (`/pipelines/edit`) and each row's Edit
  (`/pipelines/edit/<id>`), both plain links in the same tab.
- Row logic is `src/api/public/board-pipelines.js` (`pipelineRows`,
  `lastRunsByPipeline`), covered by `test/board-pipelines.test.ts`. The
  list is refetched from `GET /pipelines` on every visit. The last run
  comes from the board's own task list, not a new endpoint: a run root
  is a card with `pipelineId` and no `parentTaskId` (the same filter as
  `GET /pipelines/:id/runs`). A TaskCard has no creation timestamp, so
  "last" is the latest root in `GET /tasks` order (rowid = creation
  order), and the column shows the run's status and input instead of a
  date. It follows SSE refetches through `render()`, and it uses the
  project-scoped `tasks`, so with a project selected it reads "No runs
  in this project".
- Clicking the last run opens that root card's task drawer.
- Run calls `openNewDrawer("pipeline", { pipelineId, repo })`. `repo`
  is the last run's repo and only fills an empty, unlocked Repo field,
  never over a typed repo or the project lock.
- T3, measured by `e2e/pipelines.spec.ts` at 1440x900: 3 clicks
  (sidebar Pipelines, Run, Start run), with repo and input typed. A
  window marker set before the first click survives, so the document
  never navigates.

## 4. Phase B: pipelines as part of the app

### 4.1 One card per run, with detail on click (card B1)

- On the board, a step card (`pipelineRunId` set) never renders as its
  own card. The run's root card ("Pipeline: <name>") shows:
  - step progress, e.g. "3/5 steps · now: Reviewer (attempt 2)";
  - a compact step bar coloured by each step's status.
- A run sits in the lane its root status maps to. A run with a step in
  a "Needs you" status (failed, escalated, MCP approval) also appears
  in "Needs you".
- **Clicking the run card opens a run detail drawer**, which lists every
  step in order with agent, harness, model, status, duration and cost.
  Expanding a step shows that step's full existing task detail (routing
  decision, result, diff, live output, MCP calls) by reusing the
  current task-drawer sections rather than copying them. Step actions
  (approve an MCP call, retry) work from there.
- Archive and Swimlanes group a run's steps under its root the same way.

**B1 revision notes (as built).**
- The folding logic is `src/api/public/board-runs.js` (`partitionRunBoard`,
  `runProgress`, `runNeedsYouReason`, `foldsIntoRun`), covered by
  `test/board-runs.test.ts`. `renderKanban` calls `partitionRunBoard`,
  which drops every step card whose root is on the board and then calls
  A2's `partitionBoard`. Two cases keep their own card so nothing goes
  missing: a step whose root was deleted, and a step unarchived by
  itself while its run stays archived.
- Progress is "n/m steps · now: <step>". m is the definition's step
  count (from `GET /pipelines`, cached and refetched when a run names an
  unknown pipeline) or the number of steps seen, whichever is larger. n
  counts steps whose latest card is done. "now" is the latest step that
  hasn't finished. A settled failed run reads "failed at: <step>". A
  step with more than one card in the run gets "(attempt N)". A
  "choose" transition can skip steps, so a done run can end at n < m.
- Needs you shows a run whose root is in a lane but has a step needing a
  human, so that run appears in both places. Its reason names the step
  ("step Notify: MCP approval: slack · send_message (+1 more)"), and
  clicking it opens the run drawer on that step.
- The run drawer is `#runDrawer`. Its first row is the run's own root
  card, which holds the root's actions (Archive, Delete, ...); the other
  rows are the steps in creation order. Expanding a row moves the task
  drawer's `#tdDetail` element (every existing section) into that row
  and fills it through the same functions as the task drawer
  (`loadTaskDetail`, `refreshOpenDrawer`). Only one row is open at a
  time. Rows update by key, so the open row stays in place on SSE
  refreshes and the retry form keeps focus.
- Model, duration and cost come from the new read-only
  `GET /pipeline-runs/:runId` (`src/services/pipeline-run-summary.ts`,
  `test/pipeline-run-summary.test.ts`). A TaskCard has no start time, so
  duration is claude's own `duration_ms` from the step's stored
  stream-json output. The model is claude's init-line model, falling
  back to `resolveModel` against current config, marked "(config)".
  Codex/API steps show "—" for duration. These formats were checked
  against the Agent SDK message types, not observed in a live run.
- With a project selected, a step is scoped by its root's repo: steps
  after a write step run in the previous step's worktree.
- Every way into a run root (board card, Swimlanes/Archive card, the
  Pipelines page's last run) opens the run drawer. "Clear" on Needs you
  or Done deletes a run's step cards along with its root.
- T5, measured by `e2e/pipelines.spec.ts` at 1440x900 against a real
  `POST /pipelines/:id/run`: 1 board card for a run with 2 step cards.

### 4.2 Editor inside the app (card B2)

- The editor opens inside the board shell (the Pipelines nav item stays
  highlighted, same top bar) instead of a separate page. It can stay a
  React/Vite bundle mounted into the shell.
- It uses the board's colour tokens, fonts and light/dark theme.
- "New pipeline" offers "start blank" or "start from" any saved
  pipeline (today: "Review-Handoff Loop", "Full Task Lifecycle").
- Clicking a step opens a side panel with name, agent, transition and
  join mode, instead of the cramped dropdowns inside each node.
- The plain-HTTP rule from memory/lessons.md still applies (`newId()`,
  no secure-context-only APIs).

**B2 revision notes (as built).**
- Routes: `#/pipelines/new` and `#/pipelines/edit/<id>`
  (`BOARD_ROUTES["pipelines/new"]` and `["pipelines/edit/:id"]`, both
  `nav: "pipelines"`, page `#pipelineEditorPage`). A `:name` segment in
  a route key is a param: `parseBoardRoute` returns `params`, and
  `boardRouteHash(route, params)` fills and URI-encodes it.
  `#/pipelines/edit` with no id redirects to `#/pipelines/new`. The old
  page URLs `/pipelines/edit` and `/pipelines/edit/<id>` are now server
  302s to those hashes (`servePipelineEditorAsset`).
- Mounting: the editor stays its own Vite bundle. The build input is
  `pipeline-editor/src/main.tsx` (not index.html, which is now only the
  `bun run dev` harness) with a fixed entry name, `pipeline-editor.js`
  (`PIPELINE_EDITOR_ENTRY` in server.ts; `test/api.test.ts` checks
  vite.config.ts uses the same name), served `cache-control: no-cache`.
  board.html's `showPipelineEditor` imports it on the first editor visit
  and calls its `mountPipelineEditor(el, { route, host, key })` export.
  CSS travels inside the module (`?inline`) and is injected once, every
  rule scoped under `.pe-app`. `dist/` stays gitignored; the README has
  the build step. Unbuilt, the page shows the build command
  (`#pipelineEditorError`) instead of a canvas.
- Each navigation into the editor mounts a fresh one (new `key`), so New
  pipeline always starts at the blank / start-from choice. A first Save
  calls `host.setRoute`, which rewrites the hash with `replaceState`
  (no hashchange), so the canvas isn't reloaded and Back goes to the
  Pipelines page. Unsaved edits are lost on navigating away, as before.
- Run moved out of the editor's own Run box: it calls
  `host.runPipeline(id)`, which opens the "+ New" drawer's Pipeline run
  tab with the pipeline picked (the same path as A4's Run). It refuses
  while there are unsaved changes, since a run uses the saved version.
  The editor's Load dropdown is gone; the Pipelines page's Edit replaces it.
- "Start from" copies the saved pipeline's graph with its step and edge
  ids unchanged (`draftFromPipeline`, `pipeline-editor/src/templates.ts`,
  covered by `test/pipeline-editor-templates.test.ts`). Ids only need to
  be unique within one pipeline, and a "choose" step's handoff `next`
  can name a step id, so new ids could change how the copy routes. The
  copy is named "<name> (copy)" and saves as a new pipeline.
- Theme: the editor's CSS reads the board's tokens directly (`--page`,
  `--surface`, `--ink-*`, `--line`, `--accent`, ...), including React
  Flow's `--xy-*` variables, and passes React Flow a `colorMode` that
  follows `data-theme` / the OS live (`colorModeFor`, `theme.ts`).
- The step side panel (`components/StepPanel.tsx`) always holds a 300px
  column, empty or not, so selecting a step never resizes the canvas
  under a drag. Selection is React Flow's own `selected` flag; a new step
  starts selected. Join mode shows only for a step with two or more
  incoming edges, as the in-node toggle did. Nodes are read-only
  summaries (name, agent, transition, join).
- Targets: B2 moves none of T1–T6. Measured at 1440x900 by
  `e2e/pipeline-editor.spec.ts` screenshots (test-results/
  pipeline-editor-manual/), which need `pipeline-editor/dist` built.

### 4.3 Live run progress on the canvas (card B3)

Opening a run from its detail drawer ("view on canvas") shows the
pipeline graph with each step coloured by its live status, updated over
the existing SSE stream. Clicking a step on the canvas opens the same
step detail as B1.

**B3 revision notes (as built).**
- Route `#/pipelines/run/<runId>` (`BOARD_ROUTES["pipelines/run/:runId"]`,
  `nav: "pipelines"`, section `#runCanvasPage`). The run drawer's "View
  on canvas" (`#rdCanvas`) is a plain link to it and closes the drawer.
  The page has "Run details" (the run drawer, no step expanded) and "All
  pipelines". A reload or a shared URL lands back on the canvas.
- The canvas is vanilla JS and SVG in board.html (`renderRunCanvas`),
  not the editor's React Flow bundle: it is read-only, must redraw on
  every SSE refetch through `render()`, and must work when
  `pipeline-editor/dist` isn't built. Layout is
  `src/api/public/board-run-canvas.js` (`canvasLayers`,
  `runCanvasModel`), covered by `test/board-run-canvas.test.ts`. A saved
  pipeline stores no node positions, so it lays the graph out itself:
  one column per longest-path layer from the entry steps, definition
  order within a column, shorter columns centred. Edges that loop back
  (a reviewer sending work back) are found by DFS and drawn as arcs
  under the nodes; a self-loop is a small arc on the node's right edge.
- A node's colour is the status token of that step's latest card
  (`latestStepCards`, the same rule as B1's step bar), so a retried step
  shows its newest attempt, labelled "(attempt N)". `data-status` is the
  display status (a reviewer's running card is "reviewing");
  `data-task-status` is the card's own status, as `GET /tasks` has it.
  A step the run hasn't reached is "Not started", dashed and disabled.
  An edge is solid once the run has a card at both ends.
- A step card whose step the definition no longer has (edited since the
  run) gets its own dotted node in a last column, so nothing the run did
  goes missing. With the definition deleted, every node is one of those
  and the page says edges can't be shown. A run id not on the board
  says so instead of drawing an empty canvas.
- Clicking a node calls `openRunDrawer(runId, taskId)`: the run drawer
  with that step expanded, the same `#tdDetail` and actions as B1.
- e2e (`e2e/pipelines.spec.ts`, "A run on its pipeline canvas"): a real
  `POST /pipelines/:id/run` fixture's node statuses equal its step cards
  in `GET /tasks`, then follow two real `POST /tasks/:id/move` calls
  over `/events` with no reload. Screenshots at 1440x900 in
  `test-results/pipelines-page/b3-run-canvas*.png`.
- Targets: B3 moves none of T1–T6. It adds a page, not board controls
  or board cards; B1's T5 test in the same spec still measures 1 board
  card per run.

## 5. Testing, for every card

- `bun run typecheck` clean, `bun test test/` 0 failures.
- e2e for every moved or new view. The UI move breaks existing selectors
  in `e2e/board.spec.ts`, `new-task.spec.ts`, `projects.spec.ts`,
  `theme.spec.ts` and `pipeline-editor.spec.ts`. Update them in the same
  card, keeping each test's intent; never delete a test to make it
  pass. These specs make no paid calls (the `WISSEL_*` flags are pinned
  off), so run the touched specs in full.
- Never import `src/api/public/*.js` into e2e (see
  `test/e2e-public-imports.test.ts`).
- Attach a 1440x900 screenshot for each target the card moves, taken
  via the LAN address, with a note of the measured value.

## 6. Non-goals

- A rewrite into one React app (option C, rejected).
- Changing any API or selection logic beyond what B1's grouping and the
  run drawer need. If B1 needs a run-summary endpoint, keep it
  read-only.
- Per-user layout customization.

## 7. Build plan (wissel cards, strictly in order)

Every card edits `board.html`, so each depends on the previous one:
A1 → A2 → A3 → A4 → B1 → B2 → B3.

1. **A1:** shell and navigation, Setup pages (§3.1). Targets T1, T6.
2. **A2:** "Needs you" and four lanes (§3.2). Targets T2, T4.
3. **A3:** "+ New" drawer (§3.3).
4. **A4:** Pipelines page (§3.4). Target T3.
5. **B1:** one card per run, plus the run detail drawer (§4.1). Target T5.
6. **B2:** editor inside the app, templates, step side panel (§4.2).
7. **B3:** live run progress on the canvas (§4.3).
