import type { CSSProperties } from "react";
import { personaOf } from "../persona";
import { useAgents } from "../useAgents";

/** An agent's face (SDD §3.6): its colour and glyph, with a "working"
 *  pulse while it has a card running. Decorative: the text next to it
 *  names the agent. The pulse is an animation on top of a static ring,
 *  so with reduced motion "working" still shows, just without movement. */
export function Avatar({ agentId, working = false, size = 28 }: { agentId: string; working?: boolean; size?: number }) {
  const agents = useAgents();
  const p = personaOf(agentId, agents.get(agentId)?.persona);
  const style = { "--avatar": p.color, "--avatar-size": `${size}px`, color: p.ink } as CSSProperties;
  return (
    <span className="avatar" style={style} data-agent={agentId} data-working={working ? "" : undefined} aria-hidden="true">
      {p.glyph}
    </span>
  );
}
