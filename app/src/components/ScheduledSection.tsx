import { useState } from "react";
import { runScheduleNow, setScheduleEnabled } from "../api";
import { useSchedules } from "../hooks";
import { dueWithinDay, orderSchedules, scheduleLine } from "../schedules";

/** The Board screen's Scheduled section (docs/SDD-schedules.md §3.8):
 *  upcoming runs, next 24 h first, each with its on/off toggle and Run
 *  now. Editing stays on the full board and in Ask. */
export function ScheduledSection() {
  const { schedules, loaded, error, reload } = useSchedules();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A toggle shows its new state at once; the refetch after the PATCH
  // replaces it with the server's (or puts it back if the PATCH failed).
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const now = Date.now();

  async function act(id: string, what: () => Promise<string>) {
    setBusy(id);
    try {
      setNotice(await what());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      await reload();
      setFlipped((f) => {
        const next = { ...f };
        delete next[id];
        return next;
      });
      setBusy(null);
    }
  }

  return (
    <section className="lane lane-scheduled" aria-labelledby="lane-scheduled" data-lane="scheduled">
      <h2 id="lane-scheduled">
        Scheduled <span className="count">{dueWithinDay(schedules, now)} in 24 h</span>
      </h2>
      {error && (
        <p className="error" role="alert">
          Could not load schedules: {error}
        </p>
      )}
      {notice && (
        <p className="sched-notice" role="status">
          {notice}
        </p>
      )}
      {!loaded ? (
        <p className="empty">Loading…</p>
      ) : schedules.length === 0 ? (
        <p className="empty">Nothing scheduled. Add one on the full board or ask.</p>
      ) : (
        <ul className="task-list">
          {orderSchedules(schedules, now).map((s) => (
            <li key={s.id} className={`sched-row${s.enabled ? "" : " is-paused"}`} data-schedule-id={s.id}>
              <span className="task-dot" aria-hidden="true" />
              <span className="task-text">
                <span className="task-title">{s.name}</span>
                <span className="task-sub">{scheduleLine(s, now)}</span>
                {s.lastOutcome === "error" && s.lastError && <span className="task-sub sched-error">Last run failed: {s.lastError}</span>}
              </span>
              <span className="sched-actions">
                <label className="sched-toggle">
                  <input
                    type="checkbox"
                    checked={flipped[s.id] ?? s.enabled}
                    disabled={busy === s.id}
                    aria-label={`${s.name}: on`}
                    onChange={(e) => {
                      const enabled = e.currentTarget.checked;
                      setFlipped((f) => ({ ...f, [s.id]: enabled }));
                      void act(s.id, async () => {
                        await setScheduleEnabled(s.id, enabled);
                        return enabled ? `Turned on ${s.name}.` : `Paused ${s.name}.`;
                      });
                    }}
                  />
                  On
                </label>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy === s.id}
                  aria-label={`Run ${s.name} now`}
                  onClick={() =>
                    void act(s.id, async () => {
                      await runScheduleNow(s.id);
                      return `Started ${s.name}.`;
                    })
                  }
                >
                  Run now
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
