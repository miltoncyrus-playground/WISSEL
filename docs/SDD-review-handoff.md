# SDD — Automated implementer→reviewer handoff

Status: **Built** (Subtasks A–E, H of planner task
`8e6d3381-e951-40c9-9ff1-3240769ecd69`). Every transition and endpoint
documented below is cross-checked line-for-line against the shipped
source (`src/core/orchestrator.ts`, `src/core/types.ts`,
`src/services/board.ts`, `src/api/server.ts`,
`src/api/public/board.html`) and its test assertions
(`test/orchestrator-review-lifecycle.test.ts`, `test/api.test.ts`,
`test/board.test.ts`, `test/parse-review-verdict.test.ts`,
`e2e/board.spec.ts`) as of this doc's commit. This pass reads the code
and tests; it does not itself re-run the suite — see §8 for exactly
what's covered where.

## 1. Goal

Give a write-tier agent a way to get automated push-back on its own
work before a human ever sees it, without changing the human review
gate itself. Today that agent is `implementer` (`agents/manifest.yaml`),
but the mechanism is generic: any write-tier agent that lists
`reviewer` in its own `handoffs` gets this behavior, for free, with no
code changes. See the comment on `reviewer.outputContract` and on
`implementer.handoffs` in `agents/manifest.yaml`.

## 2. `TaskCard.status` — the full state machine

Ten values total (`src/core/types.ts`). The eight that predate this
feature (`inbox`, `ready`, `running`, `dispatched`, `done`, `failed`,
`no-match`, `review`) are unchanged; `pending-review` and `escalated`
are new.

| Status | Meaning |
|---|---|
| `inbox` / `ready` | Unrouted, eligible for `Orchestrator.sweep()`. |
| `running` | wissel is executing it locally (readonly, or write-tier with `executeWriteTier`/`runNow`). |
| `dispatched` | Routed to a write-tier agent and handed off; wissel waits for `POST /tasks/:id/result`. |
| `review` | A write-tier success (or an approved review) waiting for a human. Pre-existing gate, untouched by this feature. |
| `pending-review` | A write-tier success whose agent declared `reviewer` in `handoffs` — queued for an automated reviewer pass instead of a human. **New.** |
| `escalated` | A reviewer rejected the same lineage `pushbackCount >= 5` times running; a human takes over. **New.** |
| `done` | Terminal success. |
| `failed` | Terminal failure (including "reviewer violated its own output contract", "human abandoned an escalation"). |
| `no-match` | Routing stopped before spend; nothing matched confidently. |

### 2.1 Entry into `pending-review`

`finishResult` (`orchestrator.ts:37`) is the single choke point every
finished task passes through, regardless of whether wissel ran it
locally or an external runner reported it back via `POST
/tasks/:id/result`. Order of checks, exactly as coded:

1. `!result.ok` → `failed`. Always checked first, before tier or
   verdict — a reviewer run that violates its own output contract
   (§3) is `ok: false`, so it lands the **reviewer task itself** on
   `failed` here, never on `done` despite being readonly-tier.
2. `result.verdict !== undefined` → this is a reviewer pass reporting
   back; hands off entirely to `handleReviewVerdict` (§2.2) and
   returns. Bypasses every check below.
3. `agent.tier !== "write"` → `done`. Ordinary readonly-tier success.
4. `agent.handoffs?.includes("reviewer")` → `pending-review`, plus
   `spawnReviewerTask` creates a new reviewer `TaskCard` (status
   `inbox`, `parentTaskId` = the implementer task's id,
   `reviewLineageId` = the implementer task's own id if this is the
   first pass in the lineage, `labels: ["review"]`, `repo` = the
   implementer's worktree path if it ran in one). **This is the new
   branch.**
5. `agent.autoMerge && agent.trustLevel === "high"` and the merge
   actually succeeds (`tryAutoMerge`) → `done`. Pre-existing
   (`docs/SDD-worktree-isolation.md` §4), unaffected by this feature.
6. Otherwise → `review`. The pre-existing human gate.

Branches 4 and 5 are mutually exclusive per agent in practice — an
agent that declares `handoffs: [reviewer]` returns from branch 4
before branch 5 is ever reached, so `autoMerge` and the reviewer
handoff don't compose for the *implementer's own* success. They do
compose for an *approved* review (§2.3): `resumeAfterApproval` runs
the same `autoMerge` check separately once the verdict comes back.

### 2.2 `handleReviewVerdict` — the only reader of `TaskResult.verdict`

(`orchestrator.ts:141`) Runs once a reviewer task's own run finishes
successfully (`result.verdict` set — see §3). Steps:

1. Marks the reviewer task itself `done` — its job ends the moment it
   reports a verdict, either way.
2. If it has no `parentTaskId`, or the parent task no longer exists
   (deleted mid-run), stops there.
3. `verdict === "approve"` → `resumeAfterApproval` (§2.3).
4. `verdict === "changes_requested"` and the implementer task's
   current `pushbackCount` (default 0) is `< 5` →
   `spawnPushbackImplementer` (§4.2): a new implementer `TaskCard` in
   `inbox`, same title/labels/repo, `pushbackCount` incremented,
   `parentTaskId` = the reviewer task's id (not the superseded
   implementer's id — this is what lets the re-attempt inherit the
   reviewer's own `handoffs` via `resolveHandoffAllowlist`, since
   `reviewer` declares none itself, so it actually resolves to
   *unrestricted*, i.e. normal label-based routing). The superseded
   implementer task gets `supersededBy` set to the new attempt's id
   — **its `status` is left exactly as it was (`pending-review`),
   never touched.** See §7 for what this means for the board view.
5. `verdict === "changes_requested"` and `pushbackCount >= 5` →
   `board.escalate(implementerTask.id, escalationContext)` moves the
   implementer task straight to `escalated`, with `escalationContext`
   built by `buildEscalationContext` (§4.3). No 7th implementer
   attempt is ever spawned.

Six is the effective cap on implementer attempts per lineage:
`pushbackCount` runs 0 through 5 (attempts 1–6), and the 6th
rejection escalates attempt 6 itself rather than spawning a 7th.
Confirmed by `test/orchestrator-review-lifecycle.test.ts`'s "6
consecutive rejections escalate instead of spawning a 7th
implementer task" case.

### 2.3 `resumeAfterApproval`

(`orchestrator.ts:177`) An approved review resumes exactly the
done-vs-review policy `finishResult` would have applied to the
implementer's own success, had it not been deferred into
`pending-review` to wait for the reviewer: same `autoMerge` +
`trustLevel: "high"` fast path (reading the implementer's *own*
routed agent and its *own* recorded result, not the reviewer's), same
`tryAutoMerge` mechanics, same fallback to `review` for a human.

### 2.4 Escalation resolution (Subtask D)

An `escalated` task only moves again through one of three human
actions, `POST /tasks/:id/escalation/<action>` (`server.ts:297`, all
400 if the task isn't currently `escalated`):

| Action | Request body | Response | Effect |
|---|---|---|---|
| `approve` | `{ actor, reason }` (both required, 400 if missing) | `200`, the updated `TaskCard` | `board.recordOverride(id, "escalated", "review", actor, reason)` (audited, same override log as a router override — surfaces on the SSE stream as `task.override`), then `board.move(id, "review")`. Forces the task into the normal human-review gate despite the reviewer's unresolved objections. |
| `abandon` | none | `200`, the updated `TaskCard` | `board.move(id, "failed")`. Terminal — closest existing status for "a human looked and it's not worth pursuing." |
| `retry` | `{ body }` (required, 400 if missing) | `201`, the **new** `TaskCard` | Creates a fresh implementer task: same title/labels/repo, `body` = the human-edited instructions, `pushbackCount: 0`, a **brand-new** `reviewLineageId` (never the exhausted one). The old escalated card gets `supersededBy` set to the new task's id; **its `status` stays `escalated`**, same "never repurpose status" contract as §2.2 step 4. |

Response shape note: all three return the raw `TaskCard` JSON directly
(`json(moved)` / `json(nextAttempt, 201)`), not wrapped in `{ task:
... }`. (`board.html`'s inline comment above `renderDrawerActions`'
escalated branch describes a `{ task }` wrapper — that comment is
stale; the board UI itself doesn't depend on the wrapper, since
`escalationAction` only checks `r.ok` and then calls `refetchTasks()`,
never reading the response body's shape.)

Confirmed by `test/api.test.ts`'s three `POST
/tasks/:id/escalation/*` cases (status codes, 400s, the audit trail on
`approve`, the superseded-not-resurrected old card on `retry`).

## 3. The reviewer's output contract

`AgentDef.outputContract` (`types.ts`) is an optional, agent-specific,
machine-parseable contract string, appended verbatim to the end of the
prompt by `buildAgentPrompt` (`prompt.ts`) when present. Today only
`reviewer` sets it (`agents/manifest.yaml`): its final message must end
with a fenced ```` ```review-verdict ```` block containing
`{"verdict": "approve" | "changes_requested", "feedback": "..."}` and
nothing after it.

`parseReviewVerdict` (`src/executors/parse-review-verdict.ts`) is the
only code allowed to turn raw claude output into a `ReviewVerdict`. It
takes the **last** ```` ```review-verdict ```` block in the text (a
model "thinking out loud" with an earlier example block is handled),
parses it as strict JSON, and requires `verdict` to be exactly
`"approve"` or `"changes_requested"` and `feedback` to be a string.
Anything else (missing block, malformed JSON, wrong verdict value,
missing feedback) returns `null` — it never guesses `"approve"` as a
safe default.

`claude-cli.ts`'s executor wires this in: when the agent has an
`outputContract` and the run otherwise "succeeded" (`!parsed.is_error`)
but `parseReviewVerdict` returns `null`, the executor **overrides `ok`
to `false`** and writes a summary explaining the contract was
violated. A reviewer producing prose instead of the fenced block is
therefore a failed run, not a silently-approved one — see §2.1 step 1
for what that does to the reviewer task's own status, and §8 for the
parent implementer task's fate when this happens.

On success, `verdict`/`reviewFeedback` are flattened directly onto
`TaskResult` (not left nested), which is what lets `finishResult` read
`result.verdict` without a second lookup.

## 4. Lineage and pushback bookkeeping (`TaskCard` fields, `types.ts`)

- **`reviewLineageId`** — groups every attempt in one review-pushback
  chain (the original attempt plus every re-attempt spawned by
  `changes_requested`) under one id, set on the first attempt and
  carried forward by every re-attempt. Deliberately reuses the
  *original implementer task's own id* rather than minting a separate
  one (`spawnReviewerTask`, §2.1) — this is what makes worktree reuse
  fall out for free, since `WriteExecutor`/`CodexWriteExecutor` key a
  pushback re-attempt's worktree off `task.reviewLineageId ?? task.id`.
- **`pushbackCount`** — how many times a reviewer has sent this
  lineage back with `changes_requested`. `undefined`/`0` means never
  pushed back. Scoped to the review loop specifically, distinct from
  any execution-failure retry count.
- **`supersededBy`** — id of the re-attempt `TaskCard` that replaced
  this one, set only on the superseded (old) card, **status left
  untouched** in every case in this feature (§2.2, §2.4). `Board`
  emits `task.superseded` on the SSE stream when this is set
  (`board.ts:315`).
- **`escalationContext`** — why a task landed on `escalated` instead
  of another pushback round. Set atomically with the status change by
  `Board.escalate` (`board.ts:319`) — there's no valid intermediate
  state where a task is `escalated` without one.

### 4.1 `spawnReviewerTask` (`orchestrator.ts:118`)

Also worth calling out: `labels: ["review"]` on the spawned reviewer
task is load-bearing, not decorative. `resolveHandoffAllowlist`
restricts the follow-up's routing candidates to exactly the
implementer's declared `handoffs` (here, `["reviewer"]`), but the
router still requires a positive tag-overlap score to route with
confidence. `"review"` is one of `reviewer`'s declared tags in
`agents/manifest.yaml`, so this always scores a confident match; zero
labels (or a label `reviewer` doesn't tag) would land the reviewer
task on `no-match` even though `reviewer` is the only eligible
candidate.

### 4.2 `spawnPushbackImplementer` (`orchestrator.ts:203`)

The reviewer's feedback is appended to the next attempt's `body` as a
clearly delimited, cumulative section — attempt N's body carries every
prior round's feedback, not just the latest, under a `---\nReviewer
feedback (attempt N):` header.

### 4.3 `buildEscalationContext` (`orchestrator.ts:230`)

Walks `board.getLineage(reviewLineageId)` (every `TaskCard` sharing
that lineage id, creation order), filters to the reviewer cards
specifically (`card.routedTo === "reviewer"`), and reads each one's
own recorded result for the feedback it left behind — producing the
full ordered history (`"Attempt 1: ...\n\nAttempt 2: ..."`) a human
reads on an escalated card instead of replaying the whole `TaskCard`
chain by hand.

## 5. `resolveHandoffAllowlist` (`orchestrator.ts:266`)

Not new to this feature (it predates the reviewer handoff), but this
is what actually enforces "a pushback re-attempt can only route back
to what the reviewer itself is allowed to hand off to." Resolves a
follow-up task's candidate allowlist from its `parentTaskId`'s routed
agent's declared `handoffs`. Since `reviewer` declares no `handoffs`
field at all in `agents/manifest.yaml`, this resolves to `undefined`
(unrestricted) for a pushback re-attempt — it routes through the full
registry via ordinary label matching, same as any other unrestricted
task, which is what lands it back on `implementer` in practice (same
`labels` as the original).

## 6. Board UI (Subtasks E, H — `src/api/public/board.html`)

- **Columns**: `COLUMNS` includes `pending-review` (between
  `dispatched` and `review`) and `escalated` (between `review` and
  `done`) in the board's rendered order.
- **`pending-review` card**: no action buttons (no Merge/Discard/Mark
  done — an automated pass is still in flight against this exact
  attempt). Shows "Automated review in progress (attempt N of 6)",
  `N = (pushbackCount || 0) + 1`.
- **`escalated` card**: shows the full ordered rejection history
  (`escalationContext`, parsed into rounds) and three actions wired to
  §2.4's endpoints — **Approve anyway** (prompts for actor + reason,
  `POST .../escalation/approve`), **Retry** (opens an inline textarea
  for edited instructions, `POST .../escalation/retry`), **Abandon**
  (confirms, `POST .../escalation/abandon`).
- **Subtask H fix**: the escalation action buttons originally sent no
  request body at all (`fetch(..., { method: "POST" })` with no
  `body`/`content-type`), so `approve`'s required `{ actor, reason }`
  and `retry`'s required `{ body }` always 400'd server-side. Fixed by
  `escalationAction` (`board.html:880`) conditionally attaching
  `headers`/`body` only when a body object is passed in (`abandon`
  correctly passes none).

## 7. What this deliberately does NOT do / known gaps

- **A superseded `pending-review` (or `escalated`) card is not
  auto-hidden or auto-moved.** `supersededBy` is set, but `status` is
  deliberately left untouched (§2.2, §2.4) — and `board.html` doesn't
  filter by `supersededBy` when rendering columns. A superseded card
  stays visible in its original column indefinitely, showing a status
  that's no longer the live truth for that lineage. The live attempt
  is always the newest `TaskCard` in the chain (walk `supersededBy`
  forward, or read `reviewLineageId` + `getLineage`); a human reading
  the board directly has to know to check for `supersededBy` before
  trusting a `pending-review`/`escalated` card's status at face value.
- **A reviewer contract violation orphans the implementer task.** If
  the reviewer's own run fails (§3 — malformed output contract, or any
  other executor failure), `finishResult`'s `!result.ok` check
  (§2.1 step 1) moves *only the reviewer task* to `failed`; it never
  touches the parent implementer task, which stays on `pending-review`
  with no automated retry triggered (`sweep()` only ever picks up
  `inbox`/`ready` tasks). The one built-in recovery path is manual:
  the board drawer's "Run now" button (`board.html:729`) calls `POST
  /tasks/:id/run` → `Orchestrator.runNow`, which only checks
  `inFlight`/existence/`supersededBy` — not current `status` — so
  clicking it on a stuck `pending-review` card re-routes and re-runs
  it directly, same as any other card. There's no dedicated
  "reviewer crashed, requeue automatically" mechanism.
- **`runNow`/`POST /tasks/:id/run` bypasses the pushback cap.** It's
  an explicit per-task click, not the automatic loop, so it can be
  used to force-rerun a task regardless of where it sits in a review
  lineage. Not a bug: `sweep()` (the automatic loop) is the only thing
  the 5-pushback/6-attempt cap actually gates.
- **No cap on total wall-clock or cost for a lineage.** The 6-attempt
  cap bounds the *count* of automated round-trips, not how long they
  take or what they cost in aggregate; `TelemetryLog` records each
  dispatch/result individually (`orchestrator.ts:45,438`) but nothing
  in this feature rolls that up per-lineage.

## 8. Testing

- `test/parse-review-verdict.test.ts` — the parser: valid
  approve/changes_requested, "last block wins" with a model that
  echoes an example first, every malformed-input case returning
  `null` rather than guessing.
- `test/prompt.test.ts` — `buildAgentPrompt` appends `outputContract`
  verbatim as a trailing block when present, omits it entirely when
  not.
- `test/claude-cli.test.ts` — the executor: a valid verdict block
  flattens onto `TaskResult`; a missing/malformed one flips `ok` to
  `false` with an explanatory summary, never defaults to approve.
- `test/orchestrator-review-lifecycle.test.ts` — the full lifecycle
  against a fake `CommandRunner` (no real git spawned): implementer
  success → `pending-review` with a reviewer task auto-created within
  one sweep (correct `parentTaskId`/`reviewLineageId`/`repo`); a
  write-tier agent with no reviewer handoff keeps the original review
  gate unchanged (regression guard); approve resumes to `review`; approve
  + `autoMerge`/`trustLevel: "high"` resumes straight to `done` with a
  real git merge; `changes_requested` spawns a pushback implementer
  with cumulative feedback in its body, reusing the same worktree; 5
  consecutive rejections produce exactly `pushbackCount` 1..5; the 6th
  rejection escalates instead of spawning a 7th attempt, with the full
  ordered feedback history; `runNow` rejects a click on a superseded
  task.
- `test/api.test.ts` — all three `POST /tasks/:id/escalation/*`
  endpoints: happy path, status codes, 400 when not escalated, 404 on
  unknown id, the audited override on `approve`, the superseded-not-
  resurrected old card on `retry`.
- `test/board.test.ts` — `escalate`/`getLineage`/`supersededBy` at the
  `Board` layer directly, including the `escalationContext` round-trip
  through SQLite.
- `e2e/board.spec.ts` — the board UI: `pending-review`/`escalated`
  columns render, the escalated drawer's three actions post the
  correct request bodies (this is the suite the Subtask H fix
  corrected).
