import type { ReactNode } from "react";
import type { ConnectionState } from "../events";
import type { Lanes, LaneId } from "../lanes";
import { AtWork } from "./AtWork";
import { TaskRow } from "./TaskRow";

const SECTIONS: { lane: LaneId; title: string; empty: string }[] = [
  { lane: "running", title: "Running", empty: "Nothing running." },
  { lane: "needs-you", title: "Needs you", empty: "Nothing waiting on you." },
  { lane: "done-today", title: "Landed today", empty: "Nothing landed yet today." },
];

/** Shows at most this many cards per section; the Board tab has all. */
const PER_SECTION = 6;

/** Desktop only: the right-hand "Live" panel (agents at work, running,
 *  needs you, landed today), kept current by the shared /events stream.
 *  The mini-player (SDD §3.3) sits at its top. */
export function LivePanel({ lanes, connection, player, reload }: { lanes: Lanes; connection: ConnectionState; player?: ReactNode; reload?: () => Promise<void> }) {
  return (
    <aside className="live" aria-labelledby="live-title">
      <div className="live-head">
        <h2 id="live-title">Live</h2>
        <ConnectionDot state={connection} />
      </div>
      {player}
      <AtWork running={lanes.running} headingId="live-at-work" />
      {SECTIONS.map((s) => {
        const items = lanes[s.lane];
        return (
          <section key={s.lane} className="live-section" aria-labelledby={`live-${s.lane}`}>
            <h3 id={`live-${s.lane}`}>
              {s.title} <span className="count">{items.length}</span>
            </h3>
            {items.length === 0 ? (
              <p className="empty">{s.empty}</p>
            ) : (
              <ul className="task-list">
                {items.slice(0, PER_SECTION).map((t) => (
                  <TaskRow key={t.id} task={t} lane={s.lane} onChanged={reload} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </aside>
  );
}

const STATE_TEXT: Record<ConnectionState, string> = {
  open: "Live",
  connecting: "Connecting",
  closed: "Offline",
};

export function ConnectionDot({ state }: { state: ConnectionState }) {
  return (
    <span className={`conn conn-${state}`} role="status">
      <span className="conn-dot" aria-hidden="true" />
      {STATE_TEXT[state]}
    </span>
  );
}
