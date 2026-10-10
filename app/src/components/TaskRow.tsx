import { needsYouReason, type LaneId } from "../lanes";
import { routeHash } from "../routes";
import type { TaskCard } from "../types";

/** One card as a link to its detail (`#/board/<id>`). The lane picks
 *  the colour and the line under the title. */
export function TaskRow({ task, lane }: { task: TaskCard; lane: LaneId }) {
  const sub = lane === "needs-you" ? needsYouReason(task) : [task.routedTo, task.harness].filter(Boolean).join(" · ") || task.status;
  return (
    <li>
      <a className={`task-row lane-${lane}`} href={routeHash({ screen: "board", taskId: task.id })}>
        <span className="task-dot" aria-hidden="true" />
        <span className="task-text">
          <span className="task-title">{task.title || task.id.slice(0, 8)}</span>
          <span className="task-sub">{sub}</span>
        </span>
      </a>
    </li>
  );
}
