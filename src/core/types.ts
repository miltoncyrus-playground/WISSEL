export type AgentTier = "service" | "readonly" | "write";
export type TrustLevel = "low" | "medium" | "high";
/** "agent" is a full task handler (triage, plan, implement); "skill" is a
 *  narrower, more mechanical capability (draft a commit message, fix
 *  lint). Both route and dispatch identically — kind is a fleet-view/CLI
 *  label, not a separate code path. */
export type FleetKind = "agent" | "skill";

/** What running this agent is expected to cost. Estimates are fine —
 *  the spec only requires that a dispatch always carries a number. */
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
  outputContractFormat?: "review-verdict" | "subtask-plan";
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

export interface TaskCard {
  id: string;
  title: string;
  body: string;
  labels: string[];
  repo: string;
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
