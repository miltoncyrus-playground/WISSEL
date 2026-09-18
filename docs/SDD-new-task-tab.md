# SDD — New Task tab for wissel's board UI

Status: **built**. Approved with: §8 resolved as **Option A** (single
submit button, no orchestrator/backend behavior change), and Playwright
smoke-test infra (§7) added rather than manual-curl-only verification.

## 1. Goal

Give wissel's board a "New Task" tab that plays the same role agetor's
`NewTaskForm` plays there: the one place a human creates a task, with
enough visible state to trust what's about to happen before they commit.

wissel is not agetor, and this is not a port. agetor's form exists to let
a human directly configure *how a task runs* (harness, mode, model,
worktree, branch) because agetor has no router — the human is the router.
wissel's whole premise is the opposite: the router decides, and the
decision is always visible and overridable. So the New Task tab's job is
narrower and different in kind: collect what a task needs to be routable
(title, description, labels, repo), show what the router *would* do with
it live as the human types, and let them override only when they
actually want to skip the router — not make them configure execution
details wissel doesn't have a slot for (no per-task model/effort/mode,
no worktree/branch — those live on the write-tier executor side, outside
wissel entirely, per the router/execution boundary already established
in `docs/HANDOVER-2026-09-17.md`).

## 2. What I looked at

Read `src/mainview/components/kanban/NewTaskForm.tsx`,
`CreateTaskFromIssueDialog.tsx`, `SlashAutocomplete.tsx`,
`ExtensionPicker.tsx`, `worktree-payload.ts`, `branch-field.ts`,
`api.ts`'s `createTask`, `model-options.ts`, and the server-side
`createTask()` in agetor's `src/bun/orchestrator.ts` (agetor cloned
read-only for this). Full findings below inform the field-by-field
mapping in §4; I'm not reproducing the whole research report here.

## 3. Constraints carried over from wissel's existing architecture

- **No new frontend framework.** `board.html` is a single static page,
  vanilla JS, no build step. The New Task tab is a third view alongside
  the existing "Dependency arcs" / "Kanban" toggle (`.segmented` button
  group), not a new app.
- **No duplicate routing logic in the browser.** The live preview calls
  a real server endpoint that runs the actual `Router`/`RuleStrategy`,
  the same objects the orchestrator uses. JS never re-implements
  tag-overlap scoring.
- **TaskCard's shape doesn't change.** `{title, body, labels, repo,
  dependsOn?}` is what `POST /tasks` already accepts — the form fills
  exactly that, nothing more, unless §6's open question is resolved to
  add a field.

## 4. Field-by-field: agetor → wissel

| agetor field | wissel equivalent | Notes |
|---|---|---|
| Title | **Title** (text, required) | Same role, same validation (non-empty after trim). |
| Prompt (textarea, `/` + `@` autocomplete) | **Description** (`body`, textarea, required) | No slash-command autocomplete — wissel has no in-prompt command/skill-invocation system. See labels autocomplete below for the actual analogue. |
| Project/workdir picker | **Repo** (text input, required, with a `<datalist>` of repos seen on existing tasks) | wissel has no registered-projects concept. Free text is what the data model already supports; the datalist is a zero-backend convenience, not a real picker. A real picker is a v2 idea (§7). |
| Branch / isolate / worktree options | *(none)* | Out of scope entirely — worktree/branch belong to whatever executes write-tier work (agetor), not to wissel. wissel's `TaskCard` has no such fields. |
| Harness (agent) button grid | **Advanced: override agent** (collapsed by default; "Auto-route" vs a button grid of `GET /agents` entries) | Inverted from agetor: picking an agent directly *skips* the router rather than *being* the router. Wired through existing endpoints — see §5. |
| Mode (Code/Plan pills) | *(none — subsumed by tier)* | wissel's readonly/write split already is the closest wissel has to Plan/Code, and it's a property of the *agent*, not something the task submitter chooses per task. |
| Model / Effort | *(none)* | Not part of `TaskCard` or the per-task contract; model lives on `AgentDef.costProfile`, chosen by the agent definition, not the submitter. |
| Fast / Max Mode (cursor-only) | *(none)* | No cursor-equivalent concept in wissel. |
| References (`@file` attachments) | *(none for v1)* | No file-attachment plumbing in `TaskCard`/executors today. Noted as a v2 idea only if a real need shows up. |
| Task Type (Task/Bug/Spike buttons) | *(none — expressed as a label)* | wissel's tag system already subsumes this: tagging a task `bug` does everything a dedicated Task Type field would, and it participates in routing, which a separate field wouldn't. No new field. |
| *(agetor has no equivalent)* | **Depends on** (multi-select of open tasks) | wissel already has `dependsOn` + `POST /tasks/:id/depends-on`; agetor's dependency model is pipeline-internal and not user-facing the same way. |
| *(agetor has no equivalent — it has no router)* | **Live routing preview** | wissel's actual differentiator. See §5. |
| "To backlog" / "Run task" (two submit buttons) | **Open question — see §6** | wissel's `inbox` status isn't a held state the way agetor's `backlog` column is; the orchestrator sweeps `inbox` and `ready` identically. Mirroring agetor's two-button split needs a small orchestrator change, not just UI. Decision needed before I build this part. |

### Slash-autocomplete / extension picker → labels autocomplete

agetor's `/`-autocomplete and its "MCP · Skills · Plugins · Prompts"
picker both solve "let the user discover what's invokable." wissel's
actual analogue is simpler and already backend-driven: the **Labels**
field is a chip input with a suggestion dropdown sourced from
`GET /agents`' tags (the union of every agent and skill's `tags`).
Typing filters the list; picking a suggestion adds a chip. This is the
one piece of agetor's UX I'm porting near-verbatim, because it solves
the identical problem ("show me what this system already knows about")
with data wissel already exposes.

## 5. Live routing preview (the core new capability)

**New endpoint**: `POST /route/preview`
```
Request:  { labels: string[] }
Response: RoutingDecision   // same shape GET /tasks/:id/decision returns,
                            // taskId is a constant placeholder ("preview")
```
Implementation: the server already builds one `Router` per process when
the orchestrator is enabled; I'll construct it unconditionally (cheap,
stateless) so `/route/preview` works whether or not
`WISSEL_ORCHESTRATOR=1` is set. The handler builds an in-memory
`TaskCard`-shaped object from the request (`{id: "preview", labels,
status: "inbox", ...}`) and calls `router.route()` on it — the exact
code path the orchestrator uses, never touched or duplicated in JS.

**UI**: debounced (~250ms) call on every Labels change, rendered with
the *same* candidate-table markup already built for the click-to-inspect
decision panel in `board.html` (I'll factor that rendering into one
shared function instead of writing it twice). Shows either "Would route
to `<agent>` — `<reason>`" or "Would NOT route — `<reason>`" plus the
full ranked candidate list, live, before the task even exists. This is
strictly more transparent than agetor's form, which has no equivalent
concept because agetor has no router to preview.

## 6. Manual override wiring (uses only existing endpoints)

"Advanced: override agent" is collapsed by default (Auto-route). If the
submitter expands it and picks a specific agent:

1. `POST /tasks` (unchanged) — creates the task.
2. `POST /tasks/:id/decision` with `{selected: <picked>, confident: true,
   strategy: "manual", reason: "manual override", matchedTags: labels,
   candidates: <whatever the last preview returned>}` — the
   `RoutingDecision.strategy` union already has `"manual"` as a member;
   this is exactly what it's for.
3. If the picked agent differs from what the live preview's top
   candidate was, also `POST /tasks/:id/override` with
   `{routerPick: <preview top>, humanPick: <picked>}` — feeding the
   existing "overrides are training data" mechanism for free.

No new backend surface for override handling — everything here already
exists and is tested.

## 7. Non-goals for this pass

- Model/effort/mode selection — not part of wissel's per-task contract.
- A real project/workdir registry — free text + datalist only.
- File attachments / references.
- "Create from issue" or any external-source pre-seeding — noted as a
  pattern worth remembering (pre-seed fields + dirty-tracking so a
  re-fetch doesn't clobber edits) if wissel ever grows an issue
  integration, not built now.
- Automated browser/e2e tests — wissel has no Playwright/e2e harness
  today (agetor does). I'll smoke-test manually via curl + a live
  server, same as the last two features. Say so in your approval if you
  want a couple of Playwright smoke tests added as part of this work —
  Chromium is available in this environment, it'd just be new
  infrastructure for the repo.

## 8. Open question requiring your call

**"To backlog" vs "Run task" — does wissel need a real held state?**

agetor's two submit buttons work because agetor has a true `backlog`
column the scheduler never touches until a human clicks Start. wissel's
`inbox` isn't that — `Orchestrator.sweep()` treats `inbox` and `ready`
identically, so with the orchestrator on, every created task is picked
up immediately regardless of which button you'd click.

Three ways to resolve this:

**A — Single "Create task" button (recommended default).** Every task
created via the form is immediately eligible, matching wissel's current
semantics exactly. Simplest, zero backend changes, and arguably correct:
wissel's whole model is "things get routed automatically," so a manual
hold state is arguably an agetor-shaped idea being ported without a
wissel-shaped reason. If you want manual control over *when* something
runs, that's what leaving the orchestrator off (`WISSEL_ORCHESTRATOR`
unset) already gives you globally.

**B — Add a real `backlog` status.** `TaskCard.status` gains `"backlog"`,
`Orchestrator.sweep()` only sweeps `"ready"` (not `"inbox"`), and
`"inbox"` becomes the true held state — "To backlog" leaves it in
`inbox`, "Run task" moves it straight to `"ready"`. Closer parity with
agetor, but it's a behavior change to the orchestrator and every
existing task/test that currently relies on `inbox` being swept.

**C — No backend change, just a UI convenience.** Single submit button,
but an optional "and route it now" checkbox that, when checked, follows
create with `POST /tasks/:id/move {status: "ready"}` (a no-op state
transition today, since both are already swept — this would only start
doing something once the orchestrator poll/event timing matters, e.g. if
sweeps become debounced later). Cosmetic today, forward-compatible.

I'd build **A**, and mention **C** as a one-line addition if you want the
button to feel closer to agetor's without touching the orchestrator. Say
the word if you actually want **B** — it's a real, if small, behavior
change and I don't want to make it without you deciding on purpose.

## 9. Implementation plan (once approved)

**Backend** (`src/api/server.ts`):
- Instantiate `Router` unconditionally; add `POST /route/preview`.

**Frontend** (`src/api/public/board.html`):
- New `.segmented` tab: "New task", alongside Arcs/Kanban.
- New panel: Title, Description, Repo (+ datalist), Labels (chip input +
  tag-suggestion dropdown sourced from `/agents`), Depends on
  (multi-select from `GET /tasks`, excluding done/failed), live routing
  preview (debounced `/route/preview` call, shared render function with
  the existing decision panel), collapsed "Advanced: override agent"
  section, one "Create task" button.
- Submit flow: `POST /tasks` → conditionally `POST /tasks/:id/decision`
  + `POST /tasks/:id/override` per §6 → refetch → clear Title/
  Description/Labels/Depends-on/override pick, **keep Repo sticky**
  (agetor's exact "keep the field you're least likely to want to
  retype" pattern, applied to wissel's one location field).

**Tests**:
- `test/api.test.ts`: `/route/preview` — confident match, zero-overlap,
  tie, empty labels.
- Manual smoke test via a live server + curl (same method used for the
  last two features), since there's no browser test harness.

## 10. What I need from you

1. Approve or redirect the overall shape (§4's field mapping, §5's
   preview endpoint, §6's override wiring).
2. Pick A, B, or C for §8.
3. Say if you want the Playwright smoke-test infra added (§7) or if
   manual curl verification is enough, same as before.
