import { routeHash } from "../routes";
import type { TaskCard } from "../types";
import { agentName, useAgents } from "../useAgents";
import { Avatar } from "./Avatar";

/** The agents with a card running right now, each with its working
 *  pulse and the card it is on (SDD §3.6). `running` is the Running
 *  lane: running and dispatched cards. */
export function AtWork({ running, headingId, title = "At work" }: { running: readonly TaskCard[]; headingId: string; title?: string }) {
  const agents = useAgents();
  const byAgent = new Map<string, TaskCard[]>();
  for (const t of running) if (t.routedTo) byAgent.set(t.routedTo, [...(byAgent.get(t.routedTo) ?? []), t]);
  const ids = [...byAgent.keys()].sort((a, b) => agentName(agents, a).localeCompare(agentName(agents, b)));
  return (
    <section className="at-work" aria-labelledby={headingId}>
      <h3 id={headingId}>
        {title} <span className="count">{ids.length}</span>
      </h3>
      {ids.length === 0 ? (
        <p className="empty">No agent is working right now.</p>
      ) : (
        <ul className="at-work-list">
          {ids.map((id) => {
            const cards = byAgent.get(id)!;
            return (
              <li key={id}>
                <a className="at-work-row" href={routeHash({ screen: "board", taskId: cards[0]!.id })}>
                  <Avatar agentId={id} working size={32} />
                  <span className="task-text">
                    <span className="task-title">{agentName(agents, id)}</span>
                    <span className="task-sub">
                      Working on {cards[0]!.title || cards[0]!.id.slice(0, 8)}
                      {cards.length > 1 ? ` and ${cards.length - 1} more` : ""}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
