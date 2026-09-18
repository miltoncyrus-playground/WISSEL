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
   *  confidently; see the task's recorded RoutingDecision for why. */
  status: "inbox" | "ready" | "running" | "dispatched" | "review" | "done" | "failed" | "no-match";
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
}

/** A named execution backend wissel can run work under — a tool (which
 *  CLI) plus an account (which authenticated identity). Distinct from
 *  AgentDef: an agent is a routing-target descriptor ("what kind of work
 *  is this"); a Harness is "which credentialed process actually runs
 *  it." See docs/SDD-execution-harnesses.md. */
export type HarnessTool = "claude-cli";

export interface Harness {
  id: string;
  tool: HarnessTool;
  label: string;
  enabled: boolean;
  /** Env overrides applied to the spawned process — how a harness picks
   *  an already-authenticated account without wissel holding a secret
   *  itself. A pointer (e.g. CLAUDE_CONFIG_DIR) to credentials that
   *  already live somewhere else, never a raw API key/token value. */
  env?: Record<string, string>;
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
}

export interface Executor {
  readonly id: string;
  canHandle(agent: AgentDef): boolean;
  /** `harness`, when given, is the Harness the caller (normally the
   *  Orchestrator) already picked for this run — the executor's job is
   *  to run under it (pass its `env` through) and report back which one
   *  it used, not to pick one itself. Omitted entirely when no
   *  HarnessPool is configured; behavior is then identical to before
   *  harnesses existed. */
  run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult>;
}
