# Git and tickets

Wissel can show where each registered repo stands and which ticket every
branch and card belongs to. It works on git alone; connecting a Jira Cloud
site adds each ticket's title and status, and lets you comment on or move
a ticket from the board. Design: `docs/SDD-git-jira-visibility.md`.

## 1. Register your repos

Setup > Projects > add a local folder, or clone from GitHub. Cards that
name a repo (`repo` on the card) are matched to the project registered at
that path.

## 2. Say what a ticket key looks like

With nothing set, any `PROJ-123`-shaped key counts. To narrow it, or to
match your own shape, set the patterns per project (regular expressions,
at most 5 each, matched anywhere in a card title or branch name; the
first match wins):

```bash
curl -X POST localhost:8787/projects/<project-id>/settings \
  -H 'content-type: application/json' \
  -d '{"ticketPatterns": ["ABC-\\d+"], "referencePatterns": ["DEC-\\d+"]}'
```

`referencePatterns` finds ids that are not tickets (a decision or spec
number). They show next to a branch as plain labels and never link
anywhere. Send `null` to clear either. Find a project's id with
`curl localhost:8787/projects`. Branch names like `feat/ABC-12-login`
and commit subjects ending `(ABC-12)` need no setup beyond this.

## 3. See it

- **Board > Tickets** (`#/tickets`): a **Checkouts** block with one line
  per repo (branch, clean or changed files, ahead/behind), then one
  section per ticket across all repos with its cards, branches and
  worktrees. Filter by project, or tick **Needs a look** for checkouts
  with changed files, a detached head, a branch other than `main` or
  `master`, or commits behind. Click a card to open it. **Refresh**
  re-reads git; the page never polls.
- **Cards** show a ticket chip, and the card drawer shows Ticket and
  Branch.
- **Setup > Projects**, with a project selected, lists its tickets under
  the status line.
- **The app** (`/app`) Board tab has a Projects section: open a project
  for the same grouping.

Git state is as of each repo's last fetch. Wissel only reads git here: it
never fetches, checks out or pushes.

## 4. Connect Jira (optional)

Wissel talks to Jira Cloud over its REST API with an email and an API
token. (The Claude connector you may use in a Claude session is tied to
that session and cannot be used by the board's server.)

1. Create an API token at
   <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Copy the example config and edit it:

   ```bash
   cp integrations.example.yaml integrations.yaml   # git-ignored
   ```

   ```yaml
   integrations:
     - id: jira
       kind: jira
       site: https://your-team.atlassian.net   # https only
       emailEnv: JIRA_EMAIL                     # NAMES of env vars,
       tokenEnv: JIRA_API_TOKEN                 # never the values
       projectKeys: [ABC]                       # optional filter
       writeBack: false                         # see below
   ```

3. Put the two variables in the environment the server starts in, then
   restart it:

   ```bash
   export JIRA_EMAIL=you@example.com JIRA_API_TOKEN=...
   bun run serve
   ```

   Under systemd, use `EnvironmentFile=` in the unit (a file only you can
   read), not `Environment=` with the token in it.

Startup logs `tickets: jira (write-back off)`, or `tickets: off (<why>)`
(file missing, a variable unset, a bad `site`). The board keeps working
either way, and the Tickets page prints the reason.

Each ticket section then shows its title (linked to Jira), status and
assignee. Lookups are one JQL search per 50 keys and cached for a minute;
if Jira is down the page says so and the git view stays.

## 5. Write back (optional)

Set `writeBack: true` and restart. Each ticket section gains **Comment**
and **Move…**. Nothing is automatic: each action shows exactly what it
will do and waits for your OK, and the server refuses a write that does
not carry `confirm: true`.

- **Comment** adds a comment as the token's account.
- **Move…** lists the moves Jira allows for that ticket right now and
  applies the one you pick.

Leave `writeBack` off and the integration cannot change anything: the
write endpoints answer 403. Use an API token from an account that only
has the access you want wissel to have.

## API

| Endpoint | What it returns |
|---|---|
| `GET /projects/:id/git` | One repo: checkout state, branches, worktrees, and cards grouped by ticket. |
| `GET /work` | Every project's `/git` merged by ticket, plus per-project "needs a look" reasons. A repo that cannot be read is reported, not fatal. |
| `GET /github` | Pull requests (state, review, mergeable) and CI checks per project and branch, read with `gh`. A project `gh` cannot read is reported, not fatal. |
| `GET /ci` | Workflow runs per project on any branch (running, queued, failed, passed), read with `gh run list`. The CI tab shows what is running or queued and failures from the last day, with each run's jobs and the card and ticket it belongs to. |
| `GET /tickets/mine` | Open tickets assigned to the tracker account (Jira: `assignee = currentUser()`, limited to `projectKeys`), newest update first, at most 50. Drives the board's "Assigned to me" column. |
| `GET /tickets?keys=ABC-1,ABC-2` | Tracker details per key, or `{configured:false, reason}`. |
| `GET /tickets/:key/transitions` | The moves Jira allows now. Needs `writeBack`. |
| `POST /tickets/:key/comment` | `{confirm:true, text}`. Needs `writeBack`. |
| `POST /tickets/:key/transition` | `{confirm:true, transitionId}`. Needs `writeBack`. |

Ticket text from Jira is shown as data; it is never passed to an agent as
an instruction.

---

[Back to the README](../../README.md)
