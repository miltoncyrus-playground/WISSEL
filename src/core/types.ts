export type AgentTier = "service" | "readonly" | "write";

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
}

export interface TaskCard {
  id: string;
  title: string;
  body: string;
  labels: string[];
  repo: string;
  status: "inbox" | "ready" | "running" | "review" | "done" | "failed";
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
  candidates: Candidate[];
  selected: string;
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
}

export interface Executor {
  readonly id: string;
  canHandle(agent: AgentDef): boolean;
  run(task: TaskCard, agent: AgentDef): Promise<TaskResult>;
}
