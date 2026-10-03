# SDD — MCP tool orchestration: growing wissel beyond a coding agent

Status: **Subtasks 1, 2, 3, 4, 5, 6, and 7 shipped and merged.** Written per
Milton's ask, following a design conversation in this session about
turning wissel from a dev-focused coding orchestrator into one that can
also drive arbitrary MCP servers (Slack, ticketing systems, databases,
anything with an MCP tool surface) alongside the coding work it already
does.

**What shipped**: `McpServer` type + `mcp-servers.yaml` + `McpServerPool`
(load/from/all/get/acquire/release/setEnabled, deliberately no
single-pick `acquire(tool)` the way `HarnessPool` has — see §3.1/§6
Subtask 1), `checkMcpServerReachable`, `GET /mcp-servers` + `POST
/mcp-servers/:id/{enable,disable}` (no create/delete — see §4's revision
callout); `AgentDef.mcpAccess`, `TaskResult.mcpCalls`, the
`claude-cli.ts`/`codex-cli.ts` grant-building and transcript-parsing
wiring (`runCodex`'s own real MCP flag syntax is a named, unresolved gap —
see §4's second revision callout); `AgentDef.reviewTarget`,
`formatMcpTranscript` (`src/services/mcp-transcript.ts`),
`spawnReviewerTask`'s `"tool-calls"` branch (`src/core/orchestrator.ts`),
`GET /tasks/:id/mcp-calls`, and the task drawer's "Tool calls" section —
see §6 Subtask 4. Also fixed in passing while building Subtask 4:
`TaskResult.mcpCalls` had shipped in Subtask 2 well before
`SqliteBoard`'s `task_results` table learned to store it, so
`recordResult`/`getResult` silently dropped it on every round trip —
healed the same way the `actualCost`/`harnessId`/`subagents` columns
were healed before it (see `src/services/board.ts`). Also: `TaskCard.repo`
becoming optional + `src/services/scratch-workspace.ts` + the `POST
/tasks` conditional requirement + the New Task form's live `repo`
required-toggle (§3.3, Subtask 5 — see §4's third revision callout for
what went beyond the original §3.3 text). Also: `splitGrantsByTrust`
(mcp-config.ts), the `--allowedTools`/`--mcp-config` trust-tier
enforcement in `runClaude`, the `mcp-approval-request` describe-don't-
execute prompt contract (`parse-mcp-approval-request.ts`), and the
human-triggered approve/deny endpoints (Subtask 3 — see §4's fourth
revision callout for where this subtask's concrete mechanism had to fill
in gaps §3.5 only sketched the shape of). Also: `McpServerPool
.setToolTrust`/`setMcpServerToolTrust` (mcp-manifest.ts), `POST
/mcp-servers/:id/tools/:tool/trust`, and the board's "Manage MCP
servers" panel — enable/disable per server plus a per-tool trust toggle,
mirroring the existing "Manage harnesses" panel's own `.hm-row` CSS
family verbatim (Subtask 6 — see §4's fifth revision callout). Also:
`src/core/mcp-integration-pipeline.ts`
(`buildMcpIntegrationPipelineGraph`), `eval/fixtures/mcp-echo-server.ts`
(a real, minimal, hand-rolled stdio MCP server — no SDK dependency), the
permanent `mcp-tool-caller` manifest agent, and two real fixes in
`finishResult`/`settleRoot` the integration proof's own live Scenario 2
surfaced (Subtask 7 — see §6/§7's own revision callout for the full
story, including the direct answer to the "does pipeline-runner.ts need
any changes at all" question this subtask's card posed).

## 1. Goal

Three things, in order of how load-bearing they are to everything else:

1. An agent can be granted access to specific tools on specific MCP
   servers — a new, open-ended axis alongside today's closed
   `toolAccess: ("read"|"write"|"bash")[]` enum — and that grant actually
   reaches the real `claude -p`/`codex exec` invocation.
2. A completed MCP-tool-calling run can be **reviewed** the same rigor a
   coding diff gets today — which means capturing what tools were called,
   with what arguments, and giving the reviewer (human or agent) that
   transcript instead of a diff when there's no diff to show.
3. The handful of places that currently assume "every task is about a git
   repo" (a required `TaskCard.repo`, the worktree-creation path, the New
   Task form) stop being a hard requirement for a task that never touches
   a file.

Explicitly **not** a goal here: solving human-in-the-loop approval for
irreversible actions elegantly. That's named as the riskiest open piece
(§3.4) and deliberately scoped small rather than designed in full — see
§5's non-goals.

## 2. What I looked at

This session's own direct reading of the live codebase, not research from
outside it (there is no existing MCP integration anywhere — `grep -rl
"mcp" src/ --include="*.ts"` returns nothing):

- `src/core/types.ts`: `AgentDef` (`toolAccess: string[]`, `tier`,
  `executor`, `trustLevel`, `autoMerge?`, lines 30-70), `Harness`
  (`id`/`tool`/`label`/`enabled`/`env`/`apiKeyEnv`, lines 362-382),
  `TaskResult` (`worktree?`, `subagents?`, lines 421-445) — the exact
  shapes every new field in this doc has to extend, not replace.
- `src/core/harness-pool.ts` (`HarnessPool`, line 27) and
  `src/core/harness-discovery.ts` (`checkHarnessAuth`) — the
  registry/pool/health-check shape §3.1's MCP server registry copies.
- `src/executors/claude-cli.ts`: `runClaude`'s exact `claude -p` argv
  construction (`--permission-mode`, `--allowedTools`, lines 148-224) and
  its `stream-json` output handling (`onChunk`, lines 35-80) — confirms
  every tool-call event (including, once wired, an MCP one) already
  flows through this pipe; nothing new needs to be built to *observe*
  tool calls, only to parse MCP ones out of what's already streamed (the
  same stream `docs/SDD-live-task-output.md`'s feature already persists
  wholesale).
- `src/core/orchestrator.ts`: `handleReviewVerdict` (line 306),
  `resumeAfterApproval` (line 342), `tryAutoMerge` (line 414) — all three
  are diff-and-worktree-shaped top to bottom; `src/services/repo-diff.ts`
  (`getRepoDiff`, line 23) is what feeds a diff to a reviewer/human today.
- `src/services/worktree.ts` (`createTaskWorktree`, line 57) — confirmed
  only `WriteExecutor`/`CodexWriteExecutor` ever call this;
  `ReadOnlyExecutor` already runs with zero git involvement, which is why
  §3.3's "repo becomes optional" turns out to be a smaller change than it
  first looked like in conversation.
- `src/core/router.ts` (`Router`, line 33) — confirmed tag-overlap
  scoring is already domain-agnostic; no change needed here.
- `docs/SDD-pipelines.md` — the existing generic step/edge engine
  (`pipeline-runner.ts`), confirmed agent-agnostic (a step only names an
  `agentId` + transition), which is why §4.7 builds the heterogeneous
  proof-of-concept there instead of touching the legacy hardcoded
  implementer/reviewer loop.
- `docs/SDD-openclaw-agents-for-wissel.md` — a related but orthogonal
  prior effort: multi-agent **delegation structure** (handoffs, team
  presets, coordinator/specialist roles). That doc is about *which agent
  hands a task to which other agent*; this one is about *what tools an
  agent may call once it's running*. The two compose — a delegated
  specialist can also carry MCP grants — but neither doc needs to change
  because of the other.
- `docs/SDD-live-task-output.md` — confirms the `stream-json` capture
  infrastructure §3.2 builds on already exists and is already durable
  (`appendTaskOutput`).

## 3. Design decisions, stated plainly

**3.1 — A new `mcp-servers.yaml` + `McpServerPool`, structurally mirroring
`harnesses.yaml`/`HarnessPool`, but answering a different question.** A
`Harness` answers "whose account does the CLI process run as" (identity).
An MCP server answers "what external tool surface can the agent reach
once it's running" (capability) — a stdio command or a url, exposing N
named tools. These are orthogonal: the same MCP server can be attached
regardless of which harness/account is driving the session, so this is a
new, parallel registry, not a field added onto `Harness`. Same shape as
`HarnessPool` otherwise: a pool tracks per-server reachability/auth
(`checkHarnessAuth`'s equivalent — MCP servers can be down, rate-limited,
or need an OAuth refresh the same way a harness login can lapse) and
in-flight concurrency, surfaced in the UI the same way the harness strip
already is.

**3.2 — Grants are per-agent, per-server, per-tool — an open-ended list,
not a flag.** `AgentDef` gains `mcpAccess?: { server: string; tools:
string[] }[]`, additive and orthogonal to `toolAccess`/`tier`: a
readonly-tier agent can carry MCP grants with zero file access (e.g.
"read Jira via its MCP server, answer a question" — still routed through
`ReadOnlyExecutor`, still zero git involvement per §2's confirmation); a
write-tier agent can carry both file access and MCP grants. No new tier
value — `tier` stays exactly "file/bash blast radius," which is the axis
it already is. At dispatch time, `runClaude`/`runCodex` build the MCP
config for *only* this agent's granted server+tool pairs (never "attach
every registered server") and pass it alongside the existing
`--allowedTools` list — same mechanism, wider input.

**3.3 — `TaskCard.repo` becomes optional, not reworked.** Confirmed in §2:
`ReadOnlyExecutor` already never creates a worktree, so an MCP-only
readonly agent already has no git dependency today — the only real gap is
that `repo` is currently a required field (`Omit<TaskCard, "id"|
"status">`), forcing a "check Jira, post to Slack" task to name some
directory anyway. Fix: `repo` becomes optional specifically when the
routed/target agent's `toolAccess` includes neither `"write"` nor
`"bash"` — defaulting to a wissel-managed scratch directory
(`~/.wissel/scratch/<taskId>`, sibling to `~/.wissel/worktrees/`, same
injectable-`homeDir` convention `worktreesRoot()` already uses) purely as
a `cwd` for the CLI process, never a git repo. `WriteExecutor`'s own path
is completely untouched — a write-tier agent still always requires
`repo` and still always gets a worktree, no exceptions.

> **Revision (subtask 5, shipped):** three things went beyond this
> paragraph's original text, named explicitly rather than left as silent
> drift:
> 1. "`WriteExecutor`'s own path is completely untouched" holds at the
>    *behavior* level (a write-tier run's `cwd` is byte-identical to
>    before) but not at the *character* level — `strict: true` TypeScript
>    means `TaskCard.repo` becoming `string | undefined` forces a
>    non-null assertion (`task.repo!`) at `WriteExecutor`/
>    `CodexWriteExecutor`'s own `createTaskWorktree(task.repo!, ...)`
>    call, each with a one-line comment citing the invariant (`repo` is
>    mandatory for any write/bash-capable agent, enforced at creation).
>    Same treatment at every other `string`-typed call site that reads
>    `task.repo` (`mergeTaskWorktree`/`removeTaskWorktree`/`getRepoDiff`
>    in `src/api/server.ts` and `src/core/orchestrator.ts`,
>    `runStepAndSuccessors`'s `repo` param in `src/core/pipeline-runner.ts`).
> 2. The server-side check this paragraph describes only resolves the
>    routed agent *synchronously, at `POST /tasks` creation time* — it
>    can't catch a task created with ambiguous/no-match labels and no
>    repo that's later routed to a write/bash-capable agent by a label
>    edit (routing itself normally happens inside `sweep()`, not at
>    creation). `Orchestrator.process` (`src/core/orchestrator.ts`) gained
>    a second, dispatch-time check right after the agent is resolved for
>    real, logging and refusing to dispatch rather than letting a
>    repo-less task reach `createTaskWorktree` with `undefined`.
> 3. The New Task form's `#ntRepo` field (`src/api/public/board.html`)
>    implements the live client-side toggle the implementation card for
>    this subtask left as an explicit either/or choice (toggle live, or
>    leave `required` and rely on the server) — feasible because the form
>    already loads the full agent list (`GET /agents`, `toolAccess`
>    included) and already runs a debounced `POST /route/preview` as
>    labels change; toggling `required` off `agentsById[decision.selected]
>    .toolAccess` (or the manual-override pick, which wins when set)
>    needed no new endpoint.

**3.4 — Review needs a second shape (`"tool-calls"`), and this is where
new, real capture work actually happens.** `AgentDef` gains
`reviewTarget?: "diff" | "tool-calls"` (undefined means `"diff"`, today's
unchanged behavior). `TaskResult` gains `mcpCalls?: { server: string;
tool: string; args: unknown; result: unknown; ok: boolean }[]` — parsed
from the same `stream-json` event stream §2 confirms already flows
through `onChunk`, filtering for tool-call events whose name matches a
granted MCP tool (exact event shape to be confirmed against a real
`claude -p --output-format stream-json` run carrying an MCP tool call —
not yet observed directly, flagged as a concrete unknown for subtask 2,
not assumed). `getRepoDiff`'s reviewer-facing role gets a sibling,
`formatMcpTranscript(mcpCalls)`, and the board's task drawer gains a
"Tool calls" section alongside its existing "Diff" one, shown based on
which one the result actually carries.

**3.5 — Per-tool trust tiers, and a *before-the-call* approval gate —
named as the riskiest, most novel piece, deliberately scoped small.**
`mcp-servers.yaml` carries a trust tier per tool (not per server — a
single Slack server's `read_messages` and `send_message` are not the same
risk), e.g. `auto` (safe to call unattended, same spirit as today's
`autoMerge`) vs. `approval-required`. Everything else in wissel today
reviews a *completed* result — there is no existing mechanism for
pausing an in-flight run before a specific tool call fires. v1 scope,
deliberately narrow: an `approval-required` tool call is not actually
executed by the agent process itself; instead the agent's `--allowedTools`
grant *excludes* that tool, and its prompt is instructed to describe the
action it would take and end its turn — the same "stop and ask" shape
`ReadOnlyExecutor`'s plan-mode discipline already establishes, reused
rather than inventing a true mid-process pause/resume. A human approving
via the board then triggers a second, narrow follow-up run that actually
makes the one named call. This is a real limitation (the agent can't
chain "check Jira, then post to Slack based on what I found" through an
approval gate in one pass) — stated plainly, not hidden, and a true
elicitation-based pause is named as later work if this limitation turns
out to matter in practice.

## 4. Implementation shape

**`mcp-servers.yaml`** (new, repo-root, same convention as
`harnesses.yaml`/`agents/manifest.yaml`): `id`, `label`, `transport:
{kind: "stdio", command: string, args: string[]} | {kind: "sse"|"http",
url: string}`, `env` (name-the-env-var-never-the-value, same discipline
`Harness.env`/`apiKeyEnv` already hold), `tools: {name: string, trust:
"auto"|"approval-required"}[]`, `enabled`.

**`src/core/mcp-server-pool.ts`** (new, mirrors `src/core/harness-pool.ts`
structurally): `McpServerPool.load`/`.from`, per-server reachability
check (new, mirrors `checkHarnessAuth`'s shape but pings/validates an MCP
connection instead of a CLI account), `acquire`/`release` for
concurrency, same as `HarnessPool`.

**`src/core/types.ts`**: `AgentDef.mcpAccess?: { server: string; tools:
string[] }[]`; `AgentDef.reviewTarget?: "diff" | "tool-calls"`;
`TaskResult.mcpCalls?: { server: string; tool: string; args: unknown;
result: unknown; ok: boolean }[]`; `TaskCard.repo` becomes optional on
the type (server-side validation enforces the §3.3 conditional
requirement, not the type system — mirrors how `harnessOverride`
validation already works, see `POST /tasks`'s own eager-validation
comment in `src/api/server.ts`).

**`src/executors/claude-cli.ts` / `src/executors/codex-cli.ts`**: both
gain an `mcpAccess` passthrough option, build the MCP config for exactly
the granted server+tool pairs, extend the `--allowedTools` list to
include the resulting MCP tool names, and (new) parse `mcpCalls` out of
the `stream-json` tool-call events into the returned `TaskResult` when
`onChunk`/streaming is active.

**`src/services/scratch-workspace.ts`** (new, small, mirrors
`worktreesRoot()`'s exact convention in `src/services/worktree.ts`):
resolves/creates `~/.wissel/scratch/<taskId>` for a repo-less task.

**`src/services/mcp-transcript.ts`** (new, mirrors `src/services/repo-
diff.ts`'s role): `formatMcpTranscript(mcpCalls)` — pure, deterministic
formatting, no LLM involved (per CLAUDE.md's latent/deterministic split
— this is exactly as mechanical as `getRepoDiff` already is).

**`src/api/server.ts`**: `GET/POST/DELETE /mcp-servers` (mirrors
`/harnesses`'s own shape), `GET /tasks/:id/mcp-calls` (mirrors `GET
/tasks/:id/diff`).

> **Revision (subtask 1, shipped):** "mirrors `/harnesses`'s own shape"
> and "`GET/POST/DELETE /mcp-servers`" were in tension with each other —
> `/harnesses` itself has no create/delete endpoints, only `GET
> /harnesses` plus `POST /harnesses/:id/{enable,disable,model}`. Subtask
> 1 followed the "mirrors `/harnesses`" half literally: it ships `GET
> /mcp-servers` (every registered server + live `activeCount`) and `POST
> /mcp-servers/:id/{enable,disable}` only. There's no `POST
> /mcp-servers` (create) or `DELETE /mcp-servers/:id` — servers are
> hand-registered in `mcp-servers.yaml`, same as harnesses are today (§5
> already states no discovery mechanism is in scope). If a create/delete
> API surface turns out to be needed later, that's new scope for a
> follow-up subtask, not something subtask 1 silently dropped.

> **Revision (subtask 2, shipped):** §3.4's named unknown — the real
> `stream-json` event shape for an MCP tool call — is **corroborated, not
> observed**. No live round-trip against a real, attached MCP server was
> performed in this subtask (sandbox blocked the subprocess spawn needed
> to run `claude -p` for real); the shape below is reasoned from
> Anthropic's current official docs plus this repo's own already-shipped
> `render-task-output.js` precedent, not from watching a real MCP tool
> call happen. The generic `tool_use`/`tool_result` message envelope has
> strong corroboration this way (it's not MCP-specific, and
> `render-task-output.js` already depends on it in production). The one
> piece that is genuinely MCP-specific and still **unverified against a
> real attached server** is whether a granted MCP tool actually surfaces
> as a `tool_use` block named `mcp__<server>__<tool>` in practice — that
> naming convention is documented but has not been seen fire for real.
> Per the documented (not observed) shape: a tool call is a `tool_use`
> content block (`{type, id, name, input}`) inside a top-level
> `type: "assistant"` message, and its result is a `tool_result` block
> (`{type, tool_use_id, content, is_error}`) inside a top-level
> `type: "user"` message — correlated by `tool_use_id === id`, never
> nested inside a `stream_event`. Sourced from Anthropic's current
> official docs (code.claude.com/docs/en/agent-sdk/streaming-output,
> platform.claude.com/docs/en/agents-and-tools/tool-use/overview). Also
> sourced this way (same method, not guessed, also not live-verified):
> the real `claude` CLI flag is `--mcp-config <json-or-file>` plus
> `--strict-mcp-config` (to ignore any other ambient MCP config, e.g. a
> project's own `.mcp.json`), and the MCP tool-naming convention is
> `mcp__<server-name>__<tool-name>` (code.claude.com/docs/en/mcp). See
> `src/executors/parse-mcp-calls.ts`'s own doc comment for the exact
> citations, and `test/parse-mcp-calls.test.ts` for the fixture built
> against this corroborated-but-unobserved shape. **Open empirical item
> for whoever builds subtask 7's integration proof:** run a real `claude
> -p --output-format stream-json --include-partial-messages --verbose`
> invocation against a genuine attached MCP server with a granted tool,
> capture the real JSONL, and confirm (or correct) the shape above —
> ideally replacing this fixture with a real captured one at that point.
>
> One piece §3.2/§4 assumed but subtask 2 could **not** verify:
> `runCodex`'s own MCP wiring. Unlike `runClaude`, `codex exec` has zero
> prior MCP research anywhere in this codebase, and this subtask's own
> sandbox blocked every avenue to establish it for real (no `codex
> --help`/`codex exec --help` subprocess spawn, no WebFetch to
> non-Anthropic domains). Rather than guess a `-c mcp_servers...`
> config-override syntax that might silently no-op instead of erroring
> (a false positive worse than an obvious failure), `runCodex` accepts
> `mcpAccess`/`mcpServers` for interface parity but fails any resolved,
> non-empty grant loud, naming the server, instead of wiring it in. A
> codex-backed agent with no `mcpAccess` is completely unaffected. See
> `runCodex`'s own doc comment (`src/executors/codex-cli.ts`) for the
> full reasoning. This is a concrete, named follow-up for whoever next
> verifies codex's real CLI MCP surface — not a silently-dropped scope
> item.

> **Revision (subtask 3, shipped):** §3.5 deliberately only sketched the
> shape ("describe, don't execute, then a human triggers a narrow
> follow-up") without nailing down the exact mechanism — this subtask's
> own card restated it as a concrete proposal and flagged it as the
> implementer's own, not pre-blessed. Three places the real build ended
> up diverging from (or filling in a genuine gap in) that proposal,
> worth naming explicitly rather than leaving silent:
>
> 1. **The follow-up task's grant needed a new `TaskCard` field, not a
>    literal `mcpAccess`.** The card's own text says the follow-up's
>    "`mcpAccess` is scoped to exactly the one named server+tool" — but
>    `mcpAccess` only exists on `AgentDef` (a manifest-level, static
>    declaration), never on `TaskCard`. Added `TaskCard.mcpAccessOverride`
>    instead, mirroring the existing `harnessOverride`/`model` task-level-
>    override pattern exactly: every executor reads
>    `task.mcpAccessOverride ?? agent.mcpAccess`, so the follow-up can
>    route to *any* agent capable of running it and still be scoped down
>    to exactly one tool call for that one task, without needing a
>    dedicated one-off `AgentDef` per approval. See `TaskCard
>    .mcpAccessOverride`'s own doc comment (src/core/types.ts).
> 2. **The follow-up deliberately does NOT carry `parentTaskId`.** An
>    earlier draft set it (for board-UI grouping), but
>    `resolveHandoffAllowlist` (src/core/orchestrator.ts) restricts a
>    `parentTaskId`-carrying follow-up's routing candidates to the
>    parent's own routed agent's declared `handoffs` — which this
>    follow-up has no principled reason to be bound by (the whole point
>    is it can route to whichever agent can actually make the one
>    approved call). `board.setSupersededBy` is the grouping link
>    instead, exactly mirroring `POST /tasks/:id/escalation/retry`'s own
>    identical choice for the same reason.
> 3. **The `mcp-approval-request` contract is optional, unlike every
>    other output contract in this codebase (review-verdict, subtask-
>    plan, pipeline-handoff).** Those three are mandatory — a missing or
>    malformed block is always a contract violation. Here, an agent with
>    a pending-approval grant may legitimately have nothing blocked to
>    report this run, so a totally absent block is NOT a failure — only
>    an *attempted-but-malformed* block (or one naming a server/tool this
>    run was never blocked on) fails closed. `mcpApprovalRequestBlockPresent`
>    (parse-mcp-approval-request.ts) is what tells the two apart, since
>    `parseMcpApprovalRequest` itself returns `null` for both.
> 4. **The follow-up needed an explicit trust-tier bypass, caught in
>    review, not foreseen by the original card.** `mcpAccessOverride`
>    (point 1 above) is resolved through the exact same
>    `resolveMcpGrants`/`splitGrantsByTrust` path as any other grant
>    (`claude-cli.ts`'s `runClaude`) — which reads a tool's trust tier
>    off the *server's* static `mcp-servers.yaml` declaration, not off
>    where the grant came from. Since the approved tool is, by
>    construction, declared `approval-required` on the server (that's
>    the only reason it was ever blocked), the follow-up's own grant
>    re-resolved into `pendingApproval` again — producing another
>    `mcp-approval-request` instead of a real call, forever. Fixed by
>    adding `RunClaudeOptions.mcpAccessPreApproved` (claude-cli.ts): when
>    true, every grant resolved for that one invocation is treated as
>    `auto` regardless of the server's declared trust tier, and the
>    split is skipped entirely. `readonly.ts`/`write.ts` set it to
>    `task.mcpAccessOverride !== undefined` — true only for a
>    human-approved follow-up, never for an agent's own regular
>    `agent.mcpAccess` grants, so the trust gate on ordinary agent
>    grants is unweakened. See `RunClaudeOptions.mcpAccessPreApproved`'s
>    own doc comment for the full reasoning.
>
> Two smaller, explicit judgment calls the card asked for directly: a
> **denied** request moves the original task to `failed` (not `done`) —
> the one thing it was waiting to do got rejected, so it didn't
> accomplish what it was asked to do, same reasoning escalation's own
> `abandon` action already holds. An **approved** request moves the
> original task to `done` (the card didn't ask for a justification here,
> but it's the same choice point) — its own job (describing the blocked
> call) is complete the moment a human acts on it, and leaving it frozen
> on `review` forever would also leave the Approve/Deny buttons visible
> on a dead card if its drawer were reopened — the same latent gap
> `POST /tasks/:id/escalation/retry` already has today: of escalation's
> three resolution actions, `retry` alone never changes the resolved
> card's own status, so a reopened drawer on that old card still renders
> "Retry" as if nothing had happened. Not this subtask's gap to fix, but
> worth citing as the reason `approve`/`deny` here both do change status.

> **Revision (subtask 6, shipped):** one real backend gap had to be
> filled that neither §3.5 nor the card's own text named explicitly:
> `McpServer.tools[].trust` was stored and enforced (subtask 3) but had
> no API surface to *change* after registration — only server-level
> `enable`/`disable` existed. Added `McpServerPool.setToolTrust`
> (mcp-server-pool.ts, mirrors `setEnabled`'s exact in-memory-mutate
> shape) and `setMcpServerToolTrust` (mcp-manifest.ts, mirrors
> `setMcpServerEnabled`'s Document-API round-trip, reaching one level
> deeper into the server's own `tools` YAMLSeq rather than a top-level
> field), plus `POST /mcp-servers/:id/tools/:tool/trust` (404s on an
> unknown server OR an unknown tool name on that server, 400s on a
> `trust` value that isn't `"auto"`/`"approval-required"`). In passing,
> fixed a stale doc comment on `McpServer.tools` itself (types.ts): it
> still said "NOT yet enforced — no approval-gate logic exists yet.
> That's a later, separate card" from subtask 1, left unupdated when
> subtask 3 actually shipped the enforcement — now points at
> `splitGrantsByTrust` and this subtask's own edit endpoint. The board
> panel reuses the harness panel's `.hm-row`/`.hm-row-main`/
> `.hm-row-label`/`.hm-row-meta`/`.hm-toggle`/`.hm-error`/`.hm-empty` CSS
> classes verbatim for both the per-server row and the nested per-tool
> rows, adding only `.hm-tools`/`.hm-tools-empty` for the indentation
> wrapper — no new row-level classes invented. e2e coverage
> (e2e/board.spec.ts, e2e/fixtures/mcp-servers.yaml) could not be
> **run** in this subtask's own sandbox (`/opt/pw-browsers/chromium`
> doesn't exist here, and `bun run test:e2e` itself requires an approval
> this session was never granted — the same sandbox-wide Playwright gap
> named in this project's prior subtasks, e.g. live-task-output and the
> Projects feature's UI subtasks) — written and hand-traced against the
> real DOM/endpoint wiring, confirmed via `bun test test/` (706 pass,
> including new dedicated `McpServerPool.setToolTrust`/
> `setMcpServerToolTrust`/`POST .../trust` unit+API tests that do run in
> this sandbox) and `bun run typecheck` (clean), but not observed
> running in a real browser. Named as an open item for whoever next has
> Playwright/subprocess access in this environment.

**`src/api/public/board.html`**: a "Manage MCP Servers" panel (mirrors
the existing Manage Harnesses panel exactly — enable/disable per server,
plus a second-level toggle per tool for its trust tier); the task
drawer's existing "Diff" section gains a "Tool calls" sibling, shown
based on which the result actually carries; the New Task form's repo
field becomes conditionally optional (same `required`-attribute toggling
convention the harness/model pickers already use elsewhere in this file).

## 5. What this deliberately does not do

- **No generic plugin marketplace or MCP server discovery.** Servers are
  registered by hand in `mcp-servers.yaml`, same as harnesses are today —
  finding/vetting third-party MCP servers is explicitly out of scope.
- **No new secrets vault.** MCP server credentials follow the exact same
  "name the env var, never the value" pointer convention
  `Harness.env`/`apiKeyEnv` already established — no new storage
  mechanism to build or audit.
- **No true mid-process pause/resume for approval.** Named plainly in
  §3.5 as a real, accepted limitation of v1 — the approval gate is a
  "describe, don't execute, then a human triggers a narrow follow-up"
  pattern, not a genuine elicitation primitive.
- **No retrofit of the legacy hardcoded implementer/reviewer loop
  (`finishResult`'s `handoffs.includes("reviewer")` branch) to understand
  MCP transcripts.** That loop stays diff-only, exactly as it is today.
  Heterogeneous (coding + MCP-tool) flows are built on the pipeline
  engine (§2, §4.7's proof), which already doesn't share this limitation.
- **No change to `Router`'s matching logic.** Confirmed in §2 it's
  already domain-agnostic; nothing here touches `src/core/router.ts`.
- **No per-MCP-tool-call cost/telemetry tracking.** `TaskResult
  .actualCost` stays scoped to the underlying LLM call's own token cost,
  same as today; a paid external API sitting behind an MCP server having
  its own billing is a real, separate concern, explicitly not solved
  here.

## 6. Subtasks

### 1. MCP server registry + pool
`mcp-servers.yaml` schema, `McpServerPool` (load/from/acquire/release),
per-server reachability check, `GET /mcp-servers` + `POST
/mcp-servers/:id/{enable,disable}` (see §4's revision callout — no
create/delete endpoints, matching `/harnesses`'s own actual surface).

**Acceptance criteria**
- Round-trip test: load a real `mcp-servers.yaml` fixture, list servers,
  enable/disable persists back to the file — same standard
  `test/harness-manifest.test.ts`/`test/harness-pool.test.ts` already
  hold their own equivalents to.
- A server whose reachability check fails shows `enabled: false` with a
  reason string, same UX as a harness that fails re-validation.

### 2. Per-agent MCP grants + executor wiring + transcript capture
`AgentDef.mcpAccess`, the `claude-cli.ts`/`codex-cli.ts` passthrough,
`TaskResult.mcpCalls` parsing out of the real `stream-json` stream.

**Acceptance criteria**
- A scripted `CommandRunner` test proves: an agent with no `mcpAccess`
  gets no MCP config passed to the invocation at all (today's exact
  behavior, byte-for-byte, for every existing agent).
- A scripted `CommandRunner` test proves: an agent with `mcpAccess:
  [{server: "x", tools: ["y"]}]` gets exactly that server+tool pair
  built into the invocation's config/allowedTools, no more.
- **First real, unscripted run** against a genuine (even trivial/local)
  MCP server, confirming the actual `stream-json` event shape for a tool
  call matches what §3.4 assumes — this is the one concrete unknown
  named in §3.4; this subtask resolves it empirically before anything
  downstream depends on the assumed shape.
- `mcpCalls` parsing is covered by a gate test fed a real captured
  `stream-json` transcript fixture (from the above), not a hand-invented
  one.

### 3. Tool-level trust tiers + v1 approval gate
Per-tool `trust` field, the exclude-from-`--allowedTools` +
describe-don't-execute pattern, the human-triggered follow-up-call path.

**Acceptance criteria**
- An `approval-required` tool is never present in the built
  `--allowedTools` list for any run, regardless of the agent's
  `mcpAccess` declaring it — fails closed, same discipline every other
  contract in this codebase already holds.
- A human's approval action (board UI) creates a new, narrow follow-up
  task scoped to exactly the one named tool call — not a resumption of
  the original agent session.

### 4. Non-diff review contract
`AgentDef.reviewTarget`, `formatMcpTranscript`, the reviewer prompt
branching on which shape a result actually carries, `GET
/tasks/:id/mcp-calls`, the task drawer's "Tool calls" section.

**Acceptance criteria**
- A reviewer agent run against a `reviewTarget: "tool-calls"` result
  receives the formatted transcript in its prompt, never a diff — and
  vice versa, a `"diff"` (or undefined, the default) result is completely
  unaffected by any of this subtask's changes.
- Board UI: a task with `mcpCalls` set shows the "Tool calls" section; a
  task with `worktree`/a diff shows "Diff"; a task with neither shows
  neither (never a broken/empty section rendered regardless).

> **Revision (subtask 4, review round 1):** the acceptance criterion
> above ("a task with neither shows neither") described gating the
> "View diff" button on `result.worktree`, the way "View tool calls" is
> gated on `result.mcpCalls`. That shipped initially but was a real
> regression, caught in review: `result.worktree` is the wrong signal
> for "a diff is available" — it only reflects whether *this task's own
> run* produced a worktree, which is false in two real cases where a
> diff genuinely is fetchable: a never-run task (no result yet at all,
> so the button disappeared permanently rather than just before the
> first result arrives) and every reviewer task (`ReadOnlyExecutor`
> never sets `worktree` on its own `TaskResult`, even though its `repo`
> points at the implementer's worktree and `GET /tasks/:id/diff`'s own
> existing fallback can diff it). Fixed by reverting "View diff" to
> always render unconditionally — same as before this subtask touched
> it — and relying on the diff endpoint's own graceful "isn't a git
> working tree" / "No changes yet." messages for the genuinely-nothing-
> to-show case instead of pre-emptively hiding the button. "View tool
> calls" keeps the `result.mcpCalls` gate as-is: unlike diff, there's no
> fallback endpoint message and no ambient state to discover for a
> tool-calls review, so a result either carries the transcript or there
> is nothing to show, full stop. Net effect: "a task with neither shows
> neither" now only holds for the Tool-calls section, not for Diff.

### 5. Optional repo + scratch workspace
`TaskCard.repo` optional-when-no-file-access validation in `POST
/tasks`, `src/services/scratch-workspace.ts`, New Task form's
conditional `required` toggle.

**Acceptance criteria**
- `POST /tasks` with no `repo` and labels that route to a write-tier (or
  bash-capable) agent 400s with a clear error — `repo` is still mandatory
  for anything that can touch a filesystem, no silent scratch-dir
  fallback for that case.
- `POST /tasks` with no `repo` and labels routing to a readonly, no-bash
  agent succeeds, and the resulting run's `cwd` is a real, created
  `~/.wissel/scratch/<taskId>` directory.

### 6. Board UI: Manage MCP Servers panel — shipped
Mirrors the Manage Harnesses panel exactly — list, enable/disable per
server, per-tool trust toggle. See §4's fifth revision callout for the
one real backend gap this subtask had to fill (no prior API surface to
edit a tool's trust tier) and the Playwright/sandbox caveat on its e2e
coverage.

**Acceptance criteria**
- e2e: enable/disable a registered server, assert the real `POST
  /mcp-servers/:id/...` request body, same discipline this project's
  existing harness-panel/project-panel e2e specs already hold (real
  outgoing request body asserted, not just that a button is clickable).

### 7. Proof: a heterogeneous pipeline (coding step + MCP-tool step)
A real `PipelineDef` with one step bound to an existing coding agent and
one step bound to a new MCP-tool-calling agent, run end to end via
`startPipelineRun` — the integration proof that this generalizes, mirrors
exactly how `docs/SDD-pipelines.md` §6 Subtask 5 proved the engine
against the review-handoff loop.

**Acceptance criteria**
- A live smoke test (real `claude`, real MCP server, real pipeline run)
  reaching `done`, with the MCP step's `mcpCalls` visible on its own
  step's `TaskCard` the same way a coding step's diff already is.

> **Revision (subtask 7, shipped):** this subtask's own card asked a
> direct question up front — "does `pipeline-runner.ts` need any changes
> at all to make this work?" — and named it as the single most useful
> finding the subtask could report, whichever way it went. The direct
> answer is **mixed, not a clean yes or no**:
>
> 1. **For the ordinary case (a coding step followed by an `auto`-trust
>    MCP-tool-calling step), the "likely good news" held exactly as
>    predicted: zero changes to `pipeline-runner.ts`.**
>    `runStepAndSuccessors` only ever calls `executor.run()` — the MCP
>    wiring (grant resolution, `--mcp-config`/`--allowedTools` building,
>    `mcpCalls` transcript parsing) lives entirely inside
>    `ReadOnlyExecutor`/`runClaude`, already exercised by `POST
>    /tasks/:id/run` for an ordinary task, and composes by pure
>    construction: a pipeline step's `TaskCard` is dispatched through the
>    exact same `executor.run(created, agent, harness)` call, carrying
>    the exact same `agent.mcpAccess`. `eval/pipeline-mcp-integration.eval.ts`'s
>    Scenario 1 is the live proof of this half.
> 2. **For the approval-gate composition (subtask 3's "describe, don't
>    execute" path reached from inside a pipeline step), two real,
>    concrete bugs existed and needed fixing** — exactly the kind of
>    finding the card asked to be surfaced rather than assumed away:
>    - `finishResult`'s pipeline-step branch (`src/core/orchestrator.ts`)
>      ran its own unconditional `board.move(task.id, result.ok ? "done"
>      : "failed")` *before* ever checking `result.mcpApprovalRequest` —
>      a pipeline step that successfully describes a blocked call
>      (`result.ok` stays `true` for a well-formed request, see
>      `runClaude`) landed straight on `"done"`, silently succeeding
>      instead of surfacing the approval gate at all. The non-pipeline
>      path a few lines down already checked this first; the pipeline
>      branch didn't mirror that priority order. Fixed by checking
>      `result.mcpApprovalRequest` first, inside the pipeline branch,
>      calling `board.requestMcpApproval` and returning without ever
>      calling `handlePipelineStepResult` — the step hasn't settled,
>      it's parked on a human decision, the same v1 limitation §3.5
>      already named, now also true for a pipeline step.
>    - `pipeline-runner.ts`'s own `settleRoot` declared the whole run
>      `"done"` the moment no step had *failed* — even with a step still
>      parked on `"review"` awaiting that same human decision. Fixed by
>      treating any `"review"`-status step under the run as "not settled
>      yet": the run now stays `"running"` instead, with no mechanism in
>      this phase to resume it once the approval is later resolved (the
>      follow-up task `POST /tasks/:id/mcp-approval/approve` spawns is a
>      standalone task, never a resumption of the run — the same
>      already-named v1 limitation again, not a new gap).
>
>    Both are gate-tested against a scripted stand-in
>    (`test/pipeline-runner.test.ts`) that reproduces the exact failure
>    mode `eval/pipeline-mcp-integration.eval.ts`'s own live Scenario 2
>    would otherwise have hit silently, with no live run required to
>    catch it.
>
> Two further judgment calls, stated plainly: `mcp-tool-caller`
> (agents/manifest.yaml) was added as a **permanent** agent, not a
> test-local registry entry — mirroring how `pipeline-reviewer` was
> added permanently for `docs/SDD-pipelines.md` §6 Subtask 5's own proof
> — reasoning: a generic "call this run's granted MCP tool and report"
> agent is reusable by any future pipeline step, and it's completely
> inert in production (its grant names `wissel-echo-mcp`, a server id
> the real `mcp-servers.yaml` never registers, so `resolveMcpGrants`
> drops it to `[]` everywhere outside the eval's own pool). The MCP
> server itself (`eval/fixtures/mcp-echo-server.ts`) is deliberately
> **not** a `mcp-servers.yaml` entry, even though the agent pointing at
> it is permanent — a stdio server's `command`/`args` are spawned with
> the *task's own cwd*, never the repo root, so a portable, checked-in
> path can't be hardcoded the way the file's own doc-comment examples
> assume; the eval computes an absolute path at run time instead
> (`import.meta.dir`), the same way `test/claude-cli.test.ts`'s own
> `mcpServer()` helper already builds fixture servers inline rather than
> editing the checked-in registry.
>
> **Not yet empirically run.** Same situation as this project's other
> evals when first written: the implementer session that built this
> subtask had every subprocess spawn blocked by its sandbox (not even
> `bun run eval/fixtures/mcp-echo-server.ts` alone could be executed to
> confirm the hand-rolled server completes a real JSON-RPC handshake), so
> neither scenario of `eval/pipeline-mcp-integration.eval.ts` has actually
> been run against a real `claude` process or a real spawned MCP server.
> The two orchestrator fixes above are gate-tested, not just hand-traced,
> but the live eval itself — and with it, the first real observation of
> whether a granted MCP tool truly surfaces as `mcp__wissel-echo-mcp__echo`
> in practice, the one piece §4's "Revision (subtask 2, shipped)" callout
> named as corroborated-but-not-observed — remains open empirical work for
> whoever next has subprocess access. See `eval/README.md`'s own
> "pipeline-mcp-integration eval" section for the full pass bar.

## 7. Sequencing

1 blocks 2. 2 blocks 3 and 4 (4 only needs 2's transcript capture, not
3's approval gate — can proceed in parallel with 3 once 2 lands). 5 is
fully independent of 1-4, can run in parallel from the start. 6 needs 1
and (for the per-tool trust toggle specifically) 3. 7 needed 2 and 4 both
fully working — it's the integration proof, not a standalone piece, and
landed after both, same discipline `docs/SDD-pipelines.md` §7 already
held its own Subtask 5 to. All seven subtasks have now shipped.

## 8. Verification

Same standard every prior SDD in this project has been held to: gate
tests for every pure function (config-building, transcript formatting,
the optional-repo validation) with no real process spawn where avoidable;
a real, unscripted run specifically for subtask 2's stream-json shape
question, since that's a genuine unknown this doc can't verify by
reading code alone; e2e coverage for the new UI panel; `bun run
typecheck` + `bun test test/` green before any of this is called done.
