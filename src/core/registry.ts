import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AgentDef } from "./types.ts";
import { unknownVerificationTokens, VERIFICATION_TOKENS } from "./verification.ts";

/** Why an agent's `persona` is malformed, or null when it is fine (or
 *  absent). `color` is `#RRGGBB`; `glyph` is one or two characters
 *  (code points, so an emoji counts as one), no whitespace. See
 *  docs/SDD-wissel-app.md §3.6. */
export function validatePersona(persona: unknown): string | null {
  if (persona === undefined) return null;
  if (typeof persona !== "object" || persona === null || Array.isArray(persona)) return `persona must be a map with color and/or glyph, got ${JSON.stringify(persona)}`;
  const extra = Object.keys(persona).filter((k) => k !== "color" && k !== "glyph");
  if (extra.length) return `persona has unknown keys: ${extra.join(", ")} (only color and glyph)`;
  const { color, glyph } = persona as { color?: unknown; glyph?: unknown };
  if (color !== undefined && !(typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color))) return `persona.color must be #RRGGBB, got ${JSON.stringify(color)}`;
  if (glyph !== undefined) {
    const chars = typeof glyph === "string" ? [...glyph] : [];
    if (chars.length < 1 || chars.length > 2 || chars.some((c) => /\s/.test(c))) return `persona.glyph must be one or two characters, got ${JSON.stringify(glyph)}`;
  }
  return null;
}

/**
 * Loads the agent manifest. Single source of truth for both the fleet
 * view and the router prompt.
 */
export class Registry {
  private agents = new Map<string, AgentDef>();

  static async load(path = "agents/manifest.yaml"): Promise<Registry> {
    const raw = await readFile(path, "utf8");
    const parsed = parse(raw) as { agents: AgentDef[] };
    return Registry.from(parsed.agents ?? []);
  }

  /** Builds a registry directly from a list of agents — the manifest
   *  loader's own path, minus the file read. Used by tests that need a
   *  real Registry/Router pair without a manifest.yaml on disk. */
  static from(agents: AgentDef[]): Registry {
    const registry = new Registry();
    for (const agent of agents) {
      if (registry.agents.has(agent.id)) {
        throw new Error(`duplicate agent id: ${agent.id}`);
      }
      // Which harness ids exist is checked later, in createApp, once the
      // HarnessPool is loaded; here only the shape.
      if (agent.harnesses !== undefined && !(Array.isArray(agent.harnesses) && agent.harnesses.every((id) => typeof id === "string"))) {
        throw new Error(`agent "${agent.id}": harnesses must be a list of harness ids, got ${JSON.stringify(agent.harnesses)}`);
      }
      // `web` is a readonly-only grant: ReadOnlyExecutor is the one
      // place that turns it into --allowedTools WebSearch WebFetch, and
      // only under plan mode. On a write-tier agent (or one another
      // executor runs) it would either widen a write run's reach or
      // silently do nothing, so the manifest fails to load instead.
      // docs/SDD-ai-news-podcast.md §3.1.
      if ((agent.toolAccess ?? []).includes("web") && (agent.tier !== "readonly" || agent.executor !== "readonly")) {
        throw new Error(
          `agent "${agent.id}": toolAccess "web" is only for tier: readonly agents run by executor: readonly, got tier ${agent.tier}, executor ${agent.executor}`,
        );
      }
      const personaError = validatePersona(agent.persona);
      if (personaError) throw new Error(`agent "${agent.id}": ${personaError}`);
      // The project-commands tokens (src/core/verification.ts) are the
      // only `{{...}}` a contract may carry; anything else would reach a
      // paid prompt as literal braces, so the manifest fails to load.
      const unknownTokens = unknownVerificationTokens(agent.verificationContract ?? "");
      if (unknownTokens.length > 0) {
        throw new Error(`agent "${agent.id}": verificationContract has unknown token(s) ${unknownTokens.join(", ")}; known: ${VERIFICATION_TOKENS.join(", ")}`);
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

  /** Candidates reachable for a task, before scoring. `allowIds`, when
   *  given, prunes to exactly that set — the declared-handoffs
   *  restriction for a follow-up task (Router resolves it; this just
   *  applies it). `[]` correctly yields zero candidates: a deliberate
   *  "hands off to no one" is not the same as "no restriction." */
  candidatesFor(labels: string[], allowIds?: string[]): AgentDef[] {
    void labels;
    const base = this.all().filter((a) => a.tier !== "service");
    return allowIds ? base.filter((a) => allowIds.includes(a.id)) : base;
  }
}
