# SDD — Visibility into subagents spawned by claude-cli agents

Status: **Built.** `ClaudeResultJson.subagent_stats` → `TaskResult.subagents`
→ a new `task_results.subagents` column → a new line in the drawer's
Result section, exactly as designed in §3-§5. 200/200 tests pass,
typecheck clean, confirmed live serving from the running dev server. The
two live spikes in §2 (schema already present, spawning not blocked
under `acceptEdits`) were the real verification — this build is a direct
translation of that already-confirmed data, not new discovery.

## 1. Goal

Confirmed last turn: `implementer`/`fixer`/`integrator` (any claude-cli
write-tier agent) can structurally spawn subagents — wissel applies no
tool restriction, and `toolAccess` on `AgentDef` is purely declarative,
read by nothing. This SDD adds the visibility you asked for: a
"Spawned Sub Agents" field on a task's result, so a subagent spawn isn't
invisible the way it was for the `codex-cli` harness task earlier in
this session (I had to read a raw session transcript file by hand to
answer "did this use subagents" — that shouldn't require manual log
spelunking).

## 2. Correction to what I told you last turn

I said getting this data would mean switching `runClaude` from
`--output-format json` to `--output-format stream-json` — parsing a
full event stream instead of one summary object, a real change to a
parsing path that already works. **That was wrong, and a live spike
(not another guess) found the actual, much smaller answer**:

Ran `claude -p --output-format json` for real (the exact format
`runClaude` already uses, unchanged) and found the terminal result
object **already includes a `subagent_stats` field** — no format switch
needed at all:

```json
"subagent_stats": {
  "spawned": 0,
  "requested": {"background": 0, "foreground": 0, "unset": 0},
  "started_in_background": 0,
  "max_depth": 0,
  "spawned_by_subagents": 0,
  "completed": 0,
  "failed": 0,
  "killed": {"parent": 0, "user": 0, "system": 0},
  "refused": {"depth_limit": 0, "concurrency_limit": 0, "budget": 0},
  "by_type": {}
}
```

Then ran a second spike that actually forced a subagent spawn, **under
`--permission-mode acceptEdits`** — the exact mode `WriteExecutor` runs
`implementer`/`fixer`/`integrator` under, not the default interactive
mode — to answer the real operational question, not just the schema
question: does spawning a subagent hit the same wall Bash does under
`acceptEdits` (confirmed elsewhere in this session: Bash is fully
denied there)? **It doesn't.** The spawn succeeded cleanly, zero
permission denials:

```json
"is_error": false,
"permission_denials": [],
"subagent_stats": {
  "spawned": 1,
  "requested": {"background": 0, "foreground": 1, "unset": 0},
  "max_depth": 1,
  "completed": 1,
  "failed": 0,
  "by_type": {"general-purpose": 1}
}
```

This is a materially different — and better — finding than either of us
assumed going in: the data already exists in the exact output `runClaude`
already parses, and subagents aren't gated the way Bash is under the
permission mode these agents actually run under.

## 3. Data model

`src/executors/claude-cli.ts`'s `ClaudeResultJson` gains one field
(everything else in that interface is already a deliberately partial
read of the real object — same pattern continues):

```ts
interface ClaudeResultJson {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  permission_denials?: unknown[];
  total_cost_usd?: number;
  subagent_stats?: { spawned: number; failed: number; by_type: Record<string, number> };
}
```

`TaskResult` gains:

```ts
/** Subagents this run spawned (claude-cli only — see §7). Undefined
 *  when the harness/executor doesn't report this (codex-cli, dispatched
 *  work) or when it's exactly zero-and-uninteresting — set only when
 *  spawned > 0, so "no field" and "definitely spawned nothing" both
 *  read the same way the rest of TaskResult already treats absence. */
subagents?: { count: number; failed: number; byType: Record<string, number> };
```

`runClaude` sets it directly from `parsed.subagent_stats` when
`spawned > 0`:

```ts
const subagents = parsed.subagent_stats && parsed.subagent_stats.spawned > 0
  ? { count: parsed.subagent_stats.spawned, failed: parsed.subagent_stats.failed, byType: parsed.subagent_stats.by_type }
  : undefined;
```

No changes anywhere else in `runClaude` — `is_error`/`result`/
`permission_denials`/`total_cost_usd` parsing is completely untouched,
confirmed unaffected by both spikes above.

## 4. Persistence

Same pattern as `worktree`/`actualCost`/`harnessId` before it
(`board.ts`): a new `subagents TEXT` column on `task_results`
(`CREATE TABLE IF NOT EXISTS` for a fresh DB + the `ALTER TABLE ADD
COLUMN` healing loop for an existing one), JSON-serialized in
`recordResult`, parsed back in `getResult`.

## 5. UI: a field in the existing Result section, not a literal Kanban column

wissel's board columns are task **statuses** (Inbox/Ready/Running/...) —
a literal new status column doesn't fit what you're asking for.
Interpreting "column" as: a new labeled line in the task drawer's
existing Result card, the same place `worktree`/harness/cost already
render (`loadDrawerResult` in `board.html`) — "Spawned 1 subagent
(general-purpose)" or "Spawned 3 subagents (general-purpose: 2,
Explore: 1)", styled like the existing `.rc-artifacts` lines, red-tinted
if `failed > 0`.

**Not in this pass**: a glanceable badge directly on the kanban card
(visible without opening the drawer). Kanban cards render from
`TaskCard` alone today (`t.routedTo`/`t.repo`/`t.title`) — no
per-task result data reaches the card list at all currently, unlike the
drawer, which fetches a task's result lazily on open. Adding a card
badge means bulk-fetching result summaries alongside `/tasks` (a new
endpoint, or extending the existing one) — a real, separate piece of
work, not a one-line addition like the drawer field is. Flagging as a
deliberate v1 cut, not an oversight — easy to add as Phase 2 if the
drawer-only version turns out to be too easy to miss.

## 6. Non-goal: `codex-cli` parity

Not spiked here — `codex exec`'s JSONL stream (confirmed live for
`docs/SDD-codex-cli-harness.md`) was never checked for anything
subagent-equivalent, and Codex CLI's own subagent model (if it has one)
may not exist or may look completely different. `implementer`/`fixer`/
`integrator` all route through claude-cli today (`executor: "handoff"`,
no agent declares `executor: "codex"` yet — confirmed, `agents/
manifest.yaml` has none), so this doesn't block what you actually asked
about. A `codex-cli` equivalent is its own spike whenever a codex-routed
write-tier agent actually exists.

## 7. Phased plan

One phase — nothing here is blocked on anything else, both real
uncertainties (does the field exist, does `acceptEdits` block spawning)
are already resolved by §2's live spikes, not deferred to a build-time
surprise the way the `codex-cli` SDD's flag placement was.

- `ClaudeResultJson.subagent_stats` + `TaskResult.subagents`
  (`types.ts`, `claude-cli.ts`).
- `task_results.subagents` column + `recordResult`/`getResult`
  (`board.ts`) — mirrors the `worktree` column added for
  `SDD-worktree-isolation.md`, same healing-migration shape.
- `board.html`: new line in the drawer's Result section (§5).

**Tests**: `test/claude-cli.test.ts`-style fake-`CommandRunner` cases —
`spawned: 0` produces no `subagents` field, `spawned: 2` with a
populated `by_type` round-trips correctly, `failed > 0` is preserved.
`board.test.ts` round-trip case mirroring the existing `worktree`/
`actualCost` ones. No real `claude` process in any test — same
discipline as everywhere else; the two live spikes above are the
verification, done once by hand, not re-run per test.

## 8. What I need from you

Nothing blocking — confirm the drawer-field placement (§5) is what you
meant by "column," and whether the kanban-card-badge (§5's cut) is
worth scoping in now or genuinely fine as a later Phase 2.
