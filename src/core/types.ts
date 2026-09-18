export type AgentTier = "service" | "readonly" | "write";
export type TrustLevel = "low" | "medium" | "high";

/** What running this agent is expected to cost. Estimates are fine —
 *  the spec only requires that a dispatch always carries a number. */
export interface CostProfile {
  model: string;
  estUsdPerTask: number;
}

export interface AgentDef {
  id: string;
  name: string;
  tier: AgentTier;
  /** What this agent is. */
  description: string;
  /** What kind of task should land here. Read by the router. */
  whenToUse: string;
  tags: string[];
  executor: string;
  /** Agents this one may hand off to. Empty means no handoffs. */
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
}

export interface Executor {
  readonly id: string;
  canHandle(agent: AgentDef): boolean;
  run(task: TaskCard, agent: AgentDef): Promise<TaskResult>;
}
