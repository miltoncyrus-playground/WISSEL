## Can't run bun or tsc in your sandbox? It's the node_modules symlink
Task worktrees symlink `node_modules` to the main checkout, which sits outside your sandbox, so `bun test`, `bun run typecheck` and Playwright often can't run. Check the change by hand, name exactly what you couldn't verify, and report `DONE_WITH_CONCERNS`, not `BLOCKED`. The reviewer or the merge step runs the real suite.

`src/services/worktree.ts:101` links `<worktree>/node_modules` to `<repo>/node_modules`. An operator can grant access per card via `extraAllowedDirs` (passed as `--add-dir`, see `src/executors/write.ts:115`). Never claim "tests pass" from a sub-agent's summary or a partial run; say what you actually ran. Chromium for e2e is resolved from `~/.cache/ms-playwright` (`playwright.config.ts`); the old `/opt/pw-browsers/chromium` error is fixed.

## e2e runs are expensive; run only what changed
A full `e2e/board.spec.ts` run inside a review cost about $2.40 against a $0.12 estimate. Use `bun run test:e2e:affected` to run only the specs your diff touches.

`playwright.config.ts` pins every `WISSEL_*` automation flag to `"0"` in `webServer.env`. Keep it that way: if any of them leak in from the shell, the test server's real orchestrator starts paid Claude sessions against fixture tasks and makes tests fail at random. If you add a new `WISSEL_*` flag in `src/api/server.ts`, pin it there too (`test/playwright-config.test.ts` guards this).

## Adding a TaskCard status value
Change `src/core/types.ts` and three lists in `src/api/public/board.html`: `STATUS_COLOR`, `STATUS_LABEL` and `COLUMNS`. Missing one makes cards vanish from the board or render unstyled.

## SQLite schema changes
New column on an existing table: `ALTER TABLE ... ADD COLUMN` in a try/catch at DB open, like the existing ones in `src/services/board.ts`. New table: `CREATE TABLE IF NOT EXISTS`. No migration tooling needed.

## Agent output that gets parsed as data
If an agent's final message is parsed (verdict, plan, handoff, file body), give it an `outputContract` in `agents/manifest.yaml` and a parser that rejects bad output. Never default to approve, success or empty.

Copy `parseReviewVerdict`'s shape (last fenced block wins, fail to `null`), as `parseSubtaskPlan` and `parse-pipeline-handoff.ts` do. If an agent needs a different contract from an existing one, give it its own id (that's why `pipeline-reviewer` exists). If your session has plan-mode instructions but no `ExitPlanMode` tool, ignore the wrapper and emit your role's contract block.

## Calling executor.run() anywhere new
Copy everything `orchestrator.process()` does around its `executor.run()` call, not just the call: `HarnessPool.acquire()`/`release()` in try/finally, cost tracking and harness stamping. `pipeline-runner.ts` once skipped the pool and broke concurrency limits.

## Parsing external CLI output
Check the format against the tool's current docs, and fail loudly when you can't verify it. Tests whose fixtures share the code's assumption prove nothing.

Real misses: claude `stream-json` can print system lines after the `type: "result"` line, so find the result line rather than taking the last line (`resultLine` in `src/executors/claude-cli.ts`). Tool results arrive as top-level `type: "user"` lines, not inside `stream_event`. Session-limit text can be `resets 1am (UTC)` with no minutes.

## Tests: use the real dispatch path, real config and an injected clock
Routing or dispatch tests must go through a real `sweep()` with `Registry.load()`, because `sweep()` sets `routedTo`, which later guards depend on. Calling `finishResult` with a hand-built object skips that.

For a new opt-in field, loop over every real entry in `agents/manifest.yaml` and assert the output is unchanged (see `test/claude-cli.test.ts`). For timestamps, take a `now: Date = new Date()` parameter; never assert that two back-to-back calls give different times. For a test that compares two copies of a type (e.g. `test/pipeline-editor-types-parity.test.ts`), break one copy once to prove the test catches it. For a button wired to an endpoint, assert the actual request body with `postDataJSON()`.

## Retries, supersededBy and dependsOn
Retries reuse one worktree keyed by `reviewLineageId ?? task.id`. `supersededBy` never changes a card's `status`, so always resolve to the live card with `resolveLiveTip` (`src/core/orchestrator.ts`) before reading status.

A restart after escalation creates a new `reviewLineageId`; a pushback reuses the old one. Superseded cards stay in their old board column, drawn faded.

## Verify card instructions and doc citations against the repo
Card text and docs can point at the wrong file, section or line. Grep first and follow what the code actually has. Example: New Task e2e tests live in `e2e/new-task.spec.ts`, not `board.spec.ts`.

When the code deliberately differs from an SDD, add a named revision note in the doc. Word claims about verification honestly ("checked against the docs" is not "observed in a live run").

## Browser code runs over plain HTTP, not a secure context
The board and pipeline editor are opened at `http://192.168.10.25:8787`, plain HTTP on a LAN IP, so browser APIs that need a secure context are missing: `crypto.randomUUID`, `navigator.clipboard`, service workers. e2e runs on `localhost`, which counts as secure, so tests pass while the real UI breaks.

Use `newId()` (`pipeline-editor/src/id.ts`), which falls back to `crypto.getRandomValues`. Check any new browser API against MDN's "secure context" note. To reproduce the LAN case in Playwright, remove the API in `page.addInitScript` (see the randomUUID test in `e2e/pipeline-editor.spec.ts`).

Don't import `src/api/public/*.js` into e2e specs. Those modules export only through a `module.exports` guard, which works in `bun test` but exports nothing under Playwright (the repo is `"type": "module"`), so the whole spec file fails to load. Call them with `page.evaluate` on the globals the board defines. `test/e2e-public-imports.test.ts` enforces this.

## Process management
Kill processes by PID. `pkill -f <pattern>` can match the shell running it and kill your own command.
