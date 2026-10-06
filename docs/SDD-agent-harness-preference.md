# SDD: Per-agent harness preference

Status: approved by Milton 2026-10-06 (build it; when no listed harness
is available, the task waits). Builds on the "a disabled harness stops
work" rule shipped in `d009c1c`
(docs/SDD-harness-enable-disable.md, Revision 2026-10-06).

## 1. Why

Which account or tool runs an agent is chosen automatically today:
`HarnessPool.acquire(tool)` (`src/core/harness-pool.ts:127`) takes the
least-loaded enabled harness for the executor's tool. The only control
is per card (`TaskCard.harnessOverride`). An agent can't say "run me on
the Adevinta account" or "keep me off the personal account", so all
Claude Code work lands on whichever account is least busy. That's how
the `claude` account's session limit got hit on 2026-10-04 while other
accounts sat idle or disabled.

## 2. Goal and measurable outcome

- An agent can declare an ordered list of harnesses in
  `agents/manifest.yaml`. Each run uses the first listed harness that is
  enabled and under capacity.
- **When none of the listed harnesses is available, the task waits**
  (Milton's decision). It's never moved to another account it didn't
  list, and never runs without a harness.
- Agents without a list behave exactly as today.
- **Outcome:** for every agent with a list, 100% of its runs land on a
  listed harness. Check with `telemetry.jsonl` `result` events
  (`agentId` + `harnessId`); the review must include that query. Held
  tasks are visible through the log line and `GET /agents`.

## 3. Design

### 3.1 Manifest field

`AgentDef.harnesses?: string[]`: harness ids from `harnesses.yaml`, in
preference order. Undefined or empty means no preference (today's
behavior).

```yaml
- id: implementer
  ...
  harnesses: [claude-adevinta, claude]
```

### 3.2 Validation: fail loud at startup

At server startup, once both the registry and the harness pool are
loaded (`src/api/server.ts` `createApp`), check every agent with a list:

- every id exists in the harness pool;
- every listed harness's `tool` matches the tool of the executor that
  handles the agent (`executor.harnessTool`, resolved through the same
  `canHandle` lookup `Orchestrator.process` uses).

Any violation stops startup with a message naming the agent and the bad
id, in the style of the existing duplicate-harness-id error. A disabled
listed harness is NOT an error; that's the normal "wait" case.

### 3.3 Optional per-harness capacity

`Harness.maxConcurrent?: number` in `harnesses.yaml`. When set, a harness
whose `activeCount` has reached it counts as busy and isn't picked.
Undefined means unlimited, as today. This gives "wait when busy" a real
meaning; without it a harness is never busy.

### 3.4 Selection

Extend `acquire(tool, harnessId?, preferred?)`, in this order:

1. `harnessId` (card `harnessOverride`): unchanged, still fails loud via
   `HarnessOverrideError` when unknown, disabled or the wrong tool. An
   override at capacity also fails loud. A human asking for a specific
   harness should hear that it's full, not wait silently.
2. `preferred` non-empty: the first id in list order that is enabled and
   under `maxConcurrent`. If none qualifies, return `undefined`. **Never
   fall through to an unlisted harness.**
3. No list: least-loaded among enabled harnesses for the tool that are
   under capacity (today's rule plus the capacity filter).

### 3.5 Waiting reuses today's hold

`d009c1c` added a hold in `Orchestrator.process`: before
`recordDecision`, `if (!harnesses.hasEnabled(tool))`, log once and
return so the task stays unrouted and the next sweep retries it. Replace
`hasEnabled(tool)` with `canAcquire(tool, agent.harnesses)`, which uses
the same selection rules as §3.4 without incrementing anything. The
mid-dispatch race guard (reset to inbox when `acquire()` returns
undefined) stays as it is.

The log line names why: `waiting: none of [claude-adevinta, claude]
enabled and under capacity` versus `waiting: no enabled claude-cli
harness`.

Wake-ups: enabling a harness already triggers a sweep (`d009c1c`).
Capacity frees when a run ends; `finishResult` moves the task, which
emits a board event, which triggers a sweep. Verify this with a test
rather than assuming it.

### 3.6 Pipeline steps

A pipeline step runs immediately and can't wait. Pass the agent's list
to `acquire()` in `pipeline-runner.ts:227`; when it returns undefined,
fail the step loud as `d009c1c` already does, naming the list.

### 3.7 Visibility

- `GET /agents` includes `harnesses` (it serves `AgentDef`, so this may
  come for free; confirm).
- The board's agent detail view shows the list. Card 2 covers this.
- `GET /harnesses` includes `maxConcurrent` when set.

## 4. Tests (gate lane)

1. Picks the first listed harness when it's enabled; skips a disabled
   first entry and picks the second.
2. All listed harnesses disabled: the task is held unrouted and never
   run, even though an unlisted harness for the same tool is enabled.
3. All listed harnesses at `maxConcurrent`: held; when a run finishes
   and frees capacity, the held task runs on the next sweep without
   being prompted.
4. No list: unchanged least-loaded pick; with `maxConcurrent`,
   at-capacity harnesses are skipped.
5. `harnessOverride` still wins over the list; an override at capacity
   fails loud.
6. Startup validation: unknown id, and a tool mismatch (e.g. a
   claude-cli agent listing `codex`), each stop startup with a clear
   message. A listed but disabled harness starts fine.
7. Pipeline step: the list is honored; nothing available fails the step
   loud.
8. Every real manifest entry without `harnesses` builds the same
   acquire call as before (loop over `Registry.load()`, assert no
   preference passed).

`bun run typecheck` clean, `bun test test/` 0 failures.

## 5. Eval / live check

After merge and restart, give one cheap agent (`quick-answer`) a list
of `[anthropic-api]`, disable that harness, create a `question` card,
and confirm it waits with 0 dispatches. Re-enable it and confirm it
runs on `anthropic-api`. Same procedure as the `d009c1c` live check.
Then run the §2 telemetry query.

## 6. Non-goals

- **Which agent goes on which account.** That's Milton's open decision
  (question 3 of 2026-10-06). This feature ships with no `harnesses`
  entries in the manifest, so behavior is unchanged until he fills them
  in.
- Editing the lists from the board UI. The manifest is the source of
  truth, the same as for models.
- Moving work to an unlisted harness when the listed ones are busy.
  Milton chose to wait.
- Per-agent model lists per harness. A harness `model` default already
  exists.

## 7. Build plan (wissel cards)

1. **Core:** §3.1-3.6 plus tests 1-8, and README / `harnesses.yaml`
   comment docs for `harnesses` and `maxConcurrent`. Labels: `code`.
2. **Visibility:** §3.7: the agent view lists preferred harnesses, the
   harness panel shows `maxConcurrent` and `active/max`. Asserted on
   real data in `test/board-html.test.ts` or e2e. Depends on card 1.
   Labels: `code`.
