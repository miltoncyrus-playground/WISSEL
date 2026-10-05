# SDD: Turn off memory injection into agent prompts (keep capture)

Status: approved by Milton 2026-10-05, ready to build.
Related: `docs/SDD-memory-curator.md` (§6 persistence + prompt injection, §9 Phase 1).

## 1. Why

Every claude-cli and codex-cli run gets the whole of `memory/lessons.md`
pasted into its prompt under "Lessons learned from prior sessions:"
(`buildAgentPrompt`, `src/core/prompt.ts:53`). Milton is rethinking how
memory should reach agents. Until that's settled he wants injection off
everywhere, while curation keeps running exactly as it does today so
lessons keep accumulating for the redesign.

Measured cost of the status quo: the file was 33.4KB (about 8k tokens per
run) until `cbc11f4` cut it to 5.1KB (about 1.3k tokens). It's paid on
every dispatch, and nobody has measured whether it changes agent behavior.

## 2. Goal and measurable outcome

- **Off by default:** no agent prompt contains the lessons section unless
  `WISSEL_MEMORY_INJECTION=1` (or `true`) is set when the server starts.
- **Capture unchanged:** the memory scheduler, `gatherSessionLessons`,
  the `memory-curator` dispatch, `writeMemoryLessons` in `finishResult`,
  `GET /memory` and the Memory tab all behave exactly as before.
- **Outcome:** each claude/codex prompt shrinks by the size of
  `memory/lessons.md` (5.1KB today). Evidence:
  1. a server startup log line stating the injection state;
  2. `GET /memory` reporting `injected: false`;
  3. the Memory tab saying lessons are not currently sent to agents;
  4. a gate test that builds a real prompt for every agent in the
     manifest and finds no lessons section.

## 3. Design

### 3.1 One flag, read once, passed down explicitly

Read `WISSEL_MEMORY_INJECTION` in `src/api/server.ts`'s bootstrap with the
same `["1", "true"].includes(process.env.X ?? "")` gate every other
`WISSEL_*` flag uses (`server.ts:1281-1324`). Pass it into `createApp` as
`opts.injectMemory?: boolean`, then into every executor construction that
already takes `memoryPath` (`server.ts:234-250`: `ReadOnlyExecutor`,
`CodexReadOnlyExecutor`, `WriteExecutor`, `CodexWriteExecutor`, in both
`autoExecutors` and `manualExecutors`), and from there into
`runClaude`/`runCodex` as `RunClaudeOptions.injectMemory` /
`RunCodexOptions.injectMemory`.

Executors must not read `process.env` themselves; the flag comes in
through the constructor and options, like `memoryPath` does now. This
keeps it testable and matches the existing pattern.

### 3.2 The only behavior change: skip the read

In `src/executors/claude-cli.ts:295` and `src/executors/codex-cli.ts:177`:

```ts
const memory = injectMemory ? await readMemoryLessons(memoryPath ?? DEFAULT_MEMORY_PATH) : undefined;
```

`injectMemory` defaults to **false** at every layer (createApp, executor,
runClaude/runCodex), so no caller (a test, an eval, the pipeline runner
or a future executor) can turn injection on by accident by leaving it
out.

`buildAgentPrompt` stays as it is. It already leaves the section out
when `memory` is undefined (`test/prompt.test.ts:49`), and keeping the
parameter makes turning injection back on a one-flag change.

`ApiExecutor` (`anthropic-api.ts:100`) never injects memory today and is
not touched.

### 3.3 Capture is deliberately left alone

- `src/core/memory-scheduler.ts`: `gatherSessionLessons` still reads the
  current `memory/lessons.md` and puts it in the **task body** of each
  `memory-curator` run (`memory-scheduler.ts:152-153`). That is curation
  input, not injection, and it must stay or the curator loses its
  deduplication base. Today the curator gets the file twice (task body
  plus injection); with the flag off it gets it once, which is all its
  contract needs.
- `finishResult`'s `writeMemoryLessons` (`orchestrator.ts:227`):
  unchanged.
- `GET /memory`: unchanged apart from the extra field in §3.4.

### 3.4 Make the state visible

- **Startup log:** one line next to the existing memory-curation line,
  for example `memory injection off: lessons are curated but not added to
  agent prompts (set WISSEL_MEMORY_INJECTION=1 to re-enable)`, and the
  matching "on" wording when it's set.
- **API:** `GET /memory` returns `{ content, path, injected: boolean }`.
- **UI:** the Memory tab's description (`board.html:655`) currently says
  lessons are "folded into every agent's prompt before it runs". Make it
  conditional on `injected`: when false, say lessons are being curated
  but are not currently sent to agents. Update the stale comment at
  `server.ts:431-432` to match.

### 3.5 Docs

- `docs/SDD-memory-curator.md`: add a named revision callout at the top
  and in §6 pointing to this SDD. Injection is now off by default behind
  `WISSEL_MEMORY_INJECTION`; the §2 goal "inject the result into every
  subsequent agent's prompt" no longer holds by default.
- `README.md` env-var section and `.env.example`: document
  `WISSEL_MEMORY_INJECTION` as off by default, with what it does.
- Fix the doc comments that now overstate injection:
  `prompt.ts:3-12`, `claude-cli.ts:252-257`, and the `memoryPath` comments
  in `readonly.ts`, `write.ts`, `codex-readonly.ts` and `codex-write.ts`.

## 4. Tests (gate lane, part of the build)

1. `runClaude` with a stub runner and a temp `memoryPath` containing a
   sentinel string:
   - `injectMemory` omitted: the sentinel is NOT in the prompt;
   - `injectMemory: true`: it is.

   Read the prompt from what the stub runner receives on stdin (the
   E2BIG fix `bef675c` sends the prompt via stdin; see
   `test/claude-cli.test.ts:532` for how to capture it).
2. The same two cases for `runCodex`.
3. **Every real agent:** loop over every `kind: agent` entry from
   `Registry.load()` (the real `agents/manifest.yaml`) and assert the
   sentinel is absent when the flag is off (the "test every real config
   entry" lesson).
4. **Wiring:** `createApp` without `injectMemory` gives executors that
   don't inject. Use a real `ReadOnlyExecutor` with a stub runner, or the
   cheapest existing seam in `test/api.test.ts`.
5. `GET /memory` returns `injected: false` by default and `true` when
   `createApp` gets `injectMemory: true`.
6. **Capture regression:** `test/memory-scheduler.test.ts:136` ("includes
   the current memory/lessons.md verbatim") must still pass unchanged.
7. The Memory tab's description reflects `injected`: a case in
   `test/board-html.test.ts` or an e2e check in `e2e/board.spec.ts`.

Then `bun run typecheck` must be clean and `bun test test/` must have no
failures.

## 5. Eval (periodic lane)

Re-run `bun run eval:memory-curation-quality` after the change. It must
still report `OVERALL: PASS`, which proves curation quality didn't depend
on the curator also receiving injected memory. The eval currently points
`memoryPath` at a temp file so injection doesn't leak the repo's real
file (`eval/memory-curation-quality.eval.ts:172-179`). Leave that pin in
place but update its comment: with the flag off by default the pin is
belt and braces, not the only guard.

## 6. Non-goals

- Deleting the injection code path. It stays, gated, for the redesign.
- Stopping agents from reading `memory/lessons.md` on their own. It's a
  tracked file in every worktree, and an agent that greps the repo can
  still find it. That's out of scope until the redesign decides where
  memory lives.
- Per-agent memory filtering, size caps or a new memory format. All of
  that is redesign territory.
- Changing the curation schedule or the curator's contract.

## 7. Failure modes to check during review

- **A missed construction site:** any executor built without the flag
  just doesn't inject (it defaults off). The risk runs the other way: if
  the flag is set, a missed site silently ignores it. Test 4 covers
  `createApp`; also grep for `new ReadOnlyExecutor(`, `new WriteExecutor(`
  and the codex equivalents across `src/` and `eval/` to make sure
  nothing else builds executors and expects injection.
- **The curator losing its deduplication base:** test 6 guards this,
  because the curator's copy comes through the task body, not injection.
- **Flag parsing:** only `"1"` and `"true"` enable it, matching the other
  flags, so `"0"`, empty or unset all mean off.

## 8. Build plan (wissel cards)

1. **Core:** flag plumbing (§3.1-3.2), the startup log line (§3.4), docs
   (§3.5), and tests 1-4 and 6. Labels: `code`.
2. **Visibility:** `GET /memory` `injected` field and conditional Memory
   tab wording (§3.4), tests 5 and 7, and the eval comment update (§5).
   Depends on card 1 because both touch `server.ts`. Labels: `code`.
