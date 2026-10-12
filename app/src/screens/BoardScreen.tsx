import { LANES, laneOf, startOfLocalDay, type Lanes } from "../lanes";
import { routeHash } from "../routes";
import type { TaskCard } from "../types";
import { Icon } from "../components/Icon";
import { TaskRow } from "../components/TaskRow";
import { ScheduledSection } from "../components/ScheduledSection";
import { startsChip } from "../schedules";

const EMPTY: Record<string, string> = {
  running: "Nothing running.",
  "needs-you": "Nothing waiting on you.",
  review: "Nothing in review.",
  "done-today": "Nothing done yet today.",
};

/** The Board tab: a compact read of /tasks by lane, and the way to the
 *  full board. */
export function BoardScreen({ lanes, loaded, error }: { lanes: Lanes; loaded: boolean; error: string | null }) {
  return (
    <div className="screen board-screen">
      <div className="screen-head">
        <h1>Board</h1>
        <a className="btn" href="/board">
          Open full board
        </a>
      </div>
      {error && (
        <p className="error" role="alert">
          Could not load cards: {error}
        </p>
      )}
      {!loaded ? (
        <p className="empty">Loading…</p>
      ) : (
        <div className="lanes">
          {LANES.map((l) => (
            <section key={l.id} className={`lane lane-${l.id}`} aria-labelledby={`lane-${l.id}`} data-lane={l.id}>
              <h2 id={`lane-${l.id}`}>
                {l.label} <span className="count">{lanes[l.id].length}</span>
              </h2>
              {lanes[l.id].length === 0 ? (
                <p className="empty">{EMPTY[l.id]}</p>
              ) : (
                <ul className="task-list">
                  {lanes[l.id].map((t) => (
                    <TaskRow key={t.id} task={t} lane={l.id} />
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
      <ScheduledSection />
    </div>
  );
}

/** `#/board/<id>`: one card's details, read only. Actions stay on the
 *  full board. */
export function CardDetail({ taskId, tasks, loaded }: { taskId: string; tasks: TaskCard[]; loaded: boolean }) {
  const task = tasks.find((t) => t.id === taskId);
  const lane = task ? laneOf(task, startOfLocalDay(Date.now())) : null;
  const starts = startsChip(task?.notBefore, Date.now());
  return (
    <div className="screen card-detail">
      <div className="screen-head">
        <a className="icon-btn" href={routeHash({ screen: "board" })} aria-label="Back to Board">
          <Icon name="back" />
        </a>
        <h1>{task ? task.title || task.id.slice(0, 8) : "Card"}</h1>
      </div>
      {!task ? (
        <p className="empty">{loaded ? "No card with that id. It may have been deleted." : "Loading…"}</p>
      ) : (
        <>
          <dl className="facts">
            <dt>Status</dt>
            <dd>
              <span className={`pill lane-${lane ?? "other"}`}>{task.status}</span>
              {starts && <span className="starts-chip">{starts}</span>}
            </dd>
            {task.routedTo && (
              <>
                <dt>Agent</dt>
                <dd>{task.routedTo}</dd>
              </>
            )}
            {task.harness && (
              <>
                <dt>Account</dt>
                <dd>{task.harness}</dd>
              </>
            )}
            {task.labels.length > 0 && (
              <>
                <dt>Labels</dt>
                <dd>{task.labels.join(", ")}</dd>
              </>
            )}
            {task.repo && (
              <>
                <dt>Repo</dt>
                <dd className="mono">{task.repo}</dd>
              </>
            )}
            <dt>Id</dt>
            <dd className="mono">{task.id}</dd>
          </dl>
          {task.body && <p className="card-body">{task.body}</p>}
          <a className="btn" href="/board">
            Act on it in the full board
          </a>
        </>
      )}
    </div>
  );
}
