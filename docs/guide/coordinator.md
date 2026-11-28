# The coordinator

The coordinator is the part of Wissel that runs a piece of team work, not
just single cards. You group cards across one or more projects into a
**workstream**. Wissel then does the coordinating a person would
otherwise do by hand:
- it watches cards and pull requests;
- it decides small things, or asks the right person;
- it posts claims and ready-to-merge lines where the team reads them;
- it moves the ticket, and sends a digest.

It does all of this through one policy gate, so it never does more than
the workstream's rules allow.

## What it does

- **Watches.** Every trigger lands in one inbox: a card reaching review,
  failing or escalating; a PR's checks finishing or the PR going dirty,
  ready or merged; the host running short; a message from you.
- **Decides, inside limits.** Judgment runs as short read-only
  **decision cards** (plan the next cards, pick a default for an open
  question, triage red checks, resolve a conflict, answer the owner's
  comments). A decider only proposes. What happens is one gated action.
- **Gates everything.** Each action goes through the **policy gate**,
  which allows it, asks the decider, asks the owner, queues it for
  quiet hours, or denies it. The first matching rule wins:
  - the hard limits come first, and nothing written to the board can
    lift them;
  - then each project's `never` list, the duties, Shadow, quiet hours
    and `mustAsk`;
  - then the project's **role**;
  - and when nothing else matches, it asks you.

  Every decision is in an append-only log.
- **Acts, and says so.** Allowed actions run: start a card, raise an
  owner task, merge main forward into a PR, post to the workstream's
  **channel** (a Claude Docs doc) or chat, move the ticket. You see it
  all in the **coordinator window**.

## Roles: how much it may do

Each project in a workstream has a role:

| Role | What Wissel does there |
|---|---|
| `shadow` | Records what it would do, and does nothing. |
| `follow` | Works to a decider's answers: a decision becomes a question for the project's `decider`. |
| `decide` | Takes the decisions listed in `decideAlone` itself, as reversible Decisions you can flip; asks for the rest. |
| `decide-over` | Like `decide`, with the widest say. |

Alongside the role, `mustAsk` lists what it must always ask about, and
`never` lists what it must never do. A role changes only through its own
route, by the owner, with a confirm step.

## Using it well

A safe way to adopt it, step by step:

1. **Make a workstream** for one piece of work: `POST /workstreams`
   with its projects (each starting as `shadow`), the ticket, the
   channel doc, quiet hours and a digest schedule. Give each project a
   `decider` (the person to ask).
2. **Turn Shadow on** (`POST /admin/shadow {on: true}`, confirmed) and
   let it run for a day or two beside whoever coordinates today.
   `GET /workstreams/:id/shadow-report` puts what Wissel would have done
   next to what happened. If a team already has a coordinator, import
   its state first (`POST /workstreams/:id/import`, with `dryRun` to
   check).
3. **Hand over one duty at a time:** status, host, landing, review,
   channel-read, claims, ready-to-merge and arming. A duty the external
   coordinator still owns is denied to Wissel, so nothing is done twice.
4. **Widen roles slowly.** Move a project to `follow`, then to `decide`.
   List in `decideAlone` only the decision kinds you're happy for it to
   take alone (`decide-default` first), and keep anything risky in
   `mustAsk`. Use `never` for actions that must not happen in that
   project at all.
5. **Shape the work it starts.**
   - **Project card rules and templates:** every brief carries them.
   - **A review policy:** tiers, the reviewers per tier, and how many
     rounds (see [Review and delivery](review-and-delivery.md)).
   - **`files` on cards:** so overlapping work is flagged.

**Day to day**, open the coordinator window (in the app at
`/app#/coordinator`, or the **Coordinator** button on the board):
- **Conversation:** see what it's doing and send it a message. Hold
  any planned card you don't want started: planned cards wait
  `WISSEL_PLAN_HOLD_MINUTES` (10) before they run.
- **Owner tasks:** work through them; Done runs the task's check.
- **Decisions:** flip any decision you disagree with.
- **Log:** read what the gate allowed and denied, and why.
- **Settings:** change roles, duties and Shadow.

**What to watch:**
- **Owner tasks** are the things only you can do. They block what's
  waiting on them.
- **The gate log's denies:** a repeated deny usually means a rule to
  adjust, not a bug.
- **Lesson proposals** (`GET /lessons/proposals`): approve a project
  lesson to turn it into a card rule.
- **The evals:** run `bun run eval:decision-quality` after changing the
  decider or its prompts. The replay eval compares a recorded day.

**What it won't do:**
- **Hard limits:** it never pushes to main, arms a PR whose checks
  aren't green or whose head isn't the reviewed one, or posts outside
  the workstream's channel and chat.
- **Shared text is data:** nothing in a channel, PR, ticket or card can
  grant an approval or change a role.

## Reference

The rest of this page is the full reference, section by section.

## Workstreams and roles

A workstream is one piece of team work across projects (`POST
/workstreams {name, ticket?, spec?, projects, channel?, chat?,
quietHours?, digests?}`; `GET`, `PATCH` and `DELETE` on
`/workstreams/:id`). A project is in at most one workstream. Each
project in it has:
- a `role`:
  - `shadow`: record only;
  - `follow`: work to a decider's answers;
  - `decide`;
  - `decide-over`;
- an optional `decider`;
- `decideAlone`: the decision kinds it may take by itself;
- `mustAsk`: always asked;
- `never`: actions refused outright.

A role changes only through `POST
/workstreams/:id/projects/:projectId/role {role}`. The first call answers
409 with what would change, and the same call with `"confirm": true`
applies it. Only the owner may make it. Every workstream or role write is
a policy revision.

A card may name its `workstreamId`. Within a workstream a card's `key` is
unique across all its projects. A workstream with open cards can't be
deleted. The policy gate below reads the roles (`src/services/workstreams.ts`,
`docs/SDD-coordinator.md` §3.1, §4.13).

## The inbox

Every coordinator trigger goes through one persisted inbox:
- a card reaching review, failed or escalated;
- a PR's checks finishing, the PR going dirty, ready, merged or closed;
- the host guard holding;
- a message you send with `POST /inbox {text, workstreamId?}`.

Each event has a source-stable id, so seeing it again is a no-op. Its
timestamp is the server's, never one an agent wrote. Payloads from the
code host, a channel or a tracker are marked untrusted. A dispatcher
hands events to a handler per kind, oldest first. One that throws is
retried once and then marked failed. Most kinds are recorded only until
the gate and decision cards take them. `GET /inbox?unhandled=1&
workstream=<id>` and `GET /workstreams/:id/inbox` list them
(`src/services/inbox.ts`, §4.1).

## The policy gate and hard limits

Everything the coordinator does goes through one policy gate
(`src/services/policy-gate.ts`, §4.2). It is a pure function answering
allow, ask the decider, ask the owner, queue or deny, and the first
matching rule wins:
1. a hard limit;
2. the project's `never` list;
3. a duty an external coordinator owns;
4. Shadow (record only);
5. quiet hours, which queue outward actions;
6. `mustAsk`;
7. the role table, with `decideAlone` for decisions;
8. otherwise, ask the owner.

The hard limits are code plus `hard-limits.yaml`, never set from a
channel or a card. They deny:
- production targets you list;
- read-only repos;
- pushing to main or another long-lived branch;
- arming a PR whose base isn't main, or whose checks aren't green;
- posting outside the workstream's channel and chat.

Every decision goes to an append-only gate log (`GET
/workstreams/:id/gate-log`). A property test over random actions checks
that nothing a deny rule matches is ever allowed.

## The executor

The executor does what the gate allows and nothing else (`POST
/workstreams/:id/actions {action}`, `src/services/executor.ts`, §4.3):
- **Allowed:** a performer for the kind runs it: card start, owner
  task, restart when idle, merge-forward, a decision, a channel post, a
  chat post, and the ticket's transition and comment (these two write
  only with the tracker's `writeBack` on). A kind with no performer
  answers `unsupported`.
- **Shadow:** recorded only.
- **Ask:** raises an owner task naming who should decide.
- **Deny:** says which rule refused it.
- **Queue (quiet hours):** the action waits in a persisted outbound
  queue (`GET /workstreams/:id/outbound`), with its flush time. Each
  minute the queue is decided again, oldest first, so a rule changed
  overnight still applies. A queued push goes through the merge path
  and its gates again.

## Decision cards

Judgment runs as short decision cards (`src/services/decisions.ts`,
§4.4). A card labelled `decision` goes to the read-only `decider` agent.
Its brief fences the context as untrusted data, and its answer must end
with a ` ```decision ` block that fits its kind's schema. The decider
only proposes; the answer is one gated action, so the role decides what
happens. The kinds:
- **`plan-batch`:** proposes cards, each started as its own gated card.
  Plans start unless held: each card waits `WISSEL_PLAN_HOLD_MINUTES`
  (default 10; 0 starts at once) before it runs. The coordinator window
  lists them with Hold. Hold (`POST /tasks/:id/hold`) keeps a card that
  hasn't started from starting; Release (`POST /tasks/:id/release`) lets
  it start on the next sweep. `GET /workstreams/:id/plans` lists the
  workstream's cards that haven't started.
- **`decide-default`:** a default with its alternative and lean, kept
  as a Decision you can flip (`GET /workstreams/:id/decisions`, `POST
  /decisions/:id/flip`).
- **`triage-red`:** `retry` (deliver again), `fix-round` (back with the
  reason) or `spec-question` (an owner task).
- **`resolve-conflict`:** starts by itself when merge-forward's conflict
  integrator gives up (its card failed or escalated, or the card went
  past the integrator cap), one at a time per card. The answer is:
  - `card`, with how to resolve each file: a fix round on the same
    branch, reviewed and delivered again;
  - or `ask`: an owner task with the question.
- **`read-owner-comments`:** the owner's comments. A workstream's
  `reviewDoc` (`{"adapter": "claude-docs", "target": "<doc link>"}`) is
  read once a day, checked hourly (`WISSEL_OWNER_COMMENTS=0` turns that
  off). The reader is a read-only scribe: `claude -p` allowed only the
  Claude Docs read and query tools. New comments since the last read
  (the cursor is kept) start one decision.
  - Each answer is posted to the workstream's channel as a gated
    `answer` line.
  - Each follow-up starts as a card, unless held, like a plan.
  - `POST /workstreams/:id/owner-comments/read` reads now.
  - `POST /workstreams/:id/decisions/start` starts the decision with
    comments you give it.

A `follow` project turns the same answer into a question for its decider.
A workstream card whose PR checks go red starts a `triage-red` on its
own. `POST /workstreams/:id/decisions/start {kind, context, projectId?,
subjectId?}` starts one by hand.

## The decisions channel

A workstream's channel is where its decisions show up for people
(`src/services/channel.ts`, §4.9). Wissel stays authoritative: an
allowed `channel.post` adds a message to Wissel's channel outbox, and the
workstream's adapter copies the batch out once per interval. Message
kinds: claim, release, ready-to-merge (with the full head sha), question
(options and a lean), answer, decision, status and handover.

The first adapter is `claude-docs`, with the workstream's `channel`
being `{adapter: "claude-docs", target: <doc link>}`. Its scribe is one
short `claude -p` run per batch on the first enabled claude-cli account,
allowed only the Claude Docs tools. It appends the lines to the doc and
returns the block id of each, which Wissel records. An empty outbox
starts no run, a failed run leaves the batch pending, and a line the
scribe didn't confirm is marked failed. `GET /workstreams/:id/channel`
shows the outbox, and `POST .../channel/flush` posts now. Reading the
channel back is off unless `WISSEL_CHANNEL_READ_MS` is set.

## The ticket and chat

A workstream's `ticket` follows its cards (`src/services/tracker-rules.ts`,
§4.10). Its decision, review and merge-forward cards don't count. The
ticket moves forward only, once per stage:
- "in progress" when its first card starts;
- "in review" once every card is an open PR;
- "done" once all are merged.

Each move is a gated `ticket.transition` plus one `ticket.comment` naming
the merged PRs. Both write only when the tracker's `writeBack` is on. It
stays off for now, so a move is decided and logged but nothing is
written. With a tracker set up, a workstream needs its ticket before its
first card.

Chat is a Slack adapter for `chat.post`, which posts only to the
workstream's `chat` channel. Set it up in `integrations.yaml`:

```yaml
chat:
  kind: slack
  tokenEnv: TEAM_SLACK_BOT   # the variable's NAME; the token is never stored
```

## Digests

A workstream's `digests` (cron and timezone) send a fixed digest built
from Wissel's own numbers, with no model call:
- live cards against the cap;
- PRs by state;
- what waits on the decider;
- open owner tasks;
- what quiet hours are holding;
- host load, memory and disk.

It goes through the gate to the workstream's chat, else as a status line
on its channel, so quiet hours queue it. A restart never sends a backlog.
`GET /workstreams/:id/digest` previews it, and `POST` sends it now
(`src/services/digests.ts`, §4.11).

## Duties, Shadow and import

While a team moves from an external coordinator to Wissel, each duty
switches over on its own (`src/services/duties.ts`, §4.13). The duties
are status, host, landing, review, channel-read, claims, ready-to-merge
and arming. A duty the external coordinator still owns is denied by the
gate, so nothing is done twice. `GET /workstreams/:id/duties` lists
them, and `POST /workstreams/:id/duties/:duty {owner: "external" |
"wissel"}` switches one.

**Shadow** (`POST /admin/shadow {on}`) runs the whole coordinator
record-only. The gate allows in shadow mode and nothing acts. `GET
/workstreams/:id/shadow-report` sets what Wissel would have done beside
what actually happened: channel entries, PRs opened, armed and merged.

Both switches are owner only, take a confirm step (the first call
answers 409 with what would change, `"confirm": true` applies it), and
each is a policy revision.

A team that already has a coordinator imports its state with `POST
/workstreams/:id/import` (owner only, a policy change;
`src/services/import.ts`, §7). Import creates nothing:
- `items`, as JSONL or a list of `{key, cardId?, pr?, sha?, round?}`,
  match cards already on the board, by id or by key in the workstream.
  A match gets its key, workstream, round and PR (which needs the full
  head `sha`). A different existing key or PR, or a key another card
  already uses, is reported as a conflict and left alone.
- `rules {projectId, cardRules?, cardTemplates?}` become that project's
  settings.
- `channelCursor` is where channel reading starts.
- `schedule {digests?, quietHours?}` goes onto the workstream.

`"dryRun": true` reports all of it and changes nothing. Then: Shadow for
a day or two, and hand over one duty at a time.

## Lesson scopes

Each curated lesson in `memory/lessons.md` gets a scope, the first line
under its `##` heading (`src/services/lessons.ts`, §4.15):
- **`Scope: wissel`:** a problem with Wissel's own environment.
  Approving it raises an owner task to file it as an issue. It never
  becomes a prompt line.
- **`Scope: project`:** a standing rule. Approving it with a `projectId`
  appends it to that project's `cardRules`, and nothing is applied
  without that approval.
- **`Scope: path:<glob>`:** code knowledge for an area. It matches a
  card through the card's planned `files` (`GET /tasks/:id/lessons`).

`GET /lessons` lists the lessons, `GET /lessons/proposals` the owner's
proposals, and `POST /lessons/:key/approve` or `.../reject` decides one
(owner only). Prompt injection stays as `WISSEL_MEMORY_INJECTION` says:
scoped lessons aren't injected yet.

## Claims, ready-to-merge and the evals

On its own, through the gate, Wissel posts a **claim** to a workstream's
channel when one of its cards starts, and a **ready-to-merge** (with the
full head) when its PR becomes ready. In Shadow those are would-records,
and the **replay eval** (`bun run eval:replay [day.jsonl
coordinator.json]`, `src/services/replay.ts`, §8) measures them. It runs
a recorded day (cards, moves, PR states, channel entries) through an
in-memory Wissel in Shadow. It then compares the would-records with what
the team's coordinator did: ready-to-merge agreement (target 95%),
claims, and would-be hard-limit violations (target zero). The bundled
day is an invented example; a team's own recording uses the same
shapes.

The **decision-quality eval** (`bun run eval:decision-quality`, §8) has
the real `decider` answer 10 fixed, invented cases: red gates,
conflicts, open questions, a plan and owner comments. It judges schema
validity and agreement with each case's known good answer in code, and
passes at 9 of 10 valid and 8 of 10 agreeing. Each run's scores are kept
in `eval/history/decision-quality.jsonl`, so they can be compared over
time. It makes real model calls (see `eval/README.md`).

## The coordinator window

The **coordinator window** is in the app at `/app#/coordinator`, and on
desktop through the rail's Coordinator link (§4.14). On the classic
board, the top bar's **Coordinator** button docks the same window on the
right: beside the board on a wide screen, over it on a narrow one. It is
the app's window in embed mode (`/app?embed=1`, with no rail or tab bar).
The dock remembers whether it is open and which window it showed. It lists the
workstreams, and each one's window (`#/coordinator/<id>`) has a header:
each project's role and decider, Shadow, the channel, chat and quiet
hours. It then has four tabs:
- **Conversation:** planned cards that haven't started, each with Hold
  or Release; what reached the inbox; your messages (Send); and open
  owner tasks with their steps as tick-boxes and a Done that runs the
  task's check.
- **Decisions:** each decision with Flip.
- **Log:** the channel outbox and the gate's decisions.
- **Settings:** each project's role, each duty's owner, and Shadow. A
  change shows the server's own confirm text first, and only Confirm
  applies it.

---

[Back to the README](../../README.md)
