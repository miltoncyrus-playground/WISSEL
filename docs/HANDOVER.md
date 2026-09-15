# wissel — handover brief

Paste this into a Claude Code session after `cd` into this repo.

## What this is

A router for a fleet of agents and skills. It grew out of agetor
(`miltoncyrus-playground/agetor`), which assumed every task was a coding
task and therefore spent a git worktree plus a tmux session on all of
them. wissel splits "what to run" from "how to run it" so that read-only
agents can run as plain API calls with no worktree at all.

## Core design decisions already made

1. **Executor abstraction.** `Executor.canHandle(agent)` / `run(task, agent)`.
   The agetor spawn path becomes `WorktreeClaudeExecutor`; everything
   read-only goes through `ReadOnlyExecutor`.

2. **Registry is a YAML manifest**, not code. Each agent carries both
   `description` (what it is) and `whenToUse` (what should land there).
   The router prompt and the fleet UI read the same file.

3. **The router returns a full ranking, never a bare winner.** The
   rejected candidates and their scores are the debugging surface — when
   routing goes wrong the right agent is usually sitting at #2, and the
   score gap says whether to fix tags or fix weights.

4. **Strategy is pluggable.** `RuleStrategy` (tag overlap) ships first.
   Embedding similarity and an LLM classifier implement the same
   interface and return the same shape, so rankings can be diffed
   against each other on the same task.

5. **Overrides are training data.** Every manual override records
   (task, router pick, human pick). That becomes the eval set for
   testing routing changes before shipping them.

6. **Worktree service resolves the ORIGIN repo path**, not the worktree
   path. This is the fix for the agetor scoping bug where every task
   resolved to a unique `worktrees--<task-id>` memory namespace.

7. **The board API is the only backend the frontend knows.** No direct
   tmux access from the UI. SSE, not polling — one event stream per
   board, reduced into state client-side.

## Build order

Do not build the router first. With this few agents it is a switch
statement. Order:

1. `services/board.ts` — pick a store, implement the interface, get the
   HTTP API + SSE stream up. Everything else is a client of this.
2. `services/provisioner.ts` — port agetor's `hook-installer.ts`
   (atomic write, merge-preserving). Smallest, best-understood piece.
3. `services/worktree.ts` + `services/session.ts` — extract from
   agetor's spawn path. Behaviour unchanged, just decomposed.
4. `executors/readonly.ts` + the `reviewer` agent — proves the
   no-worktree path end to end with zero write risk.
5. `executors/worktree-claude.ts` — wire the old path through the new
   abstraction.
6. `planner` and `triager` — these generate enough card volume to make
   routing worth having.
7. `core/router.ts` — last.

## Open questions

- Board store: SQLite (matches claude-mem) vs flat files in git?
- Does `ReadOnlyExecutor` call the Anthropic API directly, or spawn a
  headless `claude -p` for skill/MCP parity with the write path?
- Handoff edges are declared in the manifest but the registry does not
  yet prune by them — decide whether handoffs are advisory or enforced.
- Do read-only agents get claude-mem access, and is it read-only there too?

## House style

Bun + TypeScript, strict mode, ESM, `.ts` extensions in imports.
Direct, no ceremony. Match agetor's existing conventions where the code
is ported rather than rewritten.
