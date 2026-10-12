import { needsYouReason, type LaneId } from "../lanes";
import { routeHash } from "../routes";
import { startsChip } from "../schedules";
import type { TaskCard } from "../types";
import { agentName, useAgents } from "../useAgents";
import { Avatar } from "./Avatar";

/** One card as a link to its detail (`#/board/<id>`). The lane picks
 *  the colour and the line under the title. A card with an agent shows
 *  the agent's face, pulsing while it runs (SDD §3.6). */
export function TaskRow({ task, lane }: { task: TaskCard; lane: LaneId }) {
  const agents = useAgents();
  const agent = task.routedTo ? agentName(agents, task.routedTo) : undefined;
  const sub = lane === "needs-you" ? needsYouReason(task) : [agent, task.harness].filter(Boolean).join(" · ") || task.status;
  const starts = startsChip(task.notBefore, Date.now());
  return (
    <li>
      <a className={`task-row lane-${lane}`} href={routeHash({ screen: "board", taskId: task.id })}>
        {task.routedTo ? <Avatar agentId={task.routedTo} working={lane === "running"} /> : <span className="task-dot" aria-hidden="true" />}
        <span className="task-text">
          <span className="task-title">{task.title || task.id.slice(0, 8)}</span>
          <span className="task-sub">
            {sub}
            {starts && <span className="starts-chip">{starts}</span>}
          </span>
        </span>
      </a>
    </li>
  );
}
