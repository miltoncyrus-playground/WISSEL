# SDD — `codex-cli`: OpenAI Codex CLI as a first-class execution harness

Status: **Phase 0 spike done, verified live.** `codex` (v0.155.1) is
installed and logged in via API key on this machine. Ran real `codex
exec` calls directly (not through wissel — the dispatched `implementer`
task couldn't: its `acceptEdits` permission mode blocks all Bash, so it
can't run shell probes at all, headlessly or otherwise — see §7.1, a real
finding in its own right). §6/§7 below are now confirmed facts, not
guesses; #6's flag-placement and JSONL-schema uncertainty is resolved.
One real risk surfaced by the spike, not previously known: §7.2's
sandbox-nesting finding. Phase 1 code not yet written.

## 1. Goal

Add OpenAI's Codex CLI as a second agentic execution harness, at full
parity with `claude-cli`: a `codex-cli` harness can be discovered,
selected, and used to actually run readonly and write-tier tasks —
reading/editing files in a real worktree, not just answering a question —
the same way `claude-personal` does today. This is the "full agentic CLI
harness" option, not the narrower "headless Q&A over an API" option (that
option — mirroring `anthropic-api`/`ApiExecutor` with an OpenAI API SDK
call — was considered and explicitly rejected for this pass; see the
confusion-protocol answer that produced this doc).

Confirms cleanly against the house rule in `CLAUDE.md` ("LLM access goes
through local Claude Code, never a hosted API directly" — also stated
verbatim as a comment in `src/executors/readonly.ts`): `codex-cli` is a
local subprocess wissel already has the pattern for (see
`src/executors/claude-cli.ts`), not a call to `https://api.openai.com`.
No new hosted-API dependency, no new npm package — `codex` is a binary on
`PATH`, same shape as `claude`.

## 2. Naming: `codex-cli`, not `chatgpt`

`HarnessTool` already draws the line at *tool*, not *product name* —
`anthropic-api` is the tool id, not `claude-api`. Same rule here: the
binary is `codex`, the project is OpenAI Codex CLI, "ChatGPT" is the
product Codex's OAuth login authenticates against. New `HarnessTool`
value: `"codex-cli"`. New `AgentDef.executor` value for agents that should
route here: `"codex"` — mirrors the existing `"api"` tag
(`ApiExecutor.canHandle`), not a new naming scheme.

## 3. What I looked at

**In the repo**: `src/executors/claude-cli.ts` (`runClaude`,
`CommandRunner`, the shared-plumbing pattern this doc mirrors exactly),
`src/executors/readonly.ts` + `write.ts` (the two-thin-classes-over-one-
shared-runner split), `src/executors/anthropic-api.ts` (`MODEL_PRICING`
+ `computeCost` — the pattern for turning token usage into a dollar
figure when the tool itself doesn't report one), `src/core/types.ts`
(`Harness`, `HarnessTool`, `Executor.harnessTool`), `src/core/
harness-pool.ts` (`acquire`/`release`, tool-scoped selection — needs zero
changes, already generic over `HarnessTool`), `src/core/
harness-discovery.ts` (`discoverHarnesses`, `checkClaudeCliAuth`,
`validateHarness` — the `.claude*`-probing pattern this doc mirrors for
`.codex*`), `src/api/server.ts` (`autoExecutors`/`manualExecutors`
wiring, `executeWriteTier` gating), `src/api/public/board.html`'s
`renderHarnessStrip()` (confirmed it renders `h.tool`/`h.label` as plain
text with no hardcoded tool list — **the strip needs zero changes** to
show a `codex-cli` pill), `agents/manifest.yaml` (confirmed `executor:`
values in use today: `readonly`, `handoff`, `api` — no agent currently
targets a non-`claude-cli` agentic tool). Also re-read
`docs/SDD-execution-harnesses.md` in full, including its own §6 flag that
a second tool "deserves its own SDD" — this is that SDD.

**External** (Codex CLI's actual current CLI surface — verified via its
docs, not assumed):
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Developer commands / CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- [`codex exec` --json event cheatsheet (third-party, cross-checked against the above)](https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/)
- Open GitHub issues confirming two real gaps (both feed §7/§8 below):
  [#19866](https://github.com/openai/codex/issues/19866) (`codex login
  status` has no reliable `--json` output yet), and the general shape of
  [#4776](https://github.com/openai/codex/issues/4776) (JSON-mode docs
  lag the implementation — a reason to spike live, not trust docs alone).
- Pricing snapshot for `gpt-5.1-codex` (released 2025-11-13): $1.25/1M
  input, $10.00/1M output tokens — from a pricing aggregator, **not**
  OpenAI's own pricing page directly; treat as a starting number to
  re-verify at implementation time, same as `anthropic-api.ts`'s own
  `MODEL_PRICING` comment already insists on ("current-generation models
  ... an unknown model computes no actualCost rather than a guessed
  one").

## 4. Data model changes

`src/core/types.ts`:

```ts
export type HarnessTool = "claude-cli" | "anthropic-api" | "codex-cli";
```

`Harness.env`'s doc comment currently says "claude-cli only" — broaden it
to cover both subprocess tools, since `codex-cli` uses the identical
"env overrides passed straight to the spawned process" mechanism
(`CODEX_HOME` instead of `CLAUDE_CONFIG_DIR`; optionally `CODEX_API_KEY`
for a key-based account instead of an OAuth-logged-in one — both are just
entries in the same `env` map, no new field needed, unlike
`anthropic-api`'s separate `apiKeyEnv` — that field exists because an API
key can't be a config-dir-style path; `CODEX_API_KEY` is already
expressible as a plain `env` entry the same way `CLAUDE_CONFIG_DIR` is).
No new `Harness` field required.

`harnesses.yaml` gains a second worked example:

```yaml
  - id: codex-personal
    tool: codex-cli
    label: "Codex — personal"
    enabled: true
    env: { CODEX_HOME: "/home/mcyrus/.codex" }  # absolute — env vars don't get tilde-expanded
```

Auto-detected the same way `claude-personal` is — see §5 — so this entry
is optional, a label override, not a requirement.

## 5. Discovery: `.codex*` probing, with one real gap

`harness-discovery.ts` gains `discoverCodexHarnesses()`, mirroring
`discoverHarnesses()`'s `.claude*` heuristic exactly: scan `$HOME` for
`.codex*`-prefixed directories, probe each with `CODEX_HOME` pointed at
it, keep only the ones that come back logged in.

**The gap**: `claude auth status --json` gives `checkClaudeCliAuth` a
clean structured `{loggedIn, email}`. Codex's equivalent, `codex login
status`, **does not reliably support `--json`** — it's an open feature
request ([#19866](https://github.com/openai/codex/issues/19866)) as of
this research. Current behavior is one of four fixed human-readable
lines: `"Logged in using an API key"`, `"Logged in using ChatGPT"`,
`"Logged in using Agent Identity"`, `"Not logged in"`. Discovery has to
substring-match stdout instead of parsing JSON:

```ts
const loggedIn = !stdout.includes("Not logged in") && exitCode === 0;
```

This is strictly more brittle than the claude-cli path — a future Codex
CLI release that reworks that string breaks detection silently (probe
returns "not logged in" for an account that actually is, which just
means the harness doesn't show up, not a crash — consistent with
`discoverHarnesses`'s existing "never throws, degrades to zero
discovered" contract, so the failure mode is safe, just possibly
surprising). No email is available this way either, so the label falls
back to `"Codex — <authMode>"` parsed from which of the three logged-in
strings matched, or the bare id if that string ever changes shape too.
Flagged as an accepted risk in §8, not silently swallowed.

`discoverHarnesses()`'s return type doesn't change — `discoverCodexHarnesses()`
is a sibling function, both called from `HarnessPool.autoload()` and
unioned the same way `discoveredCli` and `discoveredApiKeys` already are.

`validateHarness()` gains a `codex-cli` branch parallel to its existing
`claude-cli`/`anthropic-api` branches: re-probe `codex login status`
under the manifest entry's `env`, same disable-on-failure contract as the
other two.

## 6. Execution: `src/executors/codex-cli.ts`

New file, structured exactly like `claude-cli.ts` — a shared `runCodex()`
function plus a `CommandRunner`-shaped injection point (the *existing*
`CommandRunner` type from `claude-cli.ts` is reused as-is: `(cmd, {cwd,
env}) => Promise<{stdout, stderr, exitCode}>` already fits `codex exec`
with zero changes, so tests inject the same kind of fake they already
know how to write).

**Command shape — confirmed live against the installed binary
(v0.155.1), not assumed:**

```
codex exec --json -s <read-only|workspace-write> [-m <model>] "<prompt>"
```

Correction to the pre-spike draft: **there is no `-a`/`--ask-for-approval`
flag on `codex exec` in this version at all** — `codex exec --help` lists
no approval flag, only `--dangerously-bypass-approvals-and-sandbox` and
`--approve-for-me`. Exec mode has no interactive approval concept to
begin with (it's already "non-interactive" by definition — nothing to
wait on), so there's nothing to set to `never`. `--sandbox`/`-s`,
`--json`, `-m/--model`, `-o/--output-last-message`, `-c/--config` are all
plain `exec` subcommand flags, not global-only — confirmed by running
each. The docs-lag-implementation risk §3 called out was real: multiple
web sources described a global `-a` flag that doesn't exist in this
build. **This is exactly why §7 mandated a live spike instead of shipping
against docs alone.**

One precondition, also confirmed live: `codex exec` refuses to run
outside a trusted directory (`"Not inside a trusted directory and
--skip-git-repo-check was not specified"`) unless the cwd is inside a
real git repo. `task.repo` is always a git repo in wissel, so this is a
non-issue in practice — no `--skip-git-repo-check` needed, noted here so
nobody adds it defensively later without knowing why it was never needed.

- `-m/--model <model>`: pushed when `agent.costProfile.model` names one
  — mirrors `runClaude`'s optional `--model`. **`gpt-5.1-codex` (the
  model name §3's pricing research turned up) 404s on this account's API
  key** (`"The model gpt-5.1-codex does not exist or you do not have
  access to it"`) — confirmed live, not assumed. Omitting `-m` and
  letting Codex fall back to its own configured default worked cleanly.
  Don't hardcode `gpt-5.1-codex` (or any unverified model id) as a
  default anywhere in Phase 1 code; `MODEL_PRICING` computing no cost for
  an unrecognized/inaccessible model is already the correct fallback
  (same contract `anthropic-api.ts` already relies on), not a bug to work
  around.
- `--json`: JSONL event stream on stdout (confirmed schema, §6.2)
  instead of `-o <file>` — deliberately avoids introducing a filesystem
  side-channel into the executor. `-o` writes the final message to a
  file, which would mean `runCodex()` needs real `fs` access after the
  subprocess exits, breaking the "everything the executor needs comes
  back through the injected `CommandRunner`'s return value" contract
  every existing test (and the fakes they use) relies on. Parsing the
  final `agent_message` out of the JSONL stream instead keeps codex-cli
  tests exactly as file-system-free as claude-cli's and anthropic-api's
  already are.

### 6.1 Tier → sandbox mapping

| wissel tier | `runClaude` permissionMode | `runCodex` sandbox |
|---|---|---|
| readonly | `plan` | `read-only` |
| write | `acceptEdits` | `workspace-write` |

`read-only` is Codex's own enforced no-write sandbox — same "zero write
risk by the tool's own enforcement, not just by which tools we didn't
grant" property `readonly.ts`'s comment calls out for `plan` mode.
`workspace-write` lets edits inside `task.repo` land without a human in
the loop, while anything reaching outside the workspace is still
sandbox-denied. **Confirmed live**: a denied write does **not** fail the
whole turn or produce a non-zero exit — the turn still `turn.completed`s
normally, with the denial visible only as a `file_change` item whose
`status` is `"failed"` (§6.2). This is a real, load-bearing difference
from `claude`'s `permission_denials` array (which *is* surfaced at the
top level of `ClaudeResultJson`) — `runCodex()` has to look inside the
item stream to know a write silently failed, not just check exit code.

**§7.2 flags a second, more serious finding from the live spike**:
`workspace-write` failed to allow an in-workspace write at all when run
nested inside this session's own sandboxed Bash tool — not a wissel bug,
but a real operational risk worth re-verifying once Phase 1 code runs
from wissel's own (normally unsandboxed) process. Read §7.2 before
building on the assumption that `workspace-write` just works.

### 6.2 Parsing the JSONL stream

**Confirmed live** (not just from docs) — a clean readonly run:

```json
{"type":"thread.started","thread_id":"01a0c0a1-195b-7e72-aa97-ffa43a782a8e"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"spike ok"}}
{"type":"turn.completed","usage":{"input_tokens":12523,"cached_input_tokens":0,"cache_write_input_tokens":12520,"output_tokens":7,"reasoning_output_tokens":0}}
```

Note the real `usage` object has **five** fields, one more than the
pre-spike draft assumed: `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens` (prompt-cache writes, priced differently from
both reads and fresh input on most providers — `MODEL_PRICING`/
`computeCost` needs a rate for this too, not just input/output, or cost
will be systematically undercounted on any run that writes to cache).

A failed turn (confirmed live by requesting an inaccessible model):

```json
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.1-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: ...)"}
{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: The model `gpt-5.1-codex` does not exist or you do not have access to it., url: ..., cf-ray: ..., request id: ..."}}
```
(exit code 1 on this path — confirmed.)

A sandbox-denied write within an otherwise-successful turn (§6.1,
confirmed live):

```json
{"type":"item.started","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-spike/ok.txt","kind":"add"}],"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"file_change","changes":[{"path":"/tmp/codex-spike/ok.txt","kind":"add"}],"status":"failed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Couldn’t create `ok.txt`: the environment blocked file writes."}}
{"type":"turn.completed","usage":{...}}
```
Exit code was still 0 here — confirming §6.1's point that a denial alone
doesn't fail the turn.

`runCodex()` splits stdout on newlines, parses each line as JSON
(skipping unparseable/blank lines rather than failing the whole run on
one — JSONL streams from a long-running subprocess can end up with a
partial trailing line if something goes wrong downstream), and takes:
- **summary**: the `text` of the *last* `item.completed` event whose
  `item.type === "agent_message"` — mirrors `parsed.result` in
  `ClaudeResultJson`.
- **cost**: the `usage` object of the *last* `turn.completed` event, run
  through a new `MODEL_PRICING` table in `codex-cli.ts` covering all
  three token rates (input, cached-input, cache-write, output — see
  above) — mirrors `anthropic-api.ts`'s `computeCost`, since Codex
  reports only token counts, never a dollar figure, unlike `claude -p
  --output-format json`'s `total_cost_usd`.
- **ok**: `exitCode === 0` **and** no `item.completed` in the stream with
  a `status: "failed"` **and** no `turn.failed` event — confirmed all
  three matter independently; exit code alone under-reports failure
  (a sandbox-denied write can leave exit 0), and item-status alone misses
  a hard transport/model failure (exit 1, `turn.failed`, no failed
  `file_change` item at all in that path).

### 6.3 Two thin executors, not one

Mirroring `readonly.ts`/`write.ts` exactly rather than inventing a new
shape:

- **`src/executors/codex-readonly.ts`** — `CodexReadOnlyExecutor`, `id =
  "codex-readonly"`, `harnessTool = "codex-cli"`, `canHandle: tier ===
  "readonly" && executor === "codex"`.
- **`src/executors/codex-write.ts`** — `CodexWriteExecutor`, `id =
  "codex-write"`, `harnessTool = "codex-cli"`, `canHandle: tier ===
  "write" && executor === "codex"`.

Both call the shared `runCodex()`, same division of labor as `readonly.ts`/
`write.ts` calling the shared `runClaude()`.

**Existing executors need a one-line change each**, same shape as the
existing `api` exclusion, so registration order in `autoExecutors`/
`manualExecutors` still doesn't matter:

```diff
- return agent.tier === "readonly" && agent.executor !== "api";
+ return agent.tier === "readonly" && agent.executor !== "api" && agent.executor !== "codex";
```
(`readonly.ts`), and
```diff
- canHandle(agent: AgentDef): boolean {
-   return agent.tier === "write";
- }
+ canHandle(agent: AgentDef): boolean {
+   return agent.tier === "write" && agent.executor !== "codex";
+ }
```
(`write.ts`).

## 7. Phase 0 — live spike, done

Same discipline the original harness SDD used for its own quota spike
(§7 there: "ran the spike directly... rather than speculating"). Docs for
a CLI this new are thin and at least one open issue says they lag the
implementation — confirmed true (§6's `-a` flag didn't exist). Findings
folded into §6 directly rather than duplicated here; two results didn't
fit anywhere else:

### 7.1 The dispatched write-tier task cannot do this spike itself

First attempt: this SDD's own Phase 1 task was dispatched to wissel's
`implementer` agent with instructions to do the Phase 0 spike itself
before writing code. It couldn't — not because of a missing tool, but
because **`WriteExecutor`'s `acceptEdits` permission mode blocks Bash
entirely**, headlessly, with no channel to approve it (see the comment
already in `write.ts`: "acceptEdits auto-accepts file edits but still
gates anything riskier (e.g. Bash)... surfaces as a permission denial").
`which codex`, `codex login status`, even `codex --version` all came
back denied. This isn't specific to Codex — **no dispatched write-tier
wissel task can run shell probes at all today**, a real, general
limitation of the current execution model worth knowing independent of
this SDD. Worked around here by running the spike directly (this
session, unsandboxed-by-wissel Bash access) instead of through wissel,
then handing Phase 1 a fully-specified contract instead of an
open-ended "go find out" — the dispatched task never needs Bash for
Phase 1 itself (pure file edits), so this doesn't block Phase 1, just
changes who runs the spike.

### 7.2 Sandbox-inside-a-sandbox: `workspace-write` failed to actually write, here

Running the `workspace-write` spike (§6.1/§6.2) inside *this* session's
own sandboxed Bash tool, a plain in-workspace file creation was denied —
Codex's own sandbox (Landlock-based on Linux) apparently can't establish
itself correctly nested inside another restrictive sandbox. Confirmed
this was specifically a sandbox-layering problem, not a broken write
path: the identical prompt with `-s danger-full-access` (bypasses
Codex's own sandbox, runs the shell command directly) succeeded
immediately.

**This is a real risk, not just a spike artifact, but its actual impact
depends on how wissel's own process runs** — if wissel itself is ever
run from inside another restrictive sandbox (a locked-down container, a
CI runner with seccomp/Landlock restrictions), `codex-write`'s
`workspace-write` tier could silently fail *every* edit (denied
`file_change` items, §6.2) while still reporting `ok: true` at the
process-exit level, unless `runCodex()`'s failure detection correctly
inspects item statuses (§6.2 already designed around this). When wissel
runs as a normal unsandboxed process on a developer's machine (the
common case today, per `README.md`'s `bun run --watch`), this almost
certainly won't reproduce — but **don't assume that; re-verify
`workspace-write` once Phase 1 code runs for real from wissel's own
spawned subprocess**, not from inside a nested sandbox like this spike
ran in. Flagged in §8 as an open risk, not silently resolved.

## 8. Risks and honest gaps

1. **Auth-status brittleness** (§5) — substring-matching `codex login
   status` text is weaker than claude-cli's `--json` contract. Confirmed
   live: this version has no `--json` support for it at all (only a
   fixed-string status line). Accepted for v1 — see §9.1, still your
   call to override.
2. **Sandbox-denial visibility** (§6.1/§6.2) — resolved by the spike, not
   a gap anymore: a denied write surfaces as a `file_change` item with
   `status: "failed"`, without failing the overall turn or exit code.
   `runCodex()`'s `ok` computation is specified in §6.2 to check for this
   explicitly.
3. **Sandbox-inside-a-sandbox** (§7.2) — new finding, not previously
   known: `workspace-write` may silently fail every edit when wissel
   itself runs inside another restrictive sandbox. Needs re-verification
   from wissel's own real process, not assumed safe from this spike.
4. **No pilot agent yet.** Nothing in `agents/manifest.yaml` currently
   declares `executor: codex` — this SDD ships infrastructure, same as
   the original harness SDD's Phase 1 shipped selection + the strip
   before any spend/health polish. See §9.3.
5. **No verified working model id yet.** `gpt-5.1-codex` 404s on this
   account's API key (§6, confirmed live) — omitting `-m` and letting
   Codex use its own default is the only verified-working path right
   now. Don't hardcode a model id anywhere in Phase 1; `MODEL_PRICING`
   simply won't compute a cost for a model it doesn't recognize, which is
   the existing, correct fallback.
6. **No dispatched wissel task can run shell probes** (§7.1) — a general
   limitation of `acceptEdits`, not specific to this SDD, surfaced while
   building it. Worth its own follow-up someday; out of scope here.

## 9. What I need from you

1. Accept the auth-status substring-matching brittleness (§8.1) as v1,
   or do you want discovery to fail closed (never surface a `codex-cli`
   harness) until real `--json` support ships, trading "less brittle"
   for "possibly zero discovered Codex accounts even when one exists"?
2. §7.2's sandbox-nesting risk — fine to ship Phase 1 with a note to
   re-verify `workspace-write` live once it's running from wissel's own
   process, or do you want that re-verification done before Phase 1 is
   considered complete (i.e. block on it, the way §7 itself blocked
   Phase 1 before)?
3. Pick (or defer) a pilot agent. Cheapest real end-to-end proof:
   duplicate one existing `readonly`/`tier: readonly` agent in
   `agents/manifest.yaml` with `executor: codex` and no `costProfile.model`
   override (letting Codex's own default resolve, per §8.5), so the same
   task can be compared side-by-side under `claude-cli` vs `codex-cli`.
   Or ship infra-only for now and pin an agent later, same as the
   original SDD did with harnesses generally.

## 10. Phased implementation plan

**Phase 0** — live spike (§7). **Done** — command/parsing contract
confirmed live (§6), two real findings folded in (§7.1, §7.2).

**Phase 1** — now that §7 has confirmed the command/parsing contract:
- `HarnessTool` gains `"codex-cli"` (`types.ts`).
- `discoverCodexHarnesses()` + `codex-cli` branch in `validateHarness()`
  (`harness-discovery.ts`).
- `src/executors/codex-cli.ts` (`runCodex`, `MODEL_PRICING`,
  `computeCost` — mirrors `claude-cli.ts` + `anthropic-api.ts`).
- `src/executors/codex-readonly.ts` + `codex-write.ts`.
- One-line `canHandle` exclusions in `readonly.ts`/`write.ts` (§6.3).
- `server.ts`: `CodexReadOnlyExecutor` added to `autoExecutors`/
  `manualExecutors` unconditionally (tier-gated + sandboxed, same
  reasoning as `ApiExecutor`); `CodexWriteExecutor` gated behind
  `executeWriteTier`, same as `WriteExecutor`.
- `harnesses.yaml` gains the `codex-personal` example (§4).
- **No changes needed** to `Board`, `telemetry.ts`, or `board.html` —
  all three are already generic over `HarnessTool`/`harnessId` (verified
  in §3), which is the main reason this is a smaller diff than the
  original harness SDD.

**Phase 2** (only if §9.4 picks a pilot agent): add `executor: codex`
to one manifest entry, run it live end-to-end, confirm `actualCost`,
`harnessId`, and the board strip all show real `codex-cli` activity —
same live-verification bar as §9/§11 of the original SDD.

**Tests** (same commit as Phase 1, per house rule — not a follow-up):
- `codex-cli.ts`: fake-`CommandRunner` tests for command construction
  (flags, model pass-through), JSONL parsing (summary extraction, cost
  computation, unparseable-line tolerance), and error paths (non-zero
  exit, thrown spawn error) — mirrors `test/anthropic-api-executor.test.ts`'s
  structure.
- `codex-readonly.ts`/`codex-write.ts`: `canHandle` tests, including that
  they reject the other tier and non-`codex` `executor` values; updated
  `readonly.ts`/`write.ts` tests confirming they now reject
  `executor: "codex"` too.
- `harness-discovery.ts`: `.codex*`-probing tests with a fake runner and
  fake `$HOME`, mirroring the existing `.claude*` test's `fakeHome()`
  helper — including a case for the substring-matched auth strings (§5)
  and a case where the string shape doesn't match anything known (degrades
  to "not discovered," never a crash).
- No real `codex` or `claude` process spawned in any test — same
  discipline already in place for every other executor/discovery test in
  this repo.
