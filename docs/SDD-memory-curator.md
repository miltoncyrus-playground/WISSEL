# SDD — Wiring memory-curator in: wissel learns from its own history

Status: **Phase 1 built and verified** (unit tests, no real `claude`/`codex`
process spawned — see §9). Phases 2+ (per-agent filtering, growth-ceiling
tooling) are explicitly out of scope for this pass — see §7. **Revised**:
schedule frequency lowered and a selectivity bar added to the curation
prompt — see §10. **Revised again**: prompt *injection* (§6's read side)
is now off by default behind `WISSEL_MEMORY_INJECTION` while Milton
rethinks how memory should reach agents — curation (this doc's trigger,
gather and persistence/write side) is unaffected and keeps running
exactly as described below. See `docs/SDD-memory-injection-toggle.md`.

## 1. Why

`memory-curator` has been declared in `agents/manifest.yaml` since it was
added, but nothing in wissel ever creates a task tagged for it. Every other
agent gets dispatched because *something* produces a task with overlapping
tags — a human filing a card, `spawnReviewerTask`, `maybeSpawnIntegrator`.
Memory curation has no such trigger: it isn't a response to any single
task, it's scheduled housekeeping over the *history* of tasks. Zero
dispatches ever means wissel never actually learns anything from its own
session history — every agent starts every run exactly as informed as the
last one, no matter how many tasks have gone through the board.

This closes that loop: something has to periodically look back over what's
happened, hand it to `memory-curator` for consolidation, and get the result
back in front of every future agent.

## 2. Goal

On a schedule, gather what's happened since the last curation run, run
`memory-curator` over it (deduped/consolidated against whatever's already
been curated), and inject the result into every subsequent agent's prompt.
No human has to remember to trigger this, and no agent has to go looking
for context from past runs — it's just there, the same way `task.body` is
just there.

## 3. Trigger — in-process scheduler (`src/core/memory-scheduler.ts`)

Own file, not stuffed into `orchestrator.ts` — that file is already the
choke point for task-lifecycle concerns (routing, execution, review
handoff); scheduling is a different concern with a different trigger
(wall-clock time, not board events), and mirrors the existing precedent of
`worktree.ts`/`harness-manifest.ts` being separate single-concern files
rather than orchestrator additions.

`startMemoryScheduler(opts)` wires a plain `setInterval` — no cron
library, no new dependency; a single periodic check is exactly what
`setInterval` is for, and wissel already runs as a long-lived `Bun.serve`
process, so there's no need for anything more durable than in-process
timer state. Gated behind two env vars, read in `src/api/server.ts`'s
`if (import.meta.main)` block, following the exact existing
`WISSEL_ORCHESTRATOR`/`WISSEL_EXECUTE_WRITE_TIER` pattern:

- `WISSEL_MEMORY_CURATION=1` — off by default. Nothing about memory
  curation runs unless this is explicitly set.
- `WISSEL_MEMORY_INTERVAL_HOURS` — default `24` (see §8.2). Only read
  once curation is enabled.

No new persistence for "when did this last run." `getLastMemoryCurationAt`
reads `telemetry.jsonl` fresh on every tick and finds the most recent
`{type: "result", agentId: "memory-curator"}` line's `at` timestamp.
Telemetry is already the durable, append-only record of every agent run —
adding a second "last ran" store would just be a second source of truth
that can drift from the first. No prior `memory-curator` result at all
reads as "never run," which `isMemoryCurationDue` treats as due right now.

The scheduler runs one check immediately on start, then again every
`intervalHours` — without the immediate check, a brand-new install (never
run, therefore immediately due) would sit idle for a full interval before
its first curation ever fired.

## 4. Gather step — deterministic, not an LLM call

`gatherSessionLessons(telemetryPath, board, since, memoryPath)` in the same
file. Per `CLAUDE.md`'s latent-vs-deterministic-space rule: assembling
"what happened since last time" from structured records (telemetry lines,
board rows) is the same-input-same-output kind of work that belongs in
code, not in a model call. Only the actual curation judgment — what to
keep, what to drop, how to phrase it — is `memory-curator`'s (the LLM's)
job.

Steps, all plain parsing/lookup, zero model calls:

1. Parse `telemetry.jsonl`, keep `{type: "result"}` lines with
   `at > since` (or every line, if `since` is undefined — never run
   before).
2. Collect the distinct `taskId`s from those lines, in order, deduped (a
   retried task can produce more than one telemetry line for the same
   task — it should only appear once in the gathered text).
3. For each `taskId`, look up its `TaskCard`/`TaskResult`/`RoutingDecision`
   via `board.get`/`board.getResult`/`board.getDecision`, and format a
   one-line summary: title, ok/summary, routing reason (when present),
   actual cost (when present), harness (when present).
4. Read the *current* `memory/lessons.md` (via `readMemoryLessons`, §6),
   if one exists, and include it verbatim ahead of the new session
   summaries. `memory-curator`'s job is to dedup/consolidate against what
   it's already written, not append blindly — it needs to see its own
   prior output to do that (see §8.3).

The result is a single plain-text block: existing memory (if any) + new
session summaries (or an explicit "no new sessions" line when nothing's
happened since the last run). That text becomes the auto-created task's
body — see §5.

## 5. Dispatch — task creation + `orchestrator.runNow`

When a tick finds curation due, `runMemoryCurationIfDue`:

1. Gathers the text (§4).
2. `board.create()`s a task titled "Curate session memory", body = the
   gathered text, `labels: ["memory", "housekeeping"]` — the same tags
   `memory-curator` itself declares in `agents/manifest.yaml`. No
   special-casing of the agent id anywhere in the scheduler: the real
   router dispatches this task to `memory-curator` via ordinary
   tag-overlap scoring, exactly like any human-filed card. A future
   second memory-writing agent that declares overlapping tags competes
   for the same dispatch through the same mechanism, unmodified.
3. Calls `orchestrator.runNow(task.id, executors)` — the exact path a
   human's board "Run now" click already uses (see `POST
   /tasks/:id/run`, `src/api/server.ts`). Not a new execution mechanism:
   whatever pool of executors wissel already runs manual tasks through
   (`manualExecutors` in `createApp`) is what memory curation runs
   through too.

## 6. Persistence — `finishResult` hook + prompt injection

> **Revision (`docs/SDD-memory-injection-toggle.md`):** the read side
> below is now gated behind `WISSEL_MEMORY_INJECTION`, off by default.
> §2's goal of injecting the result "into every subsequent agent's
> prompt" no longer holds unless that flag is explicitly set — the write
> side (persistence) is untouched and keeps running regardless.

**Write side** (`src/core/orchestrator.ts`, `finishResult`): the single
choke point every finished task already passes through, the same one
`autoMerge` extends (see `docs/SDD-worktree-isolation.md` §4/§6). When the
finishing agent's declared `outputs` (from its manifest entry) includes
`"memory-entries"`, `finishResult` writes `result.summary` to
`memory/lessons.md` wholesale via `writeMemoryLessons` — replacing
whatever was there, never appending. The LLM already did the
dedup/consolidation (§4 handed it the existing file specifically so it
could); writing the raw summary back is applying that compaction, not a
second compaction pass in code.

Keyed off the manifest's own `outputs` contract, not a hardcoded
`agentId === "memory-curator"` check — a future second memory-writing
agent needs zero orchestrator changes to plug into the same hook, only a
manifest entry declaring the same `outputs` value.

Because the finishing agent's raw final message becomes the literal file
content, its format is load-bearing in a way no other readonly agent's
output is — see `memory-curator`'s `outputContract` in
`agents/manifest.yaml`, which spells out "no preamble, no sign-off, first
character of your message is the first character of the file" explicitly,
and `AgentDef.outputContractFormat`, which is deliberately left `undefined`
for `memory-curator` (unlike `reviewer`'s `"review-verdict"`) — this isn't
a machine-parsed shape, just formatting discipline enforced by prompt
instruction, and `runClaude` trusts the raw message as-is either way (see
`src/executors/claude-cli.ts`).

**Read side** (`src/core/prompt.ts`, `buildAgentPrompt`): gains one more
optional parameter, `memory?: string`. When non-empty, an extra section —
"Lessons learned from prior sessions:" followed by the memory content
verbatim — is appended to every agent's prompt, after the task framing and
before any `outputContract`/`verificationContract` block. `buildAgentPrompt`
itself stays pure and file-I/O-free; every caller (`runClaude`,
`src/executors/claude-cli.ts`; `runCodex`, `src/executors/codex-cli.ts`)
reads `memory/lessons.md` once via `readMemoryLessons` (cheap, local, no
network) and passes the content through. No file exists yet (the common
case before the first curation run) reads as `undefined`, and the section
is omitted entirely — nothing to regress on a fresh install.

## 7. What this deliberately does NOT do (non-goals for Phase 1)

- **No per-agent filtering.** Every agent gets the exact same
  `memory/lessons.md` content, verbatim, regardless of its tier or
  domain. A future pass could scope memory by agent/tag if the single
  global file turns out to accumulate advice that's only relevant to one
  agent, but that's speculative until the file actually exists and grows
  — building filtering logic against a file with zero real entries would
  be designing against a hypothetical.
- **No growth ceiling / truncation.** See §8.3 — no hard cap in Phase 1.
- **No new persistence layer for scheduler state.** "Last ran" is read
  from telemetry every tick (§3); there is no separate
  `memory-scheduler-state.json` or similar to keep in sync.
- **No cross-repo memory.** See §8.1 — one global file, not one per
  repo, and Phase 1 does nothing to reconcile or merge memory across
  independent wissel installs.
- **No new execution mechanism.** Curation runs through the exact same
  `orchestrator.runNow` + executor pool every other manually-dispatched
  task already uses (§5) — no dedicated "curator runner."

## 8. Open questions — resolved by Milton before this build

### 8.1 Memory scope

**Global, one file** — `memory/lessons.md` at the repo root, not
per-repo. wissel's own session history (which agents got picked, what
failed, what worked) is a property of *wissel itself*, not of whichever
repo a given task happened to touch — a lesson learned while fixing a bug
in one repo ("the reviewer keeps rejecting missing test coverage") is
exactly as useful on the next unrelated repo. A per-repo file would
fragment that history for no benefit and cost real complexity (which repo
does a cross-repo curation task even belong to).

### 8.2 Default interval

**24 hours** — `WISSEL_MEMORY_INTERVAL_HOURS` defaults to `24` (see §3).
Frequent enough that lessons from a day's worth of sessions reach agents
the next day; infrequent enough that a single curation run has a
meaningful batch of sessions to work with instead of re-running over
near-identical, mostly-empty diffs every few minutes. Overridable per
install if a busier or quieter cadence turns out to fit better.

### 8.3 Growth ceiling

**No hard cap for v1.** Trust the curation prompt's own compaction
discipline — `memory-curator`'s whole job (per its `outputContract` in
`agents/manifest.yaml`) is to dedup and consolidate against the existing
file, not just append to it (§4, §6). A hard byte/line cap would be
solving a problem that hasn't been observed yet, and picking the right
number (and the right truncation strategy — oldest-first? least-recently-
useful? a second summarization pass?) needs real data on how the file
actually grows in practice. Revisit only if the file demonstrably drifts
— unbounded growth, stale/contradictory entries surviving multiple
curation passes, etc.

## 9. Phase 1 — exactly what's built

- `src/core/memory-scheduler.ts` — `startMemoryScheduler`,
  `runMemoryCurationIfDue`, `isMemoryCurationDue`,
  `getLastMemoryCurationAt`, `gatherSessionLessons` (§3, §4, §5).
- `src/services/memory.ts` — `DEFAULT_MEMORY_PATH`
  (`"memory/lessons.md"`), `readMemoryLessons`, `writeMemoryLessons` (§6).
- `finishResult` (`src/core/orchestrator.ts`) — the
  `outputs.includes("memory-entries")` persistence hook (§6).
- `buildAgentPrompt` (`src/core/prompt.ts`) — the optional memory section,
  threaded through `runClaude`/`runCodex` (§6).
- `agents/manifest.yaml` — `memory-curator`'s `outputContract`, spelling
  out the wholesale-replacement contract in prose (§6).
- `src/api/server.ts` — `WISSEL_MEMORY_CURATION` /
  `WISSEL_MEMORY_INTERVAL_HOURS` bootstrap wiring, following the existing
  `WISSEL_ORCHESTRATOR`/`WISSEL_EXECUTE_WRITE_TIER` pattern (§3).

Tests (same commit, no real `claude`/`codex` process spawned anywhere):

- `test/memory-scheduler.test.ts` — due-ness (never-ran-is-due,
  interval-not-yet-elapsed), `gatherSessionLessons` (never-run gathers
  everything, `since` filters correctly, current-memory-file inclusion,
  taskId dedup, no-telemetry-file-yet), and the full
  `runMemoryCurationIfDue` cycle against a fake executor.
- `test/orchestrator.test.ts` — `finishResult`'s memory-persistence hook:
  persists for an agent declaring `outputs: ["memory-entries"]`, replaces
  wholesale on a second run, does nothing for every other agent.
- `test/prompt.test.ts` — memory section omitted when no content is
  given, included verbatim (ahead of any output contract) when it is.

## 10. Revision — lower the schedule frequency, raise the selectivity bar

Two changes, both prompted by the same observation: a day of normal
wissel activity doesn't reliably produce a day's worth of genuinely
durable lessons, and a curator that runs daily with no selectivity
discipline beyond "dedup against the existing file" tends to promote
routine activity-log noise just because something ran since last time.

### 10.1 Schedule — 3x/week instead of daily

`WISSEL_MEMORY_INTERVAL_HOURS` is now set to `56` (roughly every 56
hours — about 3 times a week) instead of the §8.2 default of `24`. No
code changed for this: `src/api/server.ts`'s existing bootstrap read of
`process.env.WISSEL_MEMORY_INTERVAL_HOURS` (§3) already honors any
override, and `isMemoryCurationDue` (§3) already treats "due" purely as
elapsed-time-since-last-run — both were correct for this on day one.
This is a config change (`.env`), not a design change, and §8.2's
reasoning for *why* an interval exists at all (infrequent enough that a
batch has a meaningful amount of real session activity to work with)
still holds; `56` is just a different point on that same tradeoff,
chosen because daily cadence was producing near-empty or noise-only
batches more often than batches with real structural findings.

### 10.2 Selectivity — a concrete bar for NEW candidate lessons

Before this revision, `memory-curator`'s `outputContract`
(`agents/manifest.yaml`) only instructed the agent how to merge a new
batch against the *existing* `memory/lessons.md` file (dedup, drop
stale/superseded entries — §6, §8.3). It said nothing about how
selectively to judge whether a brand-new observation from the current
batch deserves to become a persistent lesson in the first place. In
practice this meant anything that happened to be novel relative to the
existing file could get promoted, even when it was just today's work
going fine.

The `outputContract` now adds an explicit "Selectivity bar" section,
additive to (not a replacement for) the existing dedup-against-prior-
file instruction, the ELI5-plus-detail two-part topic shape, and the
"no preamble, byte-for-byte replacement" formatting rules — none of
those changed. The new section poses one concrete test for any
candidate lesson: would a fresh agent session, with zero context beyond
this file, actually change what it does because of this — avoid a real
mistake, respect a real constraint, or know where to look instead of
re-discovering it the hard way? It then names four anti-patterns to
reject explicitly, rather than leaving "be selective" as an
unenforceable platitude:

- a routine success with nothing surprising in it,
- a one-off fact specific to a single session's circumstances with no
  generalizable lesson,
- something already fully obvious from the code/docs a fresh agent
  would read anyway,
- a near-duplicate of an existing topic worded differently (a dedup
  failure, not a new lesson).

The section explicitly states that an empty or near-empty batch with
nothing worth promoting is a normal, expected outcome — the opposite of
the pre-revision incentive, where running meant something had to be
written.

### 10.3 Verification

`eval/memory-curation-quality.eval.ts` (new, see eval/README.md's own
section on it) is the periodic quality eval for this: a real
`memory-curator` run against a deliberately mixed fixture (4 durable
lessons tied to concrete code symbols, 4 noise entries matching the
anti-patterns above), checked against a deterministic rubric for
whether the durable entries survived and the noise didn't. This is a
genuine latent-space judgment question per CLAUDE.md's own rule, so it
belongs in the paid/periodic eval lane, not `bun test`'s gate lane.

**Two bugs found and fixed in review; both confirmed closed by a real
clean run.**

1. **Contamination bug (fixed, confirmed clean by a real run).**
   `ReadOnlyExecutor` had no `memoryPath` override, so it read this
   repo's real `memory/lessons.md` into the prompt instead of the
   fixture's own fake "Current memory/lessons.md" text — the curated
   output contained real lessons like "`parentTaskId` is overloaded"
   that don't exist in the fixture at all. Fixed by writing the
   fixture's fake memory to an isolated tmp file and pointing
   `memoryPath` at it, the same pattern every other memory-touching
   test in this repo already uses. A later review pass re-ran the eval
   for real and confirmed the curated output has zero leakage from the
   real repo lessons file — only fixture content appears.
2. **Marker-brittleness bug (fixed, confirmed clean by a real run).**
   With the contamination bug fixed, a real run still produced
   `OVERALL: FAIL` (durable kept 2/4) — but this was a false negative
   in the eval's own rubric, not a selectivity-bar defect. The real
   curator kept both affected durable lessons verbatim but wrapped the
   code identifier in markdown backticks (e.g. "`waitForSelector`
   timeout"), which broke the rubric's plain substring check
   (`output.includes(e.marker)`) even though the underlying identifier
   survived intact. Fixed by stripping backticks from the output
   before the substring comparison (`eval/memory-curation-quality.eval.ts`'s
   `strippedOutput`), since none of the markers themselves contain
   backticks.

A real clean run of `bun run eval:memory-curation-quality` after both
fixes landed produced `OVERALL: PASS` — durable kept 4/4, noise dropped
4/4, format discipline PASS, cost $0.0860 — with zero leakage from this
repo's real `memory/lessons.md` (no "`parentTaskId` is overloaded", no
"SQLite schema changes" in the output). Both bugs are closed on
empirical evidence, not just by inspection.
