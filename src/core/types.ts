export type AgentTier = "service" | "readonly" | "write";
export type TrustLevel = "low" | "medium" | "high";
/** "agent" is a full task handler (triage, plan, implement); "skill" is a
 *  narrower, more mechanical capability (draft a commit message, fix
 *  lint). Both route and dispatch identically — kind is a fleet-view/CLI
 *  label, not a separate code path. */
export type FleetKind = "agent" | "skill";

/** What running this agent is expected to cost. Estimates are fine —
 *  the spec only requires that a dispatch always carries a number.
 *
 *  `model` here is only the last-resort default in the model-resolution
 *  precedence order, most specific wins:
 *    executor constructor override (tests/evals only)
 *    > TaskCard.model
 *    > Harness.model
 *    > AgentDef.costProfile.model
 *  An explicit override at any level that can't actually be resolved
 *  (unknown model id, harness that doesn't support it) fails loud —
 *  never silently falls through to the next level. This is distinct
 *  from the pre-existing "harness pool has zero enabled candidates for
 *  this tool" case (HarnessPool.acquire returning undefined), which
 *  stays silently-tolerant by existing design — that's "no harness
 *  available," not "an explicit override couldn't be honored." */
export interface CostProfile {
  model: string;
  estUsdPerTask: number;
}

export interface AgentDef {
  id: string;
  name: string;
  kind: FleetKind;
  tier: AgentTier;
  /** What this agent is. */
  description: string;
  /** What kind of task should land here. Read by the router. */
  whenToUse: string;
  tags: string[];
  executor: string;
  /** Agents this one may hand off to. Read by the router to restrict a
   *  follow-up task's (`TaskCard.parentTaskId`) candidates to exactly
   *  this list. Undefined means "never declared a handoff graph" — the
   *  router falls back to the full registry, unrestricted. `[]` is a
   *  different, deliberate thing: "declared, and hands off to no one" —
   *  a follow-up task under this agent has zero eligible candidates. */
  handoffs?: string[];
  /** Capability contract, data-first: what this agent consumes, what it
   *  produces, what running it costs, how much it's trusted to act
   *  unsupervised, and what it's allowed to touch. Routing logic reads
   *  this; nothing here is inferred from tier or tags. */
  inputs: string[];
  outputs: string[];
  costProfile: CostProfile;
  trustLevel: TrustLevel;
  toolAccess: string[];
  /** Which specific tools on which specific MCP servers this agent may
   *  call — an open-ended axis alongside toolAccess's closed enum,
   *  additive and orthogonal to both toolAccess and tier (a readonly-tier
   *  agent can carry this with zero file access — e.g. "read a ticket via
   *  an MCP server, answer a question," still dispatched through
   *  ReadOnlyExecutor, still zero git/worktree involvement; a write-tier
   *  agent can carry both). No new tier value — tier stays exactly
   *  "file/bash blast radius." Resolved against the real McpServerPool at
   *  dispatch time by the claude-cli/codex-cli executors, which build the
   *  MCP config for ONLY these exact server+tool pairs — never "attach
   *  every registered server." Undefined (the default, every agent in
   *  agents/manifest.yaml today) means no MCP grants at all — a pure
   *  addition with zero effect on any agent that doesn't declare it. See
   *  docs/SDD-mcp-orchestration.md §3.2. */
  mcpAccess?: { server: string; tools: string[] }[];
  /** What a reviewer following this agent's handoffs is judging:
   *  `"diff"` (the default — undefined means `"diff"`, today's unchanged
   *  behavior for every agent in agents/manifest.yaml) means the review
   *  task's body is a plain copy of the implementer's own body, same as
   *  always, with the reviewer discovering the diff itself at runtime via
   *  its own `repo` (see spawnReviewerTask, src/core/orchestrator.ts).
   *  `"tool-calls"` means this agent's run has no worktree/file-change
   *  state for a reviewer to discover on its own (no `repo`, no diff) —
   *  so spawnReviewerTask instead embeds the run's own
   *  `TaskResult.mcpCalls`, formatted by `formatMcpTranscript`
   *  (src/services/mcp-transcript.ts), directly into the review task's
   *  body. See docs/SDD-mcp-orchestration.md §3.4. */
  reviewTarget?: "diff" | "tool-calls";
  /** Narrow, explicit exception to wissel's one non-negotiable
   *  write-tier policy — a human reviews every write-tier success
   *  before it's "done" (see finishResult). Setting this true lets THIS
   *  agent's successful write-tier runs skip that stop and land straight
   *  on `done` instead. Only takes effect when `trustLevel` is also
   *  `"high"` — the two conditions are required together on purpose, so
   *  a manifest typo (or a copy-pasted entry) on a lower-trust agent
   *  can't silently bypass review. A worktree-run result still gets
   *  merged for real (git merge --no-ff, same as a human clicking
   *  Merge); a merge conflict falls back to the normal `review` stop
   *  rather than pretending to succeed. Undefined (the default) means
   *  no exception — every write-tier success from this agent stops for
   *  a human, unchanged. See docs/SDD-worktree-isolation.md §6. */
  autoMerge?: boolean;
  /** Agent-specific output contract, appended verbatim to the end of the
   *  prompt by buildAgentPrompt when present. Two agents set this today
   *  (see agents/manifest.yaml): reviewer, whose final message must end
   *  with a ```review-verdict``` fenced block, and memory-curator, whose
   *  final message becomes the literal, wholesale replacement for
   *  memory/lessons.md (see finishResult's `outputs.includes
   *  ("memory-entries")` hook, src/core/orchestrator.ts) and so must
   *  contain nothing but the curated content itself — no preamble, no
   *  sign-off. Plain prose instructions by default; whether the raw
   *  output additionally gets machine-parsed and rejected when
   *  non-conforming is controlled separately by outputContractFormat
   *  below. Undefined means "no contract beyond description/whenToUse"
   *  — the prior behavior. */
  outputContract?: string;
  /** Discriminates *how* outputContract (above) is enforced, not just
   *  displayed. `"review-verdict"` is what makes runClaude
   *  (src/executors/claude-cli.ts) route the raw final message through
   *  parseReviewVerdict and fail the run outright on a missing/malformed
   *  block, instead of trusting it as plain prose. `"subtask-plan"` is
   *  the same idea for the planner: routes the raw final message through
   *  parseSubtaskPlan (src/executors/parse-subtask-plan.ts) and fails
   *  the run on a missing/malformed block. Deliberately a separate field
   *  from outputContract itself — an agent can have prose-only
   *  formatting instructions (memory-curator) without being forced
   *  through either parser, which would reject every one of its runs for
   *  lacking a block it was never asked to produce. Undefined means "no
   *  machine parsing beyond the is_error the harness itself reports" —
   *  outputContract text still reaches the prompt, its content just
   *  isn't validated downstream. */
  outputContractFormat?: "review-verdict" | "subtask-plan" | "pipeline-handoff";
  /** Agent-specific self-verification instructions, appended verbatim to
   *  the prompt by buildAgentPrompt when present — same mechanism as
   *  outputContract, different purpose: tells the agent to actually run
   *  something (e.g. `bun run typecheck` && `bun test test/`) and fix
   *  failures before reporting done, instead of shipping unverified
   *  code. Pair it with the matching Bash allowlist on whatever executor
   *  runs this agent (see WriteExecutor's `allowedTools`) so the
   *  commands it's told to run are guaranteed to actually run, rather
   *  than depending on the permission mode's own (empirically
   *  inconsistent — see allowedTools' doc comment) Bash gating.
   *  Undefined means no self-verification instruction is added —
   *  today's behavior. */
  verificationContract?: string;
}

/** The reviewer agent's mandated final-message contract: a
 *  ```review-verdict``` fenced block containing exactly this shape,
 *  nothing more permissive. See parseReviewVerdict, which is the only
 *  code allowed to construct one from raw text — never hand-roll a
 *  fallback verdict elsewhere. */
export interface ReviewVerdict {
  verdict: "approve" | "changes_requested";
  feedback: string;
}

/** The planner agent's mandated final-message contract: a
 *  ```subtask-plan``` fenced block containing a JSON array of exactly
 *  this shape, nothing more permissive. See parseSubtaskPlan, which is
 *  the only code allowed to construct one from raw text — never
 *  hand-roll a fallback plan elsewhere. `dependsOnIndex`, when present,
 *  is the index of another item earlier in the same array (never forward,
 *  never self) — how the orchestrator chains a spawned subtask's
 *  `dependsOn` against the sibling ids it just created in this same call. */
export interface SubtaskPlanItem {
  title: string;
  body: string;
  labels: string[];
  dependsOnIndex?: number;
}

/** A single step in a `PipelineGraph` — bound to exactly one agent
 *  (chosen by the canvas editor's agent picker), never resolved by the
 *  fuzzy router: pipeline-runner.ts looks the agent up directly by id,
 *  since the whole point of authoring a pipeline is naming exactly which
 *  agent runs each step. See docs/SDD-pipelines.md §3.4/§3.6. */
export interface PipelineStepDef {
  id: string;
  name: string;
  agentId: string;
  /** "choose": this step's own pipeline-handoff `next` field picks
   *  exactly one outgoing edge. "all": every outgoing edge activates
   *  regardless of what `next` says (fan-out) — `next` isn't required
   *  at all for an "all" step. */
  transition: "choose" | "all";
  /** Only meaningful for a step with more than one incoming edge. "any"
   *  fires the moment the first predecessor completes; "all" waits for
   *  every predecessor under the same pipelineRunId to reach a terminal
   *  state first. Undefined defaults to "any". */
  joinMode?: "any" | "all";
}

/** A labelled connection between two steps. `label` is the last-resort
 *  match a "choose" step's `next` field resolves against — name, then
 *  id, then this label, first match wins (see resolveNext,
 *  pipeline-runner.ts). */
export interface PipelineEdgeDef {
  id: string;
  from: string;
  to: string;
  label?: string;
}

/** The full step/edge graph a pipeline definition's `graph` column
 *  stores — opaque to everything except the canvas editor and
 *  pipeline-runner.ts (see docs/SDD-pipelines.md §3.7). */
export interface PipelineGraph {
  steps: PipelineStepDef[];
  edges: PipelineEdgeDef[];
}

/** A stored, reusable pipeline definition — see src/services/pipelines.ts
 *  (storage) and src/core/pipeline-runner.ts (execution). */
export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  graph: PipelineGraph;
  createdAt: string;
  updatedAt: string;
}

/** The shape of one described-but-blocked MCP tool call — both the
 *  agent's own request (TaskResult.mcpApprovalRequest, parsed by
 *  parse-mcp-approval-request.ts out of a trailing ```mcp-approval-
 *  request``` fenced block) and the durable record of it a human acts on
 *  (TaskCard.pendingMcpApproval) share this exact shape, so there's
 *  never a lossy translation between "what the agent asked for" and
 *  "what the board shows a human." See docs/SDD-mcp-orchestration.md
 *  §3.5. */
export interface McpApprovalRequest {
  server: string;
  tool: string;
  args: unknown;
  reason: string;
}

/** A pipeline step's mandated final-message contract: a
 *  ```pipeline-handoff``` fenced block containing this shape. See
 *  parsePipelineHandoff, the only code allowed to construct one from raw
 *  text. `next` is required for a "choose" step, optional (and ignored)
 *  for an "all" (fan-out) step — the parser doesn't know which kind of
 *  step produced this, so it accepts either shape; pipeline-runner.ts is
 *  what enforces the per-step requirement. `data` is a free-form object
 *  the next step's composed prompt is built from — see
 *  docs/SDD-pipelines.md §3.4/§3.5. */
export interface PipelineHandoff {
  next?: string;
  data?: Record<string, unknown>;
  note?: string;
}

/** A registered project/repo — the durable backing for what
 *  `TaskCard.repo` today is just a free-typed string for. See
 *  src/services/projects.ts (storage/CRUD, two creation paths: a local
 *  folder already on disk, or a fresh GitHub clone). */
export interface Project {
  id: string;
  name: string;
  path: string;
  source: "local" | "github";
  sourceUrl?: string;
  createdAt: string;
  /** A cached, one-paragraph plain-language summary of what this project
   *  does — see src/services/project-eli5.ts. Generated lazily (on the
   *  first `GET /projects/:id/eli5` that finds it missing) and cached
   *  here rather than regenerated on every board render — an LLM call
   *  per page load would be both slow and a real, avoidable cost.
   *  Undefined until first generated. */
  eli5?: string;
  /** When `eli5` was last (re)generated — undefined alongside `eli5`
   *  itself. Lets the UI show staleness and offer a manual refresh
   *  rather than silently trusting a summary that may predate the
   *  project's current state. */
  eli5UpdatedAt?: string;
}

export interface TaskCard {
  id: string;
  title: string;
  body: string;
  labels: string[];
  /** Required only for a task that will route to a write- or
   *  bash-capable agent (checked against `toolAccess`, not `tier`
   *  directly, at `POST /tasks` time — see src/api/server.ts). A task
   *  that resolves to a readonly, no-file-access agent (e.g. "check
   *  Jira, post to Slack") can omit this entirely; its run's `cwd`
   *  falls back to a scratch directory instead — see
   *  resolveScratchWorkspace, src/services/scratch-workspace.ts, and
   *  docs/SDD-mcp-orchestration.md §3.3/§4 (Subtask 5). Undefined means
   *  "no repo named," never "unknown" — a task that's never been
   *  routed yet can still legitimately have no repo. */
  repo?: string;
  /** dispatched: routed to a write-tier agent and handed off — wissel
   *  isn't the one running it, so it waits for an external result.
   *  no-match: routing stopped before spend because nothing matched
   *  confidently; see the task's recorded RoutingDecision for why.
   *  pending-review: an implementer's result is queued for a reviewer
   *  agent's automated pass, distinct from `review` (a human's queue).
   *  escalated: a reviewer requested changes `pushbackCount` times
   *  without resolution and kicked it to a human — see
   *  `escalationContext`. */
  status: "inbox" | "ready" | "running" | "dispatched" | "review" | "done" | "failed" | "no-match" | "pending-review" | "escalated";
  routedTo?: string;
  /** Task ids this one is blocked on. Absent/empty means unblocked. */
  dependsOn?: string[];
  /** Set when this task is a follow-up spawned by another — distinct
   *  from dependsOn, which only means "blocked until." When present,
   *  routing restricts candidates to the parent's routed agent's
   *  declared `handoffs`, if it has any (see AgentDef.handoffs). */
  parentTaskId?: string;
  /** Which Harness actually ran this — set once wissel starts executing
   *  it locally (readonly, or write-tier with executeWriteTier on),
   *  before the run finishes, so the board can show it as active live.
   *  Never set for a `dispatched` task: wissel hands those to agetor and
   *  has no visibility into which harness agetor runs them under. */
  harness?: string;
  /** Per-task model override — see the precedence order documented next
   *  to CostProfile. Undefined means "no task-level override," falling
   *  through to Harness.model / AgentDef.costProfile.model. An
   *  unresolvable explicit value here fails the run loud, never
   *  silently falls back to a lower-precedence model. */
  model?: string;
  /** A human/API request for which Harness this task should run under —
   *  distinct from `harness` above: `harnessOverride` is a request set
   *  before the task runs, `harness` is a fact stamped once it actually
   *  starts running and is never read back for dispatch. Undefined
   *  means "no request," so routing/dispatch picks a harness the normal
   *  way (HarnessPool.acquire). An id that doesn't resolve to a real,
   *  enabled harness fails the run loud rather than silently falling
   *  back to the normal pick. */
  harnessOverride?: string;
  /** A task-level override of the routed agent's own declared
   *  `mcpAccess` — same "task override beats the manifest-level default"
   *  shape as `harnessOverride`/`model` above, just for MCP grants
   *  instead of harness/model choice. Read by every executor as
   *  `task.mcpAccessOverride ?? agent.mcpAccess` (see readonly.ts/
   *  write.ts/codex-readonly.ts/codex-write.ts) — undefined (every task
   *  before this field existed) falls straight through to the routed
   *  agent's own manifest declaration, byte-identical to today.
   *
   *  This is this subtask's own concrete mechanism for §3.5/§6's
   *  "narrow follow-up run scoped to exactly the one named tool call" —
   *  the SDD names the *shape* ("whose mcpAccess is scoped to exactly
   *  the one server+tool") but TaskCard itself has no `mcpAccess` field
   *  to scope (only AgentDef does); routing a follow-up to an existing
   *  agent and narrowing just *that task's* grant via this override,
   *  rather than fabricating a one-off AgentDef per approval, is the
   *  cleanest fit with the override pattern this codebase already
   *  established for harness/model. See `POST
   *  /tasks/:id/mcp-approval/approve`, src/api/server.ts.
   *
   *  Presence of this field (not its contents) is also the exact signal
   *  readonly.ts/write.ts use to set RunClaudeOptions.mcpAccessPreApproved
   *  — the one named server+tool pair here is, by construction, the one
   *  a human just approved, so it's treated as `auto` for this run
   *  regardless of the server's own still-`approval-required`
   *  declaration (see mcpAccessPreApproved's own doc comment in
   *  claude-cli.ts). Without that bypass, the follow-up would re-resolve
   *  the same tool against the same server declaration and land right
   *  back in `pendingApproval` — an approval that can never actually
   *  execute. */
  mcpAccessOverride?: { server: string; tools: string[] }[];
  /** Set when a result for this task carried `TaskResult
   *  .mcpApprovalRequest` (see finishResult, src/core/orchestrator.ts) —
   *  the durable, human-facing record of the one blocked MCP call an
   *  agent described wanting to make, landed on the existing `"review"`
   *  human queue rather than a new status value (mirrors how
   *  `escalationContext` reuses `"escalated"` instead of inventing a
   *  parallel status). Like `escalationContext`, this is never cleared
   *  once resolved (approve/deny) — `status` moving off `"review"` is
   *  what the board UI actually gates showing the approval panel on, not
   *  this field's presence alone. See `POST /tasks/:id/mcp-approval/
   *  {approve,deny}`, docs/SDD-mcp-orchestration.md §3.5/§6. */
  pendingMcpApproval?: McpApprovalRequest;
  /** How many times a reviewer has sent this task's lineage back with
   *  `changes_requested`. Incremented each pushback round; distinct from
   *  a plain retry count because it's scoped to the review loop, not to
   *  execution failures. Undefined/0 means never pushed back. */
  pushbackCount?: number;
  /** Groups every attempt in one review-pushback chain (original attempt
   *  plus every re-attempt spawned by `changes_requested`) under a single
   *  id, set on the first attempt and carried forward by each
   *  `supersededBy` re-attempt — how a human or the board reconstructs
   *  "everything that happened trying to land this card" across rows
   *  that are otherwise separate TaskCards. */
  reviewLineageId?: string;
  /** Id of the re-attempt TaskCard spawned to replace this one after a
   *  pushback — set on the superseded (old) card, never on the new one.
   *  Undefined means either this card hasn't been superseded, or it IS
   *  the newest attempt in its lineage. */
  supersededBy?: string;
  /** Why a task landed on `escalated` instead of another pushback round
   *  — e.g. pushbackCount hit its limit, or the reviewer's feedback was
   *  the same unresolved issue twice in a row. Set only when
   *  status === "escalated"; a human reads this instead of replaying the
   *  whole reviewLineageId chain to find out why it stalled. */
  escalationContext?: string;
  /** Set when a claude-cli run failed with a detected session-limit
   *  (429) error whose reset time could be parsed — see
   *  parseSessionLimitReset and runClaude in
   *  src/executors/claude-cli.ts. `finishResult` reschedules the task
   *  (Board.scheduleRetry) instead of failing it outright; `sweep()`
   *  treats a task with a future `retryAfter` as ineligible, the same
   *  way a blocked `dependsOn` is. ISO timestamp; undefined means no
   *  pending retry. */
  retryAfter?: string;
  /** Stamped by Board.move every time this task's status transitions to
   *  `"done"` — the one reliable "became done" marker, since every path
   *  that can produce `done` (finishResult's several branches,
   *  resumeAfterApproval, a human's `POST /tasks/:id/merge`) goes
   *  through `move()`. Re-entering `done` refreshes it — last time in
   *  wins, no special-casing for a hypothetical re-open. What
   *  `findArchivableRoots` (src/core/archive-scheduler.ts) measures the
   *  24h auto-archive threshold against. ISO timestamp; undefined means
   *  this task has never been `done`. See docs/SDD-task-archiving.md
   *  §3.2. */
  doneAt?: string;
  /** Set by Board.archive — a visibility concern layered on top of
   *  `status`, exactly like `supersededBy`: an archived task keeps
   *  whatever status it had, is never deleted, and stays queryable by
   *  id. Only the default board/swimlane views stop showing it (UI-layer
   *  filtering, not a `Board.list()` behavior change — see
   *  docs/SDD-task-archiving.md §3.1). Archiving cascades down the
   *  `parentTaskId` tree from whatever id was archived; `Board.unarchive`
   *  clears this on exactly one row and never cascades (§3.6). ISO
   *  timestamp; undefined means not archived. */
  archivedAt?: string;
  /** Which stored PipelineDef this task belongs to — set on the root
   *  pipeline task and every one of its step tasks, undefined for every
   *  non-pipeline task. See docs/SDD-pipelines.md §3.7. */
  pipelineId?: string;
  /** Groups every task under one pipeline run — the root task and every
   *  step task it spawned. Undefined on the root task itself (its own id
   *  IS the run id, the same "reuse the originating id" pattern
   *  `reviewLineageId` already established — see resolveRunId,
   *  src/core/pipeline-runner.ts); always explicitly set on every step
   *  task. */
  pipelineRunId?: string;
  /** Which step in the pipeline definition's graph this task is a live
   *  instance of. Undefined on the root task (which isn't a step
   *  instance itself). */
  pipelineStepId?: string;
}

/** A named execution backend wissel can run work under — a tool (which
 *  CLI, or the raw API) plus an account (which authenticated identity).
 *  Distinct from AgentDef: an agent is a routing-target descriptor
 *  ("what kind of work is this"); a Harness is "which credentialed
 *  process actually runs it." See docs/SDD-execution-harnesses.md.
 *
 *  "anthropic-api" calls the Anthropic Messages API directly — no
 *  subprocess, no file/tool access, just a prompt in and an answer out
 *  (see ApiExecutor). It exists for agents/skills that genuinely don't
 *  need claude-cli's full agentic harness. "codex-cli" is OpenAI's Codex
 *  CLI (binary `codex`) — a second full agentic subprocess harness,
 *  same shape as claude-cli, just a different tool/account pair (see
 *  docs/SDD-codex-cli-harness.md). */
export type HarnessTool = "claude-cli" | "anthropic-api" | "codex-cli";

export interface Harness {
  id: string;
  tool: HarnessTool;
  label: string;
  enabled: boolean;
  /** claude-cli and codex-cli only: env overrides applied to the spawned
   *  process — how a harness picks an already-authenticated account
   *  without wissel holding a secret itself. A pointer (e.g.
   *  CLAUDE_CONFIG_DIR, CODEX_HOME) to credentials that already live
   *  somewhere else, never a raw API key/token value. */
  env?: Record<string, string>;
  /** anthropic-api only: the NAME of the environment variable holding
   *  the API key (e.g. "ANTHROPIC_API_KEY_PERSONAL") — read at request
   *  time, never stored on the Harness itself. Same "pointer, not
   *  secret" contract as `env` above, since an API key is a real secret
   *  and can't live inline in a checked-in harnesses.yaml the way a
   *  config-dir path can. Undefined means "resolve ambiently" — the
   *  SDK's own ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN resolution. */
  apiKeyEnv?: string;
  /** Why `enabled` is false, when it's false for a reason other than a
   *  human's own choice — e.g. "not authenticated" (set by
   *  validateHarness/discovery). Undefined when enabled is true, OR
   *  when a human explicitly disabled it themselves (see
   *  HarnessPool.setEnabled) — the "Manage harnesses" panel needs to
   *  tell "disabled because you turned it off" apart from "disabled
   *  because it can't work right now" without guessing from context.
   *  See docs/SDD-harness-enable-disable.md §4. */
  disabledReason?: string;
  /** Per-harness default model — only meaningful once resolved through
   *  the precedence order documented next to CostProfile (it sits below
   *  TaskCard.model and above AgentDef.costProfile.model). Undefined
   *  means "no harness-level default," falling through to
   *  costProfile.model. */
  model?: string;
}

/** An external tool surface an agent can reach once it's running — Slack,
 *  a database, a ticketing system, etc. Distinct from Harness on purpose:
 *  a Harness answers "whose account does the CLI process run as"
 *  (identity/auth); an McpServer answers "what capability can the agent
 *  reach" (capability). Orthogonal axes — never bolted onto Harness
 *  itself. See docs/SDD-mcp-orchestration.md §3.1.
 *
 *  Unlike HarnessPool.acquire(), which picks exactly one harness per
 *  task (only one account can drive a given CLI process), a single
 *  agent run may use multiple MCP servers at once — each one
 *  independently acquired/released as its own tools get called. See
 *  McpServerPool in mcp-server-pool.ts. */
export interface McpServer {
  id: string;
  label: string;
  transport: { kind: "stdio"; command: string; args: string[] } | { kind: "sse" | "http"; url: string };
  /** Name-the-env-var-never-the-value — same pointer convention
   *  Harness.env/apiKeyEnv already hold. */
  env?: Record<string, string>;
  /** Stored and round-tripped by this subtask, but NOT yet enforced —
   *  no approval-gate logic exists yet. That's a later, separate card. */
  tools: { name: string; trust: "auto" | "approval-required" }[];
  enabled: boolean;
  /** Why `enabled` is false, when it's false for a reason other than a
   *  human's own choice — e.g. "not reachable" (set by a failed
   *  reachability check). Mirrors Harness.disabledReason's own role. */
  disabledReason?: string;
}

export interface Candidate {
  agentId: string;
  score: number;
  reason: string;
}

export interface RoutingDecision {
  taskId: string;
  matchedTags: string[];
  /** Every candidate considered, ranked. The rejected ones and their
   *  scores are the debugging surface for a wrong route. */
  candidates: Candidate[];
  /** Null when nothing was confident enough to dispatch — a zero match,
   *  a weak match, or an unresolved tie. Never a guess. */
  selected: string | null;
  /** False stops the task before spend: no executor runs, no cost is
   *  incurred. See `reason` for which no-confident-match case this was. */
  confident: boolean;
  reason: string;
  strategy: "rule" | "embedding" | "llm" | "manual";
  decidedAt: string;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  ok: boolean;
  summary: string;
  artifacts?: string[];
  /** Actual spend, when known. Estimated cost is logged at dispatch time
   *  regardless; this fills in the real number once the run is over. */
  actualCost?: number;
  /** Which Harness actually ran this, when one was picked. */
  harnessId?: string;
  /** Set by WriteExecutor/CodexWriteExecutor when the run happened
   *  inside an isolated git worktree instead of editing task.repo
   *  directly — see docs/SDD-worktree-isolation.md. `GET /tasks/:id/diff`
   *  reads this path instead of task.repo when present; `POST
   *  /tasks/:id/merge`/`/discard` act on it. Never set for a read-only
   *  run, or a dispatched task wissel never executed itself. */
  worktree?: { path: string; branch: string };
  /** Subagents this run spawned — claude-cli only (see
   *  docs/SDD-subagent-visibility.md; no codex-cli equivalent has been
   *  checked). Undefined when the harness/executor doesn't report this,
   *  or when it's exactly zero — set only when count > 0, so absence
   *  always means "nothing to show," never "unknown." */
  subagents?: { count: number; failed: number; byType: Record<string, number> };
  /** Set when this result came from a reviewer agent pass — same shape
   *  as ReviewVerdict, flattened onto TaskResult so the board/orchestrator
   *  can read a review outcome without a second lookup. Undefined for a
   *  non-review run. */
  verdict?: "approve" | "changes_requested";
  /** The reviewer's feedback text, paired with `verdict`. Undefined
   *  whenever `verdict` is. */
  reviewFeedback?: string;
  /** Set when this result came from a planner pass that produced a
   *  decomposition — same shape as SubtaskPlanItem[], flattened onto
   *  TaskResult so the orchestrator can spawn the real subtask cards
   *  without a second lookup. Undefined for every other run. */
  subtaskPlan?: SubtaskPlanItem[];
  /** Set by runClaude when a failure was specifically a detected
   *  claude-cli session-limit (429) error with a parseable reset time —
   *  see parseSessionLimitReset. `ok` is still `false` alongside this;
   *  `finishResult` checks `retryAfter` before the plain `!ok` branch
   *  and reschedules instead of failing the task outright. ISO
   *  timestamp; undefined for every other kind of failure (or a
   *  success). */
  retryAfter?: string;
  /** Set when this result came from a pipeline step's own
   *  pipeline-handoff contract — see PipelineHandoff, parsePipelineHandoff.
   *  Nested (unlike verdict/reviewFeedback's flat fields) because every
   *  one of its own fields is independently optional (an "all"/fan-out
   *  step's handoff has no `next` at all) — a single nested field is
   *  what lets finishResult/pipeline-runner.ts tell "this is a genuine,
   *  parsed pipeline-handoff result" apart from "not a pipeline result at
   *  all" unambiguously, which no combination of optional flat fields
   *  could. Undefined for every non-pipeline-step run. */
  pipelineHandoff?: PipelineHandoff;
  /** What MCP tools were actually called during this run — server id,
   *  tool name, the arguments Claude sent, the result that came back, and
   *  whether that call succeeded. Parsed out of the same stream-json
   *  tool-call/tool-result event pair the live-output pipe already
   *  carries (see docs/SDD-live-task-output.md), filtered to only the
   *  tool_use blocks whose name matches one of this run's granted
   *  mcpAccess tools — see parseMcpCalls, src/executors/parse-mcp-calls.ts.
   *  Lets a later review step read "were the right tool calls made"
   *  instead of only ever a diff. Undefined means no MCP calls happened,
   *  or this run didn't declare mcpAccess at all — same "absence always
   *  means nothing to show, never unknown" discipline
   *  TaskResult.subagents already holds. See
   *  docs/SDD-mcp-orchestration.md §3.4. */
  mcpCalls?: { server: string; tool: string; args: unknown; result: unknown; ok: boolean }[];
  /** Set when this run had at least one pending-approval MCP grant (see
   *  splitGrantsByTrust, src/executors/mcp-config.ts) and the agent's
   *  final message ended with a well-formed ```mcp-approval-request```
   *  block naming one of them — see parseMcpApprovalRequest,
   *  src/executors/parse-mcp-approval-request.ts. Unlike mcpCalls, this
   *  is never a call that actually happened — the tool was excluded from
   *  --allowedTools, so the agent physically could not call it; this is
   *  only the agent's own description of the one call it would have
   *  made. Undefined whenever this run had zero pending-approval grants
   *  at all (same "absence always means nothing to show" discipline
   *  every other optional TaskResult field holds) — also undefined when
   *  the agent simply had nothing to request (the block is optional, not
   *  mandatory, unlike verdict/subtaskPlan/pipelineHandoff's contracts;
   *  see parse-mcp-approval-request.ts's own doc comment). `ok` is set
   *  to `false` instead when a pending-approval grant existed and the
   *  agent attempted the block but produced something malformed, or
   *  named a server/tool this run wasn't actually blocked on — fails
   *  closed, never guesses. See docs/SDD-mcp-orchestration.md §3.5. */
  mcpApprovalRequest?: McpApprovalRequest;
}

export interface Executor {
  readonly id: string;
  /** Which HarnessTool this executor needs a Harness picked from —
   *  read by Orchestrator before it calls `harnesses.acquire()`, so
   *  each executor gets a harness for the backend it actually runs
   *  under instead of every executor being assumed to want claude-cli.
   *  Undefined means "doesn't use the harness concept at all." */
  readonly harnessTool?: HarnessTool;
  canHandle(agent: AgentDef): boolean;
  /** `harness`, when given, is the Harness the caller (normally the
   *  Orchestrator) already picked for this run — the executor's job is
   *  to run under it (pass its `env` through) and report back which one
   *  it used, not to pick one itself. Omitted entirely when no
   *  HarnessPool is configured; behavior is then identical to before
   *  harnesses existed. */
  run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult>;
}
