import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AgentDef } from "./types.ts";

/**
 * Loads the agent manifest. Single source of truth for both the fleet
 * view and the router prompt.
 */
export class Registry {
  private agents = new Map<string, AgentDef>();

  static async load(path = "agents/manifest.yaml"): Promise<Registry> {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as { agents: AgentDef[] };
    const registry = new Registry();
    for (const agent of parsed.agents ?? []) {
      if (registry.agents.has(agent.id)) {
        throw new Error(`duplicate agent id: ${agent.id}`);
      }
      registry.agents.set(agent.id, agent);
    }
    return registry;
  }

  all(): AgentDef[] {
    return [...this.agents.values()];
  }

  get(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  /** Candidates reachable for a task, before scoring. */
  candidatesFor(labels: string[]): AgentDef[] {
    void labels;
    // TODO: prune by declared handoff edges once graph routing lands.
    return this.all().filter((a) => a.tier !== "service");
  }
}
