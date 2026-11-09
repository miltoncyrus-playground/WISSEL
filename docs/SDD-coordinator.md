# SDD: Wissel as a team's coordinator

Workstreams, roles per project, a policy gate, and one coordinator window.

Status: draft, for review by the owner before any card starts. To be built
on a separate Wissel instance (§12), not on a Wissel that coordinates live
work. Companion pages: the design write-up "Wissel Coordinator Model" and
the canvas "Board coordinator window" (mock-ups of §4.14).

## 1. Why, and the outcome

A coordinator turns a goal into a stream of agent work: it picks what to
start, briefs each agent, lands and checks the results, gets them reviewed,
and reports to whoever decides. Today Wissel only runs the agents. In a
pilot, a long-running Claude Code session did the coordinating around
Wissel by hand, with 17 shell and Python scripts and an append-only log
file. In about 24 hours it:

- created 284 cards through `POST /tasks` (138 of them review cards) for
  about 100 pull requests;
- appended the same standing rules to every brief (`rules.md`) and built
  every fix round from a review by hand, once with an empty brief;
- copied each finished card's diff onto a real branch, merged main, ran
  the gates the card sandbox cannot (end-to-end tests), pushed, opened the
  PR and started an other-model review card (`land-new.sh`, `land-fix.sh`);
- parsed `VERDICT: PASS|FAIL n HIGH / n MED / n LOW` out of each review,
  enforced a two-round cap, and posted "ready to merge" to a decider on a
  shared board;
- checked the board every 10 minutes (72 of 105 checks found nothing new)
  and once missed three of the decider's entries;
- timed 7 Wissel restarts by hand around running cards;
- was blocked for about 1.5 hours when parallel test suites filled `/tmp`;
- queued pushes during quiet hours in three text files and flushed them
  each morning.

All of that is mechanical except the judgment calls in between. It should
live in Wissel, configured per team, so any team can run a workstream
without writing its own coordinator.

**Outcome:** a team registers its projects, writes its rules, sets a role
per project and talks to one coordinator window per workstream. Wissel
runs the loop. People keep the policy and the decisions the policy
reserves for them. No coordinator scripts remain.

**How we see it:**

1. Shadow acceptance (§7): on a replayed day of events from the pilot,
   Wissel's would-be "ready to merge" lists match the recorded ones on at
   least 95% of PRs, and every mismatch has a logged reason.
2. Policy acceptance: the policy-gate audit log (§4.2) shows zero executed
   actions that a deny rule matches, across the whole test suite and the
   replay.
3. Live acceptance: one workstream runs for a week after cut-over with no
   coordinator script, no hand-timed restart, and every outgoing action
   paired with a channel entry.

## 2. Scope

In:

- **A. Workstreams and roles.** A workstream groups projects under one
  goal, with deciders, a decisions channel and a schedule. Each project in
  it has a role (§4.13).
- **B. The loop.** Card rules and templates, review policy, delivery as a
  pull request with host gates, PR watching, merge-forward, start
  conditions and overlap warnings (§4.5 to §4.8, §4.16).
- **C. Judgment under a gate.** An event inbox, short-lived decision cards
  and one policy gate that every outgoing action passes (§4.1 to §4.4).
- **D. Talking to the outside.** Adapters for a decisions channel, the code
  host, the tracker and team chat (§4.9, §4.10).
- **E. Running unattended.** Quiet hours with an outbound queue, digests, a
  host guard, restart when idle (§4.11, §4.12).
- **F. The coordinator window** and owner tasks (§4.14).
- **G. Adoption.** Shadow mode, duty switches, and an import for a team
  that already has a coordinator (§7).

Out:

- **Descoped by the owner (2026-11-08):** no Artifact decisions board, no
  Slack or other team chat. The owner reads progress in the Claude
  session that runs the build. The channel interface and message
  protocol (§4.9) stay, with a log and that session as their only sink;
  spike S1, the board adapter and the chat adapter (§4.10) are not built.
- Any production environment. The hard limits (§6) deny it by default.
- Multi-host federation beyond the message protocol: a decider Wissel
  talks to other coordinators only through the decisions channel.
- Redesigning memory injection. This SDD only adds lesson scopes (§4.15);
  `WISSEL_MEMORY_INJECTION` stays as it is.
- User accounts and authentication for Wissel itself. §11 lists it as an
  open question; until then "the owner" is whoever operates the instance.

## 3. Data model

New tables live in the board's SQLite database (`WISSEL_DB_PATH`). All
times are ISO UTC strings. Field names below are the API's; storage may
normalise them.

### 3.1 Workstream

```ts
interface Workstream {
  id: string;
  name: string;                    // "checkout redesign"
  ticket?: string;                 // epic or ticket key in the tracker
  spec?: { repo: string; path: string };   // spec with its acceptance list
  projects: WorkstreamProject[];
  channel?: { adapter: string; target: string };  // §4.9
  chat?: { adapter: string; channel: string };    // §4.10
  quietHours?: { start: string; end: string; timezone: string };  // "22:00"
  digests?: { cron: string; timezone: string }[]; // ScheduleRunner cadence
  createdAt: string;
}

interface WorkstreamProject {
  projectId: string;               // an existing Project
  role: ProjectRole;               // §4.13
  decider?: string;                // display name of the person or agent
  decideAlone: DecisionKind[];     // what Wissel may decide by itself
  mustAsk: DecisionKind[];         // always asked, whatever the role
  never: ActionKind[];             // project-level deny, on top of §6
}

type ProjectRole = "shadow" | "follow" | "decide" | "decide-over";
```

### 3.2 Project additions

`Project` (`src/core/types.ts`) gains optional fields, stored and edited
like the existing per-project settings (`src/services/project-settings.ts`,
`POST /projects/:id/settings`):

```ts
cardRules?: string;                // appended to every card's body
cardTemplates?: Record<CardTemplateKind, string>;  // §4.16
reviewPolicy?: ReviewPolicy;       // §4.6
delivery?: Delivery;               // §4.5
env?: Record<string, string>;      // e.g. TMPDIR on a disk with room
```

### 3.3 Card additions

`TaskCard` gains `key?: string` (a short name such as `A4`), `round?:
number` (the attempt within its review lineage), `pr?: { number: number;
url: string; head: string }`, `workstreamId?: string` and `waitsFor?:
StartCondition[]` (§4.8). `key` is unique per workstream.

### 3.4 Coordination records

```ts
interface InboxEvent {             // §4.1
  id: string;                      // source-stable, so a replay is idempotent
  source: "board" | "code-host" | "channel" | "tracker" | "owner" | "host";
  kind: string;                    // "card.review", "pr.dirty", "channel.decision", ...
  workstreamId?: string;
  payload: unknown;                // untrusted when source is channel/tracker/code-host
  receivedAt: string;
  handledAt?: string;
}

interface GateRecord {             // §4.2, append-only audit
  id: string;
  action: Action;
  verdict: "allow" | "ask-owner" | "ask-decider" | "deny" | "queue";
  rule: string;                    // the rule that decided
  mode: "live" | "shadow";
  at: string;
}

interface Decision {               // a default taken, or an answer given
  id: string;
  workstreamId: string;
  text: string;
  alternative: string;
  by: "wissel" | "decider" | "owner";
  status: "taken" | "flipped";
  channelRef?: string;
  at: string;
}

interface OwnerTask {              // §4.14
  id: string;
  title: string;
  why: string;
  steps: string[];                 // shown as tick-boxes
  check?: string[];                // argv run after Done, in the sandbox, with a timeout
  blocks: string[];                // card ids waiting on it
  status: "open" | "done" | "dismissed";
}

interface DutySwitch {             // §4.13
  workstreamId: string;
  duty: Duty;
  owner: "external" | "wissel";
  changedAt: string;
}
```

## 4. Design

### 4.1 Event inbox

One persisted queue that every trigger goes through:

- board events (`BoardEvent` from `src/services/board.ts`): a card reached
  `review`, `failed`, `escalated`;
- the PR watcher (§4.7): checks finished, PR became DIRTY, merged;
- the channel adapter (§4.9): a new decider entry;
- the tracker: ticket moved by someone else;
- the owner: a message from the coordinator window;
- the host guard (§4.12).

Events carry a source-stable `id`, so reading the same channel entry twice
or replaying a day (§8) does not handle it twice. This replaces the
pilot's `board-seen.txt` and bookmark. The timestamp is the server's,
never one an agent wrote: the pilot invented board timestamps twice.

A small dispatcher maps each event kind to a handler: a deterministic one
(most kinds) or a decision card (§4.4).

### 4.2 Policy gate

A pure function, the only path to the executor:

```ts
function evaluate(action: Action, ctx: GateContext): GateVerdict
```

`GateContext` holds the project's role and lists (§3.1), the hard limits
(§6), the duty switches, the quiet hours, the host limits and whether the
instance is in Shadow. Rules apply in this order, first match wins:

1. a hard limit matches: `deny`;
2. the project's `never` list matches: `deny`;
3. the duty for this action is owned by an external coordinator: `deny`
   (no double posts during migration, §7);
4. quiet hours and the action is outward: `queue`;
5. the action kind is in `mustAsk`: `ask-decider` (role `follow`) or
   `ask-owner` (any other role);
6. the role allows the action kind (table in §4.13) and, for decisions,
   the kind is in `decideAlone`: `allow`;
7. anything else: `ask-owner`.

Shadow (role `shadow` or an instance in Shadow) does not short-circuit
the rules: they all run, and the verdict is then marked `mode: "shadow"`
so the executor records a "would" entry instead of acting. A shadow
record therefore carries the verdict the live gate would have given,
which is what the shadow report (§4.13) and the policy acceptance in §1
compare against.

Every evaluation writes a `GateRecord`. `ask-*` verdicts become a
question on the channel or an item in the window; `deny` verdicts with a
proposal behind them become a window item explaining what was refused.

Tests: a property test generates random actions and contexts and asserts
no `allow` ever matches a deny rule (§8).

### 4.3 Actions and the executor

The executor carries out allowed actions and nothing else. Action kinds:

| Kind | Effect | Outward |
| --- | --- | --- |
| `card.start` | `POST /tasks` with template, rules, key | no |
| `card.stop` | stop a running card | no |
| `channel.post` | claim, release, ready-to-merge, question, answer, decision, status, handover | yes |
| `branch.push` | push a branch after green gates | yes |
| `pr.open` | open a draft PR from a template | yes |
| `pr.arm` | enable auto-merge, or merge, on the code host | yes |
| `pr.merge-forward` | start a merge-forward card for a DIRTY PR | no |
| `ticket.transition`, `ticket.comment` | tracker write-back | yes |
| `chat.post` | digest or urgent line | yes |
| `owner.task` | raise an owner task | no |
| `host.pause`, `host.resume`, `host.restart-when-idle` | §4.12 | no |

Outward actions in quiet hours go to a persisted outbound queue that
flushes in order when the window ends. Before flushing a push, the
executor merges the main branch forward and re-runs the gates; a push
that is no longer green becomes a fix round instead (the pilot learnt
this the hard way).

### 4.4 Decision cards

Judgment runs as short-lived cards, never as a long-running session.
Each kind has a template and a JSON output schema:

| Kind | Trigger | Output |
| --- | --- | --- |
| `plan-batch` | free slots and fewer than N ready items | proposed cards: key, title, files, tier, `waitsFor` |
| `decide-default` | an open question with no answer | `{ text, alternative, lean }` |
| `triage-red` | gates red after the one retry | `retry` \| `fix-round` \| `spec-question` with reason |
| `resolve-conflict` | a merge-forward the conflict integrator gave up on | a resolution card, or `ask` |
| `read-owner-comments` | daily, when the workstream has an owner review doc | answers and follow-up actions |

Rules:

- Decision cards run on the readonly tier with no outward tools. They
  propose; only the executor acts, through the gate.
- Channel, tracker and code-host text reaches them fenced as untrusted
  data (the existing `untrusted-<nonce>` fence used by the concierge
  context). An entry can never grant approval or change a role.
- An output that fails its schema is dropped and logged, and the event is
  retried once, then raised to the owner.
- In role `follow`, `decide-default` produces a question with options and
  a lean for the decider; in role `decide`, a `Decision` logged as
  reversible. Same template, different gate verdict.

### 4.5 Delivery as a pull request

`Project.delivery`:

```ts
type Delivery =
  | { mode: "local-merge" }                       // today's behaviour
  | { mode: "pull-request";
      branchPattern: string;                      // "feat/{ticket}-{key}-{slug}"
      prTemplate?: string;                        // body with {placeholders}
      hostGates: string[][];                      // run outside the card sandbox
      gateRetries: 0 | 1;                         // re-run failed tests once
      draft: boolean; };
```

For `pull-request`, landing a finished card means, in a fresh worktree on
the host (not inside the card sandbox):

1. branch from the card's base commit;
2. apply the card's diff, staging **explicit paths** only. This replaces
   `git add -A` in `src/services/worktree.ts` (lines 553 and 759 today),
   which a coordinator role rule forbids because trees can be shared, and
   which needed the sandbox-stub filter added in 97f3dca;
3. merge the main branch;
4. run `Project.mergeGate` (exists) and then `hostGates`, each under a
   timeout, on its own port range where the gate needs one;
5. only if all are green: push, open the PR (draft if set), record
   `TaskCard.pr`, start the review card (§4.6).

A red gate after its retry raises `triage-red` (§4.4). The existing
conflict integrator handles a conflict at step 3, unchanged.

### 4.6 Review policy

```ts
interface ReviewPolicy {
  tiers: { id: string; when: string; reviewers: ReviewerSpec[]; maxRounds: number }[];
  blocks: ("HIGH" | "MED" | "MED-with-scenario")[];  // `scenario` is a field on each finding in the verdict contract, not parsed from text  // what stops a merge
  carryForward: "ticket" | "card" | "drop";          // where non-blocking findings go
  atCap: "ask-decider" | "spec-question" | "accept";
}
interface ReviewerSpec { model: "other-than-coder" | string; mode: "standard" | "adversarial" }
```

- The tier is set on the card (by the template or by `plan-batch`).
- Review cards are report-only: no reviewer hand-off, no auto-merge. In
  the pilot, routing them to the implementer made Wissel review its own
  reviews in a loop. They keep today's routing to `fixer` until the
  policy replaces it.
- The verdict is the existing structured review-verdict contract, plus
  severity counts. No parsing of a text line.
- A failing verdict under `maxRounds` starts a fix round: a fresh card
  whose body is built from the full review text (never an excerpt) and
  the project's fix-round template.
- At the cap, `atCap` decides. The review guard (`WISSEL_REVIEW_GUARD`,
  e32ebad) stays: a rework that changed nothing escalates instead of
  looping.
- A text-only or test-only change after a PASS keeps the PASS when the
  policy says so.

### 4.7 PR watcher

Extends `src/services/github-status.ts` (which already reads PRs and
checks with `gh`) into a watcher for every card with `pr` set:

- checks: pending, passing, failing, with the head sha they ran on;
- mergeable: clean, DIRTY, blocked;
- armed (auto-merge on), merged, closed.

Changes become inbox events. A DIRTY PR starts a `pr.merge-forward` card,
then a narrow re-review if the resolution touched product code. Arming is
only allowed (§4.13) when the base is the main branch, the head is the
reviewed sha and every check passed or was skipped; after any push the
watcher re-checks and re-arms. A card's lifecycle extends past `done`:
`landed` (PR open), `ready` (review passed on the head sha, checks green on that sha), `merged`.

Polling interval: 60 s per project with the existing PR cache, or the
code host's webhooks when an adapter supports them.

### 4.8 Start conditions and overlap

`TaskCard.waitsFor`:

```ts
type StartCondition =
  | { kind: "card-done"; cardId: string }
  | { kind: "pr-merged"; repo: string; number: number }
  | { kind: "path-on-main"; repo: string; path: string };
```

The sweep skips a card until all its conditions hold, as it does for
`dependsOn` and `notBefore` today. Before a card starts, Wissel lists the
files its template or plan names and warns, as a window item, when an
open card or PR touches the same files. In the pilot, two cards built the
same feature in parallel because neither knew of the other.

### 4.9 Decisions channel adapters

```ts
interface ChannelAdapter {
  read(since: Cursor): Promise<{ entries: ChannelEntry[]; next: Cursor }>;
  post(message: ChannelMessage): Promise<{ ref: string }>;
  claim?(item: string, version: number): Promise<"ok" | "taken">;  // compare-and-set
}
```

Message kinds: `claim`, `release`, `ready-to-merge` (with the full head
sha), `question` (options and a lean), `answer`, `decision`, `status`,
`handover`. One message per event, linked to the card, PR or ticket.

**Descoped:** the first and only adapter is a log plus the owner's
Claude session (questions with a default and a lean are put there).
The Artifact board below is kept as a record of the idea, not built.

First adapter (not built): a claude.ai Artifact board with `topics`, `log` and a
`ready` collection (compare-and-set claims by version). **Known
constraint, to check first (§9, phase 0):** such a board can be written
only by a Claude session through `ArtifactData`, not by a server with a
token. If that holds, the adapter is a "scribe": a short-lived
claude-cli card with the artifact tools, given one message to write and
returning the entry id. Reads can then go the same way, batched each
interval.

Later adapters: code-host reviews (decisions as PR reviews and comments)
and chat threads. The protocol does not change.

### 4.10 Tracker and chat

- Tracker: the existing ticket provider (`src/services/ticket-provider.ts`,
  `jira-provider.ts`, `integrations.yaml`) already supports reads and,
  with `writeBack: true`, transitions and comments. The coordinator adds
  rules: a ticket before a workstream's first card, "in progress" at the
  first card, "in review" when the last PR is open, "done" when its
  acceptance is merged, with one comment per move naming the merged PRs.
- Chat (not built, descoped): a new adapter (Slack first) with a bot token read from an
  environment variable whose name is configured, like the tracker's.
  Posts only to the workstream's channel: digests, and lines for urgent
  owner tasks.

### 4.11 Quiet hours and digests

- Quiet hours (§3.1): cards keep running; outward actions queue (§4.3).
  The window shows the queue and its flush time.
- Digests: a new schedule kind in `ScheduleRunner`
  (`src/core/schedule-runner.ts`) that fills a fixed template from Wissel's
  own data: cards live against the cap, PRs by state, what waits on the
  decider, owner tasks, host load, disk and memory. No model call.
  `src/services/wissel-digest.ts` is the starting point.

### 4.12 Host guard and restart when idle

- Host guard: before each dispatch the sweep reads load, free memory,
  free disk and free space on each project's temp directory. Below a
  threshold it pauses new cards (running ones continue) and raises an
  owner task with the evidence (the largest temp directories and the
  cards writing to them). Thresholds are host settings with defaults:
  load under 3 x cores, 20% memory free, 30 GB disk free.
- Per-project `env` (§3.2) sets `TMPDIR` and similar for cards and gates.
  The pilot's temp volume filled because every card inherited the
  harness's temp directory.
- Restart when idle: `POST /admin/restart-when-idle` stops new
  dispatches, waits for running cards, then exits with code 75. Wissel
  cannot restart itself, so the start script (or a systemd unit with
  `Restart=on-failure`) restarts the process on that code. On start it
  logs its version and integration lines and posts them to the window.
  A pending restart is visible and can be cancelled.

### 4.13 Roles, duty switches, Shadow

What each role may do (the gate's table):

| Action | `follow` | `decide` | `decide-over` |
| --- | --- | --- | --- |
| `card.start` from its own plan | after the decider's claim answer | yes | for its own cards |
| `channel.post` claim | yes | yes | seeds the ready queue |
| `decision` | as a question | if in `decideAlone` | answers coordinators |
| `pr.arm` | no: posts ready-to-merge | yes | for coordinators' ready PRs |
| `ticket.*`, `chat.post` | yes | yes | yes |

`shadow` runs everything with the executor in record-only mode.

- Only the owner changes a role, a list or a duty switch, from the window
  or the project settings, with a confirm step. Channel entries, PR
  comments and other coordinators cannot.
- A role change withdraws or hands over open questions with a channel
  note and takes effect at the next idle tick, never during an arm.
- Duties for the switches: `status`, `host`, `landing`, `review`,
  `channel-read`, `claims`, `ready-to-merge`, `arming`.
- Shadow writes a "would" record per action. `GET
  /workstreams/:id/shadow-report` compares them with what actually
  happened (the external coordinator's channel entries and PRs).

### 4.14 The coordinator window

One window per workstream, docked beside the board (`board.html`) and as
a screen in the app (`app/`). It reuses the concierge (Ask) machinery:
conversations (`src/services/conversations.ts`) and pending actions with
confirm (`src/services/pending-actions.ts`), scoped to the workstream.

- Header: the role per project, live state, cards against the cap, when
  the channel was last read, quiet hours.
- Conversation: owner messages and replies, mixed with structured items:
  status lines, decisions with Flip, owner tasks with tick-boxes and a
  Done that runs the task's `check`, plans that start unless held.
- Decisions tab: `Decision` records, with Flip (takes the alternative and
  posts it to the channel).
- Log tab: the channel entries, the decider's included.
- Input: quick actions (status now, what is waiting on me, pause new
  cards, restart when idle), "log it on the channel" (on by default),
  "urgent: also chat". Policy changes always show the change and ask to
  confirm.

Owner tasks also show in Needs a human, which already carries a reason
and tick-box steps (0ad0693, `src/services/needs-you.ts`).

### 4.15 Memory scopes

The memory curator keeps writing `memory/lessons.md`; each lesson gains a
scope:

- `wissel`: a problem with Wissel's own environment. It becomes a
  suggested Wissel issue, not a prompt line.
- `project`: a standing rule. Proposed to the owner as an addition to
  `cardRules`; applied only on approval.
- `path:<glob>`: code knowledge for an area. Added to a card's brief only
  when the card's planned files match.

Injection stays governed by `WISSEL_MEMORY_INJECTION`; scoped lessons are
the input for that later design.

### 4.16 Card templates and rules

Template kinds: `coder`, `review`, `fix-round`, `split-only`,
`merge-forward`. A template is markdown with placeholders (`{key}`,
`{ticket}`, `{files}`, `{review}` and so on) and a size limit (default
2,500 characters before `cardRules`). `card.start` renders the template,
appends `cardRules`, and refuses to start a card whose required
placeholders are empty. The pilot's empty fix brief would have been
refused.

## 5. API

New routes (in `src/api/server.ts`, logic in services):

- `GET/POST /workstreams`, `GET/PATCH/DELETE /workstreams/:id`
- `POST /workstreams/:id/projects/:projectId/role` (owner only)
- `GET /workstreams/:id/duties`, `POST /workstreams/:id/duties/:duty`
- `GET /workstreams/:id/inbox`, `GET /workstreams/:id/gate-log`
- `GET /workstreams/:id/decisions`, `POST /decisions/:id/flip`
- `GET /workstreams/:id/outbound` (the quiet-hours queue)
- `GET /workstreams/:id/asks?status=open`,
  `POST /workstreams/:id/asks/:askId/approve` and `/reject` (the owner's
  answer to an `ask-*` verdict, `src/services/asks.ts`; approve re-checks
  the hard limits, runs the action once and logs it as owner-approved)
- `GET /workstreams/:id/shadow-report`
- `GET/POST /owner-tasks`, `POST /owner-tasks/:id/done`
- `POST /admin/restart-when-idle`, `DELETE /admin/restart-when-idle`
- `POST /workstreams/:id/import` (§7)
- `POST /projects/:id/settings` accepts the §3.2 fields

`GET /tasks` adds `key`, `round`, `pr` and `workstreamId` to each card.

## 6. Hard limits and security

- Hard limits are code, configured in a file read at start (like
  `integrations.yaml`), never from a channel or a card. Defaults deny:
  production targets (by account id, cluster or host patterns the owner
  lists), pushing to or arming a branch other than the configured main
  branch, merging with a failing check, touching another team's PRs or
  repositories listed as read-only, contacting anyone outside the
  configured channels.
- Credentials are never stored by Wissel. Adapters name environment
  variables, as `integrations.yaml` does today.
- Least privilege in phases: code host read, then push and PR, then merge
  only for a project whose role is `decide`; tracker read, then write.
- Everything from a channel, tracker or code host is untrusted data,
  fenced in prompts (§4.4) and never executed.
- The gate log is append-only and kept with the board database.

## 7. Adopting it

A new team starts every project in `shadow`, then hands duties to Wissel
one at a time.

A team that already has a coordinator:

1. **Import** (`POST /workstreams/:id/import`): a JSONL registry of its
   work items (`{ key, cardId?, pr?, sha?, round? }`), its standing rules
   (become `cardRules` and templates), its channel cursor, its schedule.
   Existing cards get `key` and `pr` set; nothing is created.
2. **Shadow** for one or two days. Move on when the shadow report matches
   on ready-to-merge lists, shows no would-be hard-limit violation and no
   missed decider entry.
3. **Duty by duty**, switch at a time, in this order: `status`, `host`,
   `landing` and `review` (right after a quiet-hours flush), `channel-read`,
   `claims` and `ready-to-merge`. The old coordinator removes its own cron
   or script for each duty.
4. **Cut-over**: a `handover` message on the channel, approved by the
   owner; the old coordinator stays read-only for a week. Rollback is
   flipping a duty back.

## 8. Tests and evals

Gate lane (part of the build, `bun test`):

- Policy gate: table tests for each rule and role; a property test that
  no `allow` matches a deny rule; quiet hours queue outward kinds only.
- Inbox: idempotent replay of the same event ids.
- Delivery: a real git fixture (as `test/review-guard.test.ts` does):
  explicit-path staging ignores sandbox stubs and untracked junk; a red
  gate never pushes; quiet hours queue the push.
- Review policy: rounds, cap, fix-round brief contains the full review,
  empty brief refused.
- PR watcher: DIRTY starts one merge-forward, not two; re-arm after push.
- Start conditions and overlap warnings.
- Templates: required placeholders, size limit.
- Restart when idle: no dispatch while draining, exit code 75 after the
  last card.
- Instance isolation: with `WISSEL_HOME` set, no state path resolves under
  `~/.wissel`, and the sandbox read-denies the instance's database.

Eval lane (periodic, `eval/`):

- **Replay eval.** A recorded day of the pilot (card events, PR events,
  channel entries, with names removed) runs through Wissel in Shadow. The
  report compares ready-to-merge lists, claims and decisions with what
  the pilot's coordinator did. Target: at least 95% agreement on
  ready-to-merge, zero would-be hard-limit violations.
- Decision-card quality: a fixed set of open questions and red gates with
  known good answers; schema validity and agreement are tracked over time.

End-to-end (Playwright): the window's tabs, Flip, Hold, owner task Done,
the confirm step on a role change.

## 9. Build plan (cards)

Each card at most 400 changed lines, test-first, one concern. Phase 0
answers the questions that could change the design.

**Phase 0: spikes (read-only, a day)**

- ~~S1~~ (descoped, no board) Channel writes: can a server write the Artifact board, or only a
  Claude session? Build the smallest scribe card that posts one log entry
  to a test board and returns its id.
- S2 Code host: the minimum token scopes for push, PR and auto-merge;
  whether a service account can do it.
- S3 Supervisor: restart on exit code 75 from the start script and from
  systemd.

**Phase 1: small, removes the most hand work**

1. Card keys, rounds and PR fields on `TaskCard` (§3.3).
2. `cardRules` and templates on projects; render and refuse empty (§4.16).
3. Explicit-path staging in `worktree.ts` (§4.5 step 2).
4. Owner tasks: model, API, Needs a human item, `check` on Done (§3.4).
5. Restart when idle (§4.12).
6. Host guard and per-project `env` (§4.12).

**Phase 2: the delivery loop**

7. Delivery as a PR with host gates (§4.5).
8. Review policy, fix-round builder, cap handling (§4.6).
9. PR watcher and card lifecycle past `done` (§4.7).
10. Merge-forward on DIRTY (§4.7).
11. Start conditions and overlap warnings (§4.8).

**Phase 3: the coordinator**

12. Workstreams and roles: model, API, settings UI (§3.1, §4.13).
13. Event inbox and dispatcher (§4.1).
14. Policy gate with audit log and the property test (§4.2).
15. Executor, outbound queue, quiet hours (§4.3, §4.11).
16. Decision cards: `plan-batch`, `decide-default`, `triage-red` (§4.4).
17. Channel interface, message protocol and log/session sink (§4.9).
18. Tracker rules (§4.10); no chat adapter.
19. Digests (§4.11).
20. Duty switches, Shadow and the shadow report (§4.13).
21. Import (§7).

**Phase 4: the window and memory**

22. Coordinator window in the board and the app (§4.14).
23. Lesson scopes and the promotion flow (§4.15).
24. Replay eval (§8).

## 10. Where it breaks

- **Board writes.** If S1 shows only a Claude session can write the
  board, every channel post costs a card run. Batch posts per interval
  and keep the read path cheap.
- **Gate holes.** An action kind added without a gate rule falls through
  to `ask-owner` (rule 7), never to `allow`. Keep it that way.
- **Two coordinators acting.** During migration, the duty switches are the
  only guard. The external coordinator must stop its own script when a
  duty moves; the shadow report shows double activity.
- **Stale head.** Arming checks the reviewed sha against the PR head on
  every attempt; a push after review needs a new review or a policy rule
  that allows text-only deltas.
- **Restart without a supervisor.** Exit code 75 with nothing to restart
  the process leaves the team without Wissel. The admin route refuses
  when no supervisor is configured, detected by `WISSEL_SUPERVISED=1`
  set in the start script or unit.
- **Cost.** Decision cards are cheap only if they stay short and
  single-use. Spend ceiling (`WISSEL_SWEEP_SPEND_CEILING_USD`) must be set
  for any workstream with role `decide`.
- **Untrusted text.** A decider entry that reads like an instruction must
  stay data. The fence and the schema-only outputs are the defence;
  test them with adversarial fixtures.

## 11. Open questions

1. ~~Which channel adapter first?~~ Answered: the log and the owner's
   session; no board, no chat.
2. Whose identity does Wissel act under on the code host: a service
   account or app per team (auditable), or a person's login?
3. One workstream per host or several sharing the cap, quiet hours and
   digests?
4. Is `decideAlone` a fixed menu of decision kinds (easier to audit) or
   free text?
5. Do decisions live in Wissel with the channel as a mirror, or on the
   channel with Wissel as a reader?
6. Authentication: who counts as "the owner" when several people can open
   the instance?

## 12. Handover notes for the builder

- Build on a **separate Wissel instance**: its own checkout, its own
  `WISSEL_HOME` (065c396; moves worktrees, scratch, projects, task
  output, audio, the models cache and the default database and telemetry
  paths), its own `WISSEL_PORT`, `WISSEL_DB_PATH`, `WISSEL_TELEMETRY_PATH`,
  `WISSEL_MEMORY_PATH` and worktree location, and its own test
  repositories. Do not point it at a Wissel or a board that coordinates
  live work.
- Base branch: this design builds on three commits that are not on
  `origin/main` yet: `97f3dca` (drop sandbox stubs before staging),
  `e32ebad` (review guard), `0ad0693` (Needs a human and Next step
  lanes). Start from a branch that contains them.
- Use a copy of the decisions board for phase 0 and all tests, never the
  live one. Keep `writeBack: false` on the tracker until phase 3.
- Run Wissel's own gates on every card: `bun test`, `bun run typecheck`,
  the app tests in `app/`, and the affected Playwright specs
  (`bun run test:e2e:affected`).
- Two Playwright tests failed before this work and are not part of it:
  `e2e/board.spec.ts` "an escalated task renders its full round-by-round
  timeline" and "the nav is one header row across the top".
- Report progress per card; questions with a default and a lean, so work
  never blocks on an answer.
