# SDD — Git state and tickets on the board

Status: **Partly built.** Built: the git overview, ticket-key detection,
`GET /projects/:id/git`, `GET /work`, the Tickets page, ticket chips, the
Projects section in the app, the Jira provider (read), and confirmed
write-back (comment, move). Not built: GitHub pull-request and CI status,
automatic write-back on card events, a Jira inbox that creates cards.
Setup for a user is in the README under "Git and tickets".

## 1. The problem

A card knows its `repo`, its `mergeTarget` and its worktree. The board
showed nothing about the repo itself (which branch is checked out, whether
it is dirty, which branches exist) and nothing about the ticket the work
belongs to. With several repos and several tickets in flight at once, the
operator kept the mapping from ticket to branch to card in their head, and
copied a ticket key into each card title by hand.

## 2. Design

### 2.1 Deterministic, read-only git

`src/services/project-git.ts` runs fixed-argv `git` on the project's own
checkout (`task.repo`, never a worktree, the rule of
`docs/SDD-project-settings.md`): `rev-parse` and `status` for the
checkout (reusing `project-status.ts`), `for-each-ref` for branches and
`worktree list --porcelain` for worktrees. No shell string, no network,
no `git fetch`, no LLM. Everything is as of the repo's last fetch, and the
UI says so.

Local and remote branches of the same name merge into one entry. The
remote's `HEAD` pointer and a merge queue's scratch branches
(`gh-readonly-queue/...`) are not work and are dropped. At most 200
branches, newest first.

### 2.2 Ticket keys

`src/services/ticket-refs.ts`. A project may set `ticketPatterns` (at most
5 regular expression sources, 80 characters each) and `referencePatterns`
for ids that are not tickets. With no `ticketPatterns` the default matches
any `PROJ-123`. The first match wins, tried in this order for a branch
(its name, then its tip commit's subject) and for a card (its title, then
its `mergeTarget`). A pattern that does not compile finds nothing and is
never thrown on. A pattern with a repeated group inside a repeat
(`(a+)+`), which can backtrack without end, is refused when saved.

The app has a small copy of the matching rule (`app/src/ticket.ts`) and
the board another (`board-work.js`), so a card row can show its chip
without a request. The server's grouping is the one that counts.

### 2.3 Grouping

A ticket group lists the branches, worktrees and cards that name it.
Work that names no ticket is grouped last. A worktree is matched to its
card by `taskWorktreePath`. Archived cards are left out. Groups with live
cards sort first, then by key, numerically.

`GET /work` runs the overview for every project and merges the groups by
ticket, so one ticket that spans several repos shows once. A project whose
folder cannot be read is reported with its error and the rest still
answer.

### 2.4 "Needs a look"

A checkout needs a look for any of: changed files, a detached head, a
branch other than `main` or `master`, or commits behind its upstream. A
feature branch is normal while a spec is being written, so the reason is
named ("on spec/ABC-1-x"), not called wrong.

### 2.5 Ticket providers

`src/services/ticket-provider.ts` is the interface: `lookup(keys)`,
`transitions(key)`, `comment(key, text)`, `transition(key, id)`, plus
`writeBack`. Jira Cloud is the one implementation
(`src/services/jira-provider.ts`); another tracker would add a file and a
`kind`.

- **Config.** `integrations.yaml` (git-ignored; `integrations.example.yaml`
  is checked in) names the site, the *names* of the environment variables
  holding the email and API token, an optional `projectKeys` filter and
  `writeBack`. The same convention as `harnesses.yaml`: a pointer to a
  credential, never the credential. `site` must be https (http only for
  localhost) and carry no embedded credentials.
- **Auth.** Basic auth with email and API token over Jira's REST API v3.
  A Claude connector's OAuth login belongs to a Claude session and a
  headless server cannot use it, so a token is the supported route.
- **Reads.** One JQL search (`key in (...)`) per 50 keys. Only keys that
  match `^[A-Z][A-Z0-9_]*-\d{1,9}$` are ever sent, so a key cannot break
  out of the query or the URL; with `projectKeys` set, others are
  dropped. Results are cached for 60 s; a write drops that ticket's entry.
- **Failure.** Jira being unreachable or refusing the credentials is
  reported in the `GET /tickets` answer (`error`), never as a server
  error, so the page and its git view still render. Error text never
  carries the token.
- **Not set up.** A missing file, a bad entry or an unset variable is a
  `reason` on `GET /tickets`, logged at startup (`tickets: off (...)`),
  and not a startup failure.

### 2.6 Write-back

Off unless `writeBack: true`. When on, the Tickets page offers **Comment**
and **Move…** per ticket, and each action is one explicit, confirmed step:

1. The page shows the exact action (the comment text, or the target
   status) in a confirm dialog.
2. The request carries `confirm: true`; the server answers 400 without it.
3. The provider re-checks `writeBack`, the key and the project filter.
   A comment is at most 10,000 characters and is sent as one paragraph per
   line (Atlassian Document Format); a transition id is digits only.
4. The page re-reads the tickets afterwards.

With `writeBack` off the write routes answer 403 and the provider refuses
as well, so the flag holds even if a route is reached another way. Every
write is logged (`tickets: comment on ABC-1`).

Ticket text is shown as data. It is not placed in any agent's prompt.

## 3. The surface

| | |
|---|---|
| `GET /projects/:id/git` | status, branches, worktrees, ticket groups |
| `GET /work` | all projects merged by ticket, plus per-project attention |
| `GET /tickets?keys=` | tracker details, `writeBack`, or why there is none |
| `GET /tickets/:key/transitions` | allowed moves (write-back only) |
| `POST /tickets/:key/comment` | `{confirm, text}` |
| `POST /tickets/:key/transition` | `{confirm, transitionId}` |

Board: a **Tickets** page (`#/tickets`), a ticket chip on every card and
Ticket and Branch in the card drawer, and the ticket list under a
project's status line in Setup > Projects. App: a Projects section on the
Board tab and the chip on card rows.

## 4. Decisions worth keeping

- **No fetch.** Reading is cheap and safe; fetching touches the network and
  changes refs. The operator fetches in their own way.
- **A token, not a connector.** The only way a server with no login
  session can authenticate. The cost is one setup step.
- **No polling.** The page reads on open and on Refresh. `/work` runs a few
  git commands per project.
- **Confirmation lives in two places.** The page asks the person; the
  server requires `confirm: true`. Neither alone is the safeguard.
- **Defaults are inert.** No config means no network calls and no writes.

## 5. Not built, in the order I would build it

1. GitHub pull-request and CI state per branch through `gh`, with a
   per-project account (applied per call through `GH_TOKEN`, never by
   switching the global login), and org and repo parsed from the remote URL
   in all its forms (HTTPS, SSH, SSH host aliases). The default branch for
   "needs a look" should come from `origin/HEAD` instead of `main`/`master`.
2. Write-back on card events (comment the branch or PR when a card lands),
   as an opt-in per project, still confirmed or clearly logged.
3. A Jira inbox (a saved JQL) with "create card from ticket", which also
   names the card's `mergeTarget` after the key.

## 6. Tests

`test/ticket-refs.test.ts`, `test/project-git.test.ts` (real throwaway git
repos, branches shaped like `feat/ABC-12-x`), `test/jira-provider.test.ts`
(a fake `fetch`: URLs, auth header, JQL, chunking, injection attempts,
error mapping, the token never in a message, the lookup cache),
`test/integrations.test.ts`, `test/board-work.test.ts` and the API tests in
`test/api.test.ts` (a fake provider: write-back off and on, `confirm`
required, a tracker that is down). `app/test/ticket.test.tsx` covers the
app's side.
