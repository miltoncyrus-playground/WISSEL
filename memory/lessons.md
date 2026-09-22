# Wissel engineering lessons

## Permission model in implementer/reviewer sessions
Implementer and reviewer agent runs are frequently sandboxed to write-files-only or read-only Bash. Never report `BLOCKED` solely because `bun test`/`bun run typecheck` couldn't be executed — trace the change by hand and report `DONE_WITH_CONCERNS`, naming exactly what's unverified. A separate verification step (reviewer pass or CI) always runs the real suite before merge; that's the design, not a gap to work around.

## Changing `TaskCard.status` (adding a new status value)
Touches at minimum two files: `src/core/types.ts` (the status union) and `src/api/public/board.html`, which enumerates the full status list in three separate literals — `STATUS_COLOR`, `STATUS_LABEL`, and the `COLUMNS` array. Missing any of the three means a task silently disappears from the Kanban UI or renders with a blank/`undefined` style. No other code does an exhaustive switch over status (all comparisons elsewhere are `===`/`!==`), so those two files are the complete surface — but both must move together, and this has been missed on the first pass more than once.

## Output contracts for agents whose raw response becomes data
Any agent whose final message is consumed programmatically rather than displayed (verdict parsing, wholesale file replacement, etc.) needs an explicit `outputContract` in `agents/manifest.yaml`, wired through `buildAgentPrompt`, plus a parser that fails closed — never defaults to "approve" or "success" on missing/malformed output. `reviewer` uses `parseReviewVerdict` for this. `memory-curator` (this agent) uses a prose-discipline contract instead (no JSON, no fences, no preamble — first character of the message is the first character of the file) because the payload is markdown, not structured data. Both were caught missing in initial review passes before being added.

## SDD / doc citation discipline
Never cite a spec doc's sections as authoritative unless that doc actually exists in the same diff or repo. `docs/SDD-memory-curator.md` was cited by name and section before it existed on two separate occasions and caught by review both times. Line-number citations inside SDDs get checked against real code by reviewers (caught a dangling `§9` reference and a wrong line number twice in the same doc) — verify citations before submitting, not just prose structure.

## SQLite schema changes
New columns on existing tables use the established heal-on-open pattern: `ALTER TABLE ... ADD COLUMN` wrapped in try/catch at DB-open time, matching the `harness`/`parentTaskId` precedent in `src/services/board.ts`. `ADD COLUMN` in SQLite is always safe (nullable, no data loss on existing rows) — no separate migration tooling needed.

## Worktree/lineage keying for iterative agents
Pushback retries key their worktree off `reviewLineageId ?? task.id` in the write executors, so repeated re-attempts reuse the same worktree/branch (one `git worktree add` total across N attempts, not N). A deliberate human-triggered "restart" after escalation instead mints a brand-new `reviewLineageId` rather than reusing an exhausted one — "restart, not silent extension" is the intended distinction between these two paths.

`supersededBy` never touches `status` — a superseded task keeps its old status forever by design (the old card isn't meant to be resurrected). Known gap: `board.html` doesn't filter superseded cards out of their column, so a stale-looking duplicate can remain visible after a retry. Worth fixing if it causes confusion, but not yet addressed.

## Wiring UI actions to endpoints
Before wiring a button to a `POST` endpoint, check the endpoint's actual required request body. A bare `fetch(url, {method:"POST"})` with no body silently 400s against any endpoint that requires fields — this shipped once (escalation approve/retry buttons) and needed a dedicated follow-up fix plus real dialog-driven e2e tests (not just visibility assertions) to catch it going forward.

## Review process
Reviewer claims get re-verified independently, not trusted at face value — one review round asserted "grep found nothing relevant" and was wrong; the next review caught it by grepping independently. When reviewing, re-run the specific checks a prior pass claimed to have done rather than accepting the claim.