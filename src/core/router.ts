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

  /**
   * Never auto-dispatches a low-confidence match: zero match, weak match
   * (score 0), or an unresolved tie for first place all come back with
   * `selected: null` and `confident: false` rather than a guessed pick.
   * The full ranking is always returned regardless, so a stop is never a
   * black box either.
   *
   * `allowIds`, when given, restricts candidates to exactly that set —
   * a follow-up task's declared-handoffs restriction, resolved by the
   * caller (Orchestrator / the route-preview endpoint) since Router has
   * no Board access of its own. `undefined` means unrestricted; `[]`
   * means "restricted to nothing," and is a real, explainable outcome,
   * not a bug — the reason says so rather than reading like a generic
   * zero-match.
   */
  async route(task: TaskCard, allowIds?: string[]): Promise<RoutingDecision> {
    const candidates = this.registry.candidatesFor(task.labels, allowIds);
    const ranked = await this.strategy.rank(task, candidates);
    const top = ranked[0];
    const runnerUp = ranked[1];
    const restricted = allowIds !== undefined;
    const restrictionNote = restricted
      ? allowIds.length
        ? ` (restricted to declared handoffs: ${allowIds.join(", ")})`
        : " (this task's parent declares no further handoffs)"
      : "";
    const base = {
      taskId: task.id,
      matchedTags: task.labels,
      candidates: ranked,
      strategy: this.strategy.name,
      decidedAt: new Date().toISOString(),
    };

    if (!top) {
      return { ...base, selected: null, confident: false, reason: `no candidate agents for this task${restrictionNote}` };
    }
    if (top.score <= 0) {
      return { ...base, selected: null, confident: false, reason: `no candidate matched — zero tag overlap${restrictionNote}` };
    }
    if (runnerUp && runnerUp.score === top.score) {
      return {
        ...base,
        selected: null,
        confident: false,
        reason: `tie at score ${top.score} between ${top.agentId} and ${runnerUp.agentId}${restrictionNote}`,
      };
    }

    return { ...base, selected: top.agentId, confident: true, reason: `${top.reason}${restrictionNote}` };
  }
}
