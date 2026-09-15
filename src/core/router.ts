import type { AgentDef, Candidate, RoutingDecision, TaskCard } from "./types.ts";
import type { Registry } from "./registry.ts";

export interface RoutingStrategy {
  readonly name: RoutingDecision["strategy"];
  rank(task: TaskCard, candidates: AgentDef[]): Promise<Candidate[]>;
}

/**
 * Tag-overlap scoring. Deterministic, cheap, good enough while the
 * fleet is small. Returns a full ranking, never a bare winner — the
 * rejected candidates are what make a wrong route debuggable.
 */
export class RuleStrategy implements RoutingStrategy {
  readonly name = "rule" as const;

  async rank(task: TaskCard, candidates: AgentDef[]): Promise<Candidate[]> {
    const labels = new Set(task.labels.map((l) => l.toLowerCase()));
    return candidates
      .map((agent) => {
        const hits = agent.tags.filter((t) => labels.has(t.toLowerCase()));
        const score = labels.size === 0 ? 0 : hits.length / labels.size;
        return {
          agentId: agent.id,
          score: Number(score.toFixed(2)),
          reason: `tag overlap ${hits.length}/${labels.size}`,
        };
      })
      .sort((a, b) => b.score - a.score);
  }
}

export class Router {
  constructor(
    private registry: Registry,
    private strategy: RoutingStrategy = new RuleStrategy(),
  ) {}

  async route(task: TaskCard): Promise<RoutingDecision> {
    const candidates = this.registry.candidatesFor(task.labels);
    const ranked = await this.strategy.rank(task, candidates);
    const top = ranked[0];
    if (!top) throw new Error(`no candidate agents for task ${task.id}`);

    return {
      taskId: task.id,
      matchedTags: task.labels,
      candidates: ranked,
      selected: top.agentId,
      reason: top.reason,
      strategy: this.strategy.name,
      decidedAt: new Date().toISOString(),
    };
  }
}
