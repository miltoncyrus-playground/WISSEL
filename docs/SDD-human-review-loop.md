# SDD: The human review loop

Delivering work people review: keeping a pull request reviewable,
answering what reviewers ask, and spending their attention carefully.

Status: draft, for review by the owner before any card starts. Companion
pages: `docs/SDD-review-handoff.md` (the model reviewer loop this
extends), `docs/SDD-coordinator.md` §4.5 to §4.7 (delivery and the PR
watcher) and `docs/SDD-identity-and-permissions.md` (who Wissel is on the
code host). To be built on a separate Wissel instance.

## 1. Why, and the outcome

Wissel's review loop today is closed: an implementer lands on
`pending-review`, a reviewer agent on another model returns a verdict, a
`changes_requested` reruns the implementer in the same worktree, and after
five pushbacks the card escalates (`docs/SDD-review-handoff.md`). Nothing
in that loop needs a person, and the work merges into the local checkout
without a pull request ever existing.

That works because the pilot owned every repository it touched and no
human reviewed anything. Any other team inverts it: people review, a
shared `main` moves under you all day, `CODEOWNERS` and branch protection
decide what may merge, and a pull request lives for days rather than
minutes.

The mistake to avoid is treating human review as the model loop with a
slower reviewer. It is a different constraint. Agent capacity is bought
with money and is elastic; reviewer attention is fixed, shared with the
rest of their job, and the first thing an agent fleet destroys. During
the pilot 42 pull requests merged in half a day. The same fleet pointed
at a team with two reviewers produces a queue nobody can clear and a
reputation the tool does not recover from.

So the model reviewer does not go away — it moves. It becomes pre-flight,
and its job is to make sure a person never spends a round on something a
machine could have caught. The human's round is for intent, design and
consequences.

**Outcome:** Wissel delivers changes that are small, green, current and
explained; it answers what reviewers ask without silently changing code;
it never asks for attention it has not earned; and it never approves
anything.

**How we see it:**

1. No pull request leaves draft without passing the reviewability checks
   (§4.2). A test enumerates them against fixtures; a failing check is a
   card, not a review request.
2. Over a replayed week of real review threads, every comment is
   classified and answered or actioned, with no thread left without a
   reply naming the sha that addressed it, and no thread resolved by
   Wissel.
3. No approval, no merge with a failing required check, no force-push to
   a branch under review, no comment from Wissel on a pull request it does
   not own: each a property test, each a hard limit.

## 2. Scope

In:

- **A. Delivery.** A card's work becomes a branch and a draft pull request
  with a description written for a person.
- **B. Reviewability.** The checks that decide when a draft becomes ready,
  including size budget and the model pre-flight.
- **C. The comment loop.** Watching threads, classifying them, answering
  questions, running fix rounds, replying with the sha, re-requesting.
- **D. Staying current.** Merge-forward when the base moves, and when a
  delta needs a new review.
- **E. Reviewer attention.** Work-in-progress limits per reviewer, request
  timing, nudges, and escalation for a stalled pull request.
- **F. Deference.** Reading `CODEOWNERS`, branch protection and required
  checks from the host instead of a local list.

Out:

- The model reviewer loop itself. `docs/SDD-review-handoff.md` stands;
  this spec changes where in the sequence it runs, not how it works.
- Merging. Who may merge and under what conditions is the policy gate's
  question (`docs/SDD-coordinator.md` §4.2, §4.13).
- Code hosts other than GitHub in the first pass. The watcher and the
  thread model are adapter-shaped so GitLab can follow.
- Review of work Wissel did not produce. Wissel comments only on its own
  pull requests.

## 3. Data model

New tables in the board database. All times are ISO UTC strings.

### 3.1 Pull request

The long-lived object. A card ends at delivery; the pull request outlives
it, and every later round is a fresh card (`docs/roles` disposability
rule: never resume an agent after its pull request).

```ts
interface PullRequestRecord {
  id: string;
  repo: string;                  // "org/repo"
  number: number;
  url: string;
  taskId: string;                // the card that delivered it
  workstreamId?: string;
  ticket?: string;
  branch: string;
  base: string;
  headSha: string;
  draft: boolean;
  state: "draft" | "awaiting-review" | "addressing" | "waiting-on-reviewer"
       | "approved" | "merged" | "closed" | "stalled";
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: PrChecks;              // from src/services/github-status.ts
  reviewers: string[];           // host logins, humans only
  size: { lines: number; files: number; excluded: number };
  rounds: number;                // human change-requested rounds
  requestedAt?: string;
  firstReviewAt?: string;
  lastNudgeAt?: string;
  updatedAt: string;
}
```

`state` is derived from the host plus Wissel's own activity, never set by
hand. `PrChecks` and the `gh`-backed read path already exist in
`src/services/github-status.ts`; this extends it from per-branch state to
a stored record with threads.

### 3.2 Review thread

```ts
interface ReviewThread {
  id: string;                    // host thread id, source-stable
  pullRequestId: string;
  author: string;                // host login
  authorKind: "human" | "bot" | "wissel";
  path?: string;
  line?: number;
  body: string;                  // untrusted data, always fenced in prompts
  createdAt: string;
  classification?: ThreadClass;
  waitingOn: "wissel" | "reviewer" | "owner" | "nobody";
  answeredAtSha?: string;        // the head that addressed it
  replyRef?: string;
  resolvedByHuman: boolean;      // Wissel never sets this true
}

type ThreadClass =
  | "change-requested"   // a code change is wanted
  | "question"           // an answer is wanted, not a change
  | "suggestion"         // optional; may be declined with a reason
  | "out-of-scope"       // real, but belongs in a follow-up ticket
  | "already-addressed"  // a later commit covers it
  | "blocked";           // needs an owner decision
```

### 3.3 Review round

```ts
interface ReviewRound {
  id: string;
  pullRequestId: string;
  index: number;
  openedAt: string;
  threads: string[];             // thread ids in this round
  fixTaskId?: string;            // the fresh card that addressed them
  verdictSha?: string;
  closedAt?: string;
}
```

### 3.4 Additions

- `tasks`: `pullRequestId`, and a `delivered` terminal status (§4.1).
- Project settings: `reviewPolicy` (§4.8) and `sizeBudget` (§4.2).

## 4. Design

### 4.1 Delivery ends the card

Today a card ends at merge. With people reviewing, a pull request lives
for days, and nothing may hold an agent slot for days.

So the implementer card ends at `delivered`: branch pushed after green
gates, draft pull request opened, `PullRequestRecord` created, worktree
kept, slot released, agent stopped and cleaned up. Everything after that
is driven by events on the pull request, and each round spawns a fresh
card against the same worktree.

The brief's end state stays what it already is — checks that pass — plus
one line: the pull request is open as a draft and its description is
written. Nothing in the brief asks the agent to wait for anything.

### 4.2 Reviewability: what earns a review request

A draft becomes ready only when all of these hold. Each failure makes a
card or an owner task; none of them asks a person to look.

1. **Green on the exact head.** Required checks pass for `headSha`, read
   from the host, not inferred from a previous run.
2. **Current.** The base merges into the branch with no conflict, and the
   base has not moved since the gates ran.
3. **Within budget.** Default 400 changed lines and 20 files, excluding
   lockfiles, generated files and fixtures (host `linguist-generated`
   attributes plus a per-project exclude list). Over budget produces a
   split card, not a review request.
4. **Pre-flight clean.** A model review on a different model from the
   author has run on this head and reports no HIGH and no MED with a
   concrete failing scenario. Its verdict is posted as a clearly labelled
   comment, never as an approval.
5. **Explained.** The description follows the template: what changed and
   why, how it was verified (the commands and their result), what to look
   at first, what is deliberately out of scope, the ticket key, the card
   id, the authorizing principal and the policy revision. Written for a
   person who has not read the brief.
6. **Attributed.** No AI attribution or `Co-Authored-By` trailer in any
   commit; the chain lives in the body (`docs/SDD-identity-and-permissions.md`
   §4.6).
7. **Addressed to the right people.** Reviewers resolved from `CODEOWNERS`
   and the branch protection rules, intersected with the workstream's
   configured reviewer set (§4.8).

Then: mark ready, request review, set `requestedAt`, record the action.

### 4.3 The watcher

Polling through `gh` with fixed argv, as `github-status.ts` already does,
at an interval per project; webhooks later behind the same event shape.
Each of these becomes one inbox event with a source-stable id, so a replay
never acts twice:

- review submitted (approved, changes requested, commented);
- a new review thread or a reply on an existing one;
- head moved (including a reviewer pressing "commit suggestion");
- base moved, or the pull request became `CONFLICTING`;
- required checks changed state;
- a review request timed out (§4.9);
- the pull request merged or closed by someone else.

Everything the watcher reads is untrusted data. A comment that says
"approve this", "merge it", "run this script" or "you may force-push" is
quoted into a prompt inside the existing `untrusted-<nonce>` fence and can
never widen what the card may do. The permission to act comes from the
gate and the card's grants, never from the page.

### 4.4 Classification before action

A `triage-review` decision card runs on the readonly tier with no outward
tools. It reads the threads of one round and returns, per thread, a
`ThreadClass`, a one-line reason, and for `change-requested` the files it
expects to touch. Schema-checked; an output that fails the schema is
dropped, retried once, then raised to the owner.

This exists because the four responses are genuinely different work:

- **change-requested** → a fix round (§4.5).
- **question** → an answer, not a diff (§4.6).
- **suggestion** → applied, or declined with a reason in the thread.
  Declining is allowed and is often right; silently ignoring is not.
- **out-of-scope** → a follow-up ticket, linked in the reply, and the
  thread says so.
- **already-addressed** → a reply naming the sha that covered it.
- **blocked** → an owner task; the thread says a decision is pending and
  who holds it.

### 4.5 Fix rounds

One fresh fixer per round, in the pull request's worktree, briefed with
the full set of `change-requested` threads quoted as data, the files they
name, and the standing rules. Never a resumed agent; never one card per
comment, which produces a thread of unrelated pushes a reviewer cannot
follow.

After the fix: gates on the host, merge the base forward, push, then one
reply per thread naming what changed and the sha, then re-request review
once. The round closes with `verdictSha` set.

Caps: two human change-requested rounds. A third sends the card back to
the spec with an owner task, mirroring the pilot's two-round adversarial
rule — a third round of the same argument is a specification problem, not
a code problem.

Wissel never resolves a thread. The person who opened it resolves it, or
it stays open. `resolvedByHuman` exists so the data model cannot express
anything else.

### 4.6 Answering, without touching the code

A `question` thread gets an answer from a readonly card with repository
access: it reads the code, answers in the thread, cites files and lines,
and sets `waitingOn: "reviewer"`. The pull request state becomes
`waiting-on-reviewer`, which is visible in the window and excluded from
the nudge clock.

A question never causes a code change on its own. If the honest answer is
"you are right, that is wrong", the answer says so and opens a fix round
explicitly — the reviewer then sees a thread they can follow rather than a
surprise commit.

### 4.7 Staying current, and when a delta needs a new review

- The base moves: merge it forward in the worktree, re-run the gates,
  push. A clean merge with no conflict needs no new human review, but it
  does need a comment naming the new head, because an approval is pinned
  to a sha (`docs/SDD-identity-and-permissions.md` §4.5) and a silent push
  under a stale approval is how teams get surprised.
- A conflict resolved by hand or by an integrator card is a change, so it
  needs review of the resolution — only of the files both sides touched.
- A push after approval invalidates that approval. Either the delta is
  text-only (comments, docs, a test name), which the policy may allow
  through with a comment, or review is re-requested. This is the pilot's
  rule, generalized: the gate decides, per project, which deltas survive
  an approval.

### 4.8 Deference: the team's rules are the source

`reviewPolicy` per project is read from the host, not written locally:

- `CODEOWNERS` decides who must review which paths.
- Branch protection decides required approvals, required checks, whether
  stale reviews are dismissed, and who may merge.
- The workstream names the humans Wissel may address at all, and nobody
  outside that set is ever requested or mentioned.

Where the host says a human approval is required, Wissel's pre-flight
verdict is a comment, never a review event, so a machine can never satisfy
a required-approval count. Where the host requires a check Wissel cannot
run, the pull request waits; it does not propose relaxing the rule. The
pilot's line holds generally: rulesets are not an outage lever.

### 4.9 Reviewer attention is the budget

The constraint that replaces agent capacity. All defaults, all per
workstream:

- **Per-reviewer work in progress:** at most 5 open pull requests awaiting
  one person. At the limit, finished work stays in draft and the
  dispatcher's free slots go to landing, not to new cards (L8, now driven
  by review capacity rather than merge rate).
- **Request timing:** review requests and nudges go out inside the
  workstream's working hours only, queued like any other outward action
  during quiet hours. A request at 03:00 is noise.
- **Nudges:** one, after two working days with no first review, in the
  pull request and nowhere else. Then the pull request is `stalled` and
  the owner gets a decision card: reassign, close, or keep waiting.
- **Batching:** replies for one round go out together, not one per
  comment. One notification per round per reviewer.
- **No bot duels.** A comment whose author is another bot is classified
  but never answered with a comment; at most it becomes a fix round. Two
  agents commenting at each other is an incident, so a counter caps
  Wissel's replies on any pull request per day and raises an owner task at
  the cap.

### 4.10 What the window shows

- Pull requests by state, with what each is waiting on and who holds it.
- Reviewer load: open pull requests per person against the limit, and time
  to first review as a trend. It should be falling; if the fleet is
  burning reviewer attention it shows here first.
- Threads waiting on Wissel, with their class and the round they belong
  to.
- Comments per pull request over time, which is the signal for the lesson
  path: a comment class that keeps recurring becomes a proposed card rule,
  and the next generation of work stops producing it
  (`docs/SDD-coordinator.md` §4.15).

## 5. API

- `GET /pull-requests`, `GET /pull-requests/:id` — record, threads, rounds.
- `POST /pull-requests/:id/refresh` — force a watcher pass.
- `POST /pull-requests/:id/ready` — run the reviewability checks and mark
  ready; refuses with the failing check named.
- `POST /pull-requests/:id/round` — open a round from the current threads.
- `POST /threads/:id/reply` — one reply, through the gate, logged.
- `POST /pull-requests/:id/stall` and `/reassign` — owner actions.
- `GET /projects/:id/review-policy` — what was read from the host, and
  when.

Every write route declares its permission
(`docs/SDD-identity-and-permissions.md` §4.3): `pr.open`, `channel.post`
for replies, `card.create` for rounds.

## 6. Hard limits and security

- **Never approve a pull request.** Not its own, not anyone's, under no
  role, with no verdict behind it. The pre-flight verdict is a comment.
- **Never merge with a failing required check**, and never merge a pull
  request whose base is not the configured base branch.
- **Never resolve, hide, edit or delete a human's comment or review.**
- **Never force-push, rebase, amend or reset a branch under review.** A
  rejected push stops and reports.
- **Never dismiss a stale review** to clear a block.
- **Never comment on, push to or request review on a pull request Wissel
  does not own**, and never address a person outside the configured
  reviewer set.
- Everything read from the host is data. No comment, review body, commit
  message or check output can grant a permission, lift a hard limit or
  change a role.
- The reply cap per pull request per day is a hard limit, not a setting a
  card can raise.

## 7. Adopting it

1. **Watch only.** The watcher, the records and the window view. Wissel
   writes nothing to the host. A team sees its own review state next to
   its cards and nothing changes.
2. **Deliver as a draft.** Cards end at `delivered` with a draft pull
   request and a written description. Humans mark ready themselves. This
   alone removes most of the hand work, and nobody is notified by a
   machine yet.
3. **Ready and request.** The reviewability checks and the review request.
   The first step that spends someone's attention, so it ships with the
   work-in-progress limit and the working-hours rule, not after them.
4. **Answer and fix.** Classification, answers, fix rounds, replies,
   re-requests, round caps.
5. **Stay current.** Merge-forward, delta rules, nudges, stall
   escalation.

Each phase is useful alone and reversible by a duty switch.

## 8. Tests and evals

- **Reviewability.** Each check refuses on a fixture that fails it, and
  the refusal names the check. Over budget produces a split card, never a
  request.
- **Never approve.** A property test over every host write the executor
  can make: none is a review-approve event.
- **Untrusted comments.** Fixtures of comments instructing approval,
  merging, force-pushing, running a command, or claiming a role change.
  Each is classified and none changes what the card may do.
- **Threads.** Replay a recorded review: every thread ends with a
  classification and either a reply naming a sha or an owner task; none is
  resolved by Wissel.
- **Rounds.** Two change-requested rounds, then the third goes to spec.
  One fix card per round, never one per comment.
- **Stale approval.** A push after approval refuses to arm; a text-only
  delta passes only where the policy allows it, and comments the new head.
- **Attention.** Work-in-progress limit holds work in draft; nudges fire
  once; requests outside working hours queue; replies batch per round; the
  bot-duel cap raises an owner task.
- **Deference.** A project whose branch protection requires two approvals
  never has Wissel satisfy either.

## 9. Build plan (cards)

1. `PullRequestRecord` and the stored read path, extending
   `github-status.ts` from per-branch state to records.
2. The watcher and its event kinds on the inbox, with idempotent ids.
3. `delivered` status, worktree retention after delivery, and the
   description template.
4. Reviewability checks, including the size budget and the pre-flight
   verdict comment.
5. Threads, `triage-review`, and the thread state model.
6. Answers (readonly), replies, and the one-reply-per-thread discipline.
7. Fix rounds, round caps, and the spec hand-back.
8. Merge-forward, delta rules, and approval invalidation.
9. Attention: work-in-progress limits, working hours, nudges, stall
   escalation, the reply cap.
10. The window view and the comment-class trend.

Cards 1 to 3 are useful with nothing else built.

## 10. Where it breaks

- **Polling and rate limits.** A project with many open pull requests
  burns the host's API budget. The interval is per project, backs off on
  secondary limits, and the window shows when the state was last read, so
  nobody treats a stale record as fact.
- **A reviewer who edits the branch.** The head moves under the fix round.
  The event exists; the round rebases nothing and merges forward, and a
  conflict becomes an integrator card as usual.
- **Suggestion batches.** Committing several suggestions from the host UI
  moves the head and resolves threads at once. Treated as head-moved plus
  externally-resolved threads; never as Wissel's own work.
- **Bot-authored comments.** Distinguishing a bot from a human is the
  host's `type` field, which is reliable for Apps and not for a service
  account someone created as a user. Where it is unknown, treat it as
  human and let the reply cap contain the damage.
- **Attention limits are unpopular before they are understood.** Holding
  finished work in draft because a reviewer is at their limit looks like
  the tool being slow. The window has to say exactly why, naming the
  limit, or someone raises it to 50 and the queue returns.
- **`gh` identity.** Until the GitHub App lands, every comment and request
  comes from whoever's login `gh` holds on that host — which is also why
  the reply cap and the reviewer set matter now rather than later.
- **A stalled pull request is sometimes correct.** Nobody reviewing can
  mean nobody should: the work was not wanted. The stall decision card
  offers close as a first-class answer, not only reassign.

## 11. Open questions

1. Size budget: is 400 lines and 20 files the right default, and does it
   count a generated file the host does not mark as generated?
2. Does the pre-flight verdict belong in a comment at all, or in the
   description and the board only? A comment is visible but adds noise to
   every pull request.
3. Who owns the reviewer set: the workstream, or `CODEOWNERS` alone? The
   first is safer in a large organization, the second is less to keep in
   sync.
4. Should Wissel open pull requests against a shared `main` at all before
   phase 3, or always into a team-owned integration branch first?
5. Working hours per reviewer or per workstream — a distributed team makes
   the single window wrong for someone.
6. When a human asks for a change that a hard limit forbids, is the reply
   Wissel's own refusal with the limit named, or an owner task that a
   person answers?

## 12. Handover notes for the builder

- Build on a **separate Wissel instance**, against test repositories with
  real `CODEOWNERS` and branch protection. Never point it at a repository
  a team is working in.
- Extend `src/services/github-status.ts`: it already runs `gh` read-only
  with fixed argv and turns failures into an error on the project rather
  than a throw. Keep both properties; nothing here needs a shell string.
- The state machine in `docs/SDD-review-handoff.md` stays. This spec adds
  `delivered` and the pull-request states beside it; it does not rewrite
  `handleReviewVerdict`.
- The model reviewer is not removed. It moves in front of the human, and
  its verdict is a comment, never an approval.
- Every new column on an existing table needs the same `ADD COLUMN` heal
  the `tasks` table does.
- Run Wissel's own gates on every card: `bun test`, `bun run typecheck`,
  the app tests, and `bun run test:e2e:affected`.
- Report progress per card; questions with a default and a lean, so the
  work never blocks on an answer.
