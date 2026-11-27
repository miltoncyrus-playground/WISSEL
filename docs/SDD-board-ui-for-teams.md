# SDD: A board a newcomer can use

Two modes over one data model: the operator console Wissel has, and a
work-and-decisions surface for everyone else.

Status: draft, for review by the owner before any card starts. Companion
pages: `docs/SDD-ui-cleanup.md` and `docs/SDD-wissel-app.md` (the surfaces
this changes), `docs/SDD-identity-and-permissions.md` (which decides who
sees which mode) and `docs/SDD-human-review-loop.md` (the review screen).

## 1. Why, and the outcome

The board is an operator console and a good one. It shows cards, lanes,
the router's decision, tiers, harnesses, worktrees, pushback counts and
MCP approvals, because the person using it built the machine underneath.

An end user does not have a card. They have a goal, a question they are
being asked, and work they need to review. Every noun on the current
board is machine-side: card, lane, router, tier, harness, worktree,
pushback, escalated, no-match. Before anything else, that vocabulary is
the barrier — not the layout.

The second barrier is the front door. Creating work today means filling in
a card: title, body, labels, repository, tier, model, harness. Choosing a
tier and a harness requires knowing what the router does with them. The
point of a coordinator is that nobody should need to.

The third is trust. A cautious person will not press **Run** on an agent
that may change code until they can see what it is allowed to do, where it
can write, and what it may spend. None of that is on screen at the moment
of pressing the button.

**Outcome:** a person who has never seen Wissel can state a goal, approve
a plan, answer what they are asked, review what came back, and tell at a
glance whether their workstream is going well — without learning a single
internal noun. The operator console stays exactly as it is for the people
who want it.

**How we see it:**

1. A newcomer with no walkthrough starts work, approves a plan, answers a
   question and reviews a change, using only the user-mode surface. Run it
   as a five-person test, count where they stop.
2. No user-mode screen shows the words card, lane, tier, harness,
   worktree, pushback, no-match or escalated.
3. Every item on the home screen can be answered from the home screen: the
   thing itself, the choices, and what each choice does, with no drawer to
   open first.

## 2. Scope

In: the mode split; the goal front door; vocabulary; the home screen; the
workstream header; decisions; live work; the trust panel; the review
screen; first run; error presentation; phone width.

Out: a redesign of the operator board (`docs/SDD-ui-cleanup.md` stands);
the app's architecture (`docs/SDD-wissel-app.md`); any change to the data
model, the router or the executors. This spec adds surfaces and renames
labels. If a change here needs a new table, it belongs in another spec.

## 3. The two modes

One data model, two surfaces. The mode is not a preference: it follows
the permissions a person holds
(`docs/SDD-identity-and-permissions.md` §3.3).

| | Operator mode | User mode |
| --- | --- | --- |
| Who | holds `harness.manage`, `mcp.register` or `policy.edit` | everyone else |
| Front door | **+ New** card, lanes | **Start work** from a goal, one list |
| Vocabulary | the machine's | the work's |
| Setup | all six Setup screens | none, until something needs attention |
| Failure | status, output, router decision | named cause and the next action |

A person may switch to operator mode if their permissions allow it; nobody
is ever switched into it automatically. A workstream owner who wants to
see the router's reasoning can, and that is where `bun run why` belongs
on screen.

## 4. Design

### 4.1 The goal front door

**Start work** takes: a goal in a sentence or two, the project, optionally
a ticket key, optionally acceptance criteria. It does not take a tier, a
model, a harness, labels or a repository path.

Wissel plans it: the planner proposes the pieces of work, each with a
title, the files it expects to touch, what it may change, and what it
will cost. The user sees **the plan**, not the cards:

- each piece in a sentence, in order, with what it depends on;
- an estimate, in money and in wall-clock;
- what will happen without asking (open a draft pull request) and what
  will come back to them (the first review, any decision the policy
  reserves);
- **Start**, **Start without the last two**, or **Change the goal**.

Approving the plan is the only decision a user makes to begin. The cards
exist underneath; a user who never opens the detail view never meets one.

An empty plan, or one the router cannot staff, is a sentence saying what
is missing — "no agent here can change Python; add one or pick another
project" — never `no-match`.

### 4.2 Vocabulary

Rename in user mode only. The API, the database and operator mode keep
every current name.

| Internal | User mode |
| --- | --- |
| card, task | piece of work; the whole set is *work* |
| lane | stage |
| tier | what it may change: *reads only* / *can change code* |
| harness | account |
| worktree | its own copy of the repository |
| pushback | review round |
| escalated | needs you |
| no-match | nothing here can do this |
| routed to | doing it |
| merge gate | the project's checks |
| grant, extraAllowedTools | extra permission: *let it run `X`* |

Two rules behind the table. State the outcome, not the mechanism: "its own
copy of the repository, your checkout is untouched" rather than
"worktree". And never make a state the user's problem to interpret:
`pending-review` means "waiting for a reviewer", and the screen says which
reviewer.

### 4.3 The home screen is what needs you

**Needs you** exists already (`src/services/needs-you.ts`) and carries a
reason and tick-box steps. In user mode it is the home screen, and it is
grouped by what the person can do, not by what the machine wants:

- **Approve** — a plan, a grant of an extra command, a merge.
- **Answer** — a question from an agent or a reviewer, with the context
  quoted.
- **Decide** — a default already taken that they can flip, or a decision
  the policy reserved for them.
- **Review** — a pull request waiting on them personally.
- **Fix** — something that failed and needs a person, with the cause named.

Each item carries: one sentence of why it is here, the thing itself (the
diff, the question, the verdict, the failing command's last lines), the
two or three answers as buttons, and what each answer does next. Nothing
requires opening a drawer first, because a drawer is where attention goes
to die.

With the identity spec in place the list is filtered to what *this person*
may act on, which is the difference between a queue and a noticeboard.

"Nothing needs you" is a real state and looks like one: what is running,
when the next thing is likely to come back, and no invented busywork.

### 4.4 The workstream header

One line that answers "is this going well?" without reading anything else:
in flight, waiting on you, waiting on other people, merged today, blocked,
spend today against the budget, and when the channel was last read.

This is the digest (`src/services/wissel-digest.ts`), on screen, built from
Wissel's own data with no model call. It is also the only number-heavy
surface in user mode; everything else is work and decisions.

### 4.5 Decisions, with the alternative and Flip

A list of what was decided without asking: what, when, by whom — a person,
or the policy acting under a duty, naming the revision — the alternative
that was not taken, and **Flip**, which takes the alternative and posts
it.

Autonomy is acceptable to people who can see what it decided and undo it.
Today a `[DECISION]` is a line in a log nobody browses, and the first time
someone reads it is after a surprise.

### 4.6 Live work: progress, not transcript

The card drawer streams the agent's raw output. Keep it, behind **Show the
agent's output**. In front:

- what step it is on and for how long;
- which files it has touched;
- what it is waiting for, if anything;
- spend so far against the piece's estimate;
- **Stop**, which says what stopping leaves behind (the copy stays; nothing
  is pushed).

When it finishes, the summary is the report it wrote, in plain language —
what changed and how it was checked — not the diff. The diff is one click
away for anyone who wants it.

### 4.7 The trust panel

One panel, reachable from any piece of work and from any agent, answering
the four questions a cautious person actually has:

- **What may it change?** Reads only, or can change code; and in which
  project.
- **Where does it write?** Its own copy; your checkout is untouched;
  nothing merges without the project's checks passing.
- **What may it run and reach?** The commands it is allowed, the network
  hosts it may reach, and what it was refused last time.
- **What may it spend, and whose account?** The estimate, the cap, the
  account's owner.

Everything in it already exists — tiers, allowed tools, sandbox allow
rules, denial counts, harness owners, telemetry. It has never been
collected in one place at the moment someone has to decide.

### 4.8 The review screen

From `docs/SDD-human-review-loop.md`: pull requests by state, what each
waits on and who holds it, threads waiting on Wissel, and reviewer load
against the limit. For a user, the useful cut is "mine": what is waiting
on me, and what of mine is waiting on someone else.

### 4.9 First run

Six setup screens before anything happens is the current cost of entry.
Replace with a flow that ends in something working:

1. Point at a repository.
2. Wissel detects the accounts already authenticated on the host and says
   which it will use.
3. It runs one read-only piece of work — summarise this repository — so
   the first thing a person sees is a result, not a form.
4. Then: "this host can run N pieces of work at once; want write access to
   this repository turned on?"

`bun run team create <prefix>` already scaffolds a coordinator and three
specialists. That is the preset; it should be a button, not a command.
After first run, every Setup screen lives behind **Advanced** and only
surfaces itself when something it owns needs attention — an account signed
out, a server unreachable.

### 4.10 Errors that name the cause and the next action

Each failure class gets a sentence and a button. The mechanisms exist; the
presentation does not.

| What happened | What the user sees |
| --- | --- |
| merge gate failed | the command, its last lines, **Send it back for a fix** |
| no harness free | "the account is busy or signed out", **Use another account** |
| 429 session or spend limit | "resumes at 14:20, or raise the limit", whose account it is |
| sandbox refused a command | "it needs to run `X`, which it was not allowed", **Allow and retry** |
| conflict on merge | "`main` moved; the conflict is in these files", **Resolve it** |
| five review rounds | "the reviewer and the author disagree; a person should look" |
| nothing matched | "nothing here can do this; add an agent or pick another project" |

### 4.11 Phone width

Approvals and answers arrive when the person is away from the desk. The
home screen, the trust panel and the answer buttons work at phone width;
the operator console does not have to. Remote Control already carries the
live session; what is missing is the ability to answer without it.

## 5. What not to build

- Drag-and-drop lanes. Nobody drags work here; the machine moves it, and
  the pilot's own verdict on watching cards switch lanes was that it was
  overhead.
- Per-card tier, model and harness pickers in user mode. If a user has to
  choose a model, the planner has failed.
- A dashboard of agent counts, tokens and runs for users. Operators want
  it; users want "is it going well" and "what needs me".
- A chat window as the primary surface. The coordinator window is a
  conversation *and* a set of structured items; a bare chat box hides
  state the user needs to see.
- Progress bars over an estimate the machine cannot honour. Elapsed time
  and the current step are honest; a percentage is not.

## 6. Build order

1. Vocabulary in user mode, and the failure table (§4.2, §4.10). No new
   data, immediate effect, and it is the cheapest card on this page.
2. Needs you as the home screen, grouped by action, answerable in place.
3. The workstream header from the digest.
4. The trust panel, assembled from data that already exists.
5. Live work: progress in front, transcript behind.
6. Start work and the plan approval.
7. Decisions with Flip.
8. The review screen's "mine" cut.
9. First run, and Setup behind Advanced.
10. Phone width for the home screen and the trust panel.

Items 1 to 5 need nothing from the identity or coordinator specs. Items 2
and 8 get materially better once permissions exist, because the lists can
be filtered to what the person may act on.

## 7. Tests

- A user-mode render test asserts the forbidden vocabulary appears
  nowhere.
- Every entry in the failure table has a fixture, and each renders its
  named cause and its action button.
- Every Needs-you item kind renders its answers without a drawer.
- The trust panel's four answers are populated for a read-only agent, a
  write agent with extra grants, and an agent whose last run hit a
  refusal.
- Phone-width snapshot of the home screen and the trust panel.

## 8. Open questions

1. Is the mode derived from permissions alone, or does a workstream owner
   get a say for their members? Derived is simpler and can feel
   paternalistic.
2. Does **Start work** plan with a model call every time, or reuse a
   template when the goal matches a known shape? The first is better and
   costs money on every goal.
3. How much of the plan can a user change before it stops being a plan and
   becomes card editing by another name?
4. Does user mode need the Tickets view at all, or is the ticket just a
   field on a piece of work?
5. Where does Ask fit in user mode: the same box as **Start work**, or a
   separate thing? One box is friendlier and makes "answer a question"
   and "do some work" ambiguous.
