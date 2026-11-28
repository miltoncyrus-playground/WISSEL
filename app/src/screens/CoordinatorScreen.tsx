// The coordinator window (docs/SDD-coordinator.md §4.14), one per
// workstream: a header with each project's role, the state of its cards,
// the channel and quiet hours, then four tabs:
// - Conversation: what reached the inbox, your messages, and owner tasks
//   with their steps as tick-boxes and a Done that runs the task's check.
// - Decisions: each Decision with Flip.
// - Log: the channel outbox and the gate's decisions.
// - Settings: roles, duties and Shadow. Each change shows the server's own
//   confirm text first, and only "Confirm" sends it.
import { useCallback, useEffect, useState } from "react";
import { eventLine, fetchWindow, fetchWorkstreams, post, type WindowData, type Workstream, type WriteResult } from "../coordinator";
import { routeHash } from "../routes";
import { useProjects } from "../useProjects";

export type WindowTab = "conversation" | "decisions" | "log" | "settings";
const TABS: { id: WindowTab; label: string }[] = [
  { id: "conversation", label: "Conversation" },
  { id: "decisions", label: "Decisions" },
  { id: "log", label: "Log" },
  { id: "settings", label: "Settings" },
];
const ROLES = ["shadow", "follow", "decide", "decide-over"] as const;

export function WorkstreamList({ workstreams }: { workstreams: Workstream[] }) {
  return (
    <section className="coordinator" aria-label="Workstreams">
      <h1>Coordinator</h1>
      {workstreams.length === 0 ? (
        <p className="empty">No workstreams yet. Create one with POST /workstreams; each gets its own window here.</p>
      ) : (
        <ul className="ws-list">
          {workstreams.map((w) => (
            <li key={w.id}>
              <a href={routeHash({ screen: "coordinator", workstreamId: w.id })}>{w.name}</a>
              {w.ticket ? <span className="ws-ticket"> · {w.ticket}</span> : null}
              <span className="ws-meta"> · {w.projects.length} project{w.projects.length === 1 ? "" : "s"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface WindowActions {
  onTab: (t: WindowTab) => void;
  onFlip: (decisionId: string) => void;
  onDone: (ownerTaskId: string) => void;
  onSend: (text: string) => void;
  onRole: (projectId: string, role: string) => void;
  onDuty: (duty: string, owner: "external" | "wissel") => void;
  onShadow: (on: boolean) => void;
  /** Quick actions (§4.14): the digest now, restart when idle, cancel it. */
  onStatus: () => void;
  onRestart: (cancel: boolean) => void;
}

/** The window, for one workstream's data. Pure: everything it does goes
 *  through `actions`. */
export function WorkstreamWindow({ data, tab, projectName, actions, status }: { data: WindowData; tab: WindowTab; projectName: (id: string) => string; actions: WindowActions; status?: string }) {
  const { ws } = data;
  const [draft, setDraft] = useState("");
  return (
    <section className="coordinator" aria-label={`Coordinator for ${ws.name}`}>
      <header className="ws-head">
        <h1>
          {ws.name}
          {ws.ticket ? <span className="ws-ticket"> · {ws.ticket}</span> : null}
          {data.shadow ? <span className="ws-shadow"> · Shadow: recording only</span> : null}
        </h1>
        <ul className="ws-roles" aria-label="Roles">
          {ws.projects.map((p) => (
            <li key={p.projectId}>
              {projectName(p.projectId)}: <strong>{p.role}</strong>
              {p.decider ? ` (decider: ${p.decider})` : ""}
            </li>
          ))}
        </ul>
        <p className="ws-state">
          {ws.channel ? `Channel: ${ws.channel.adapter}` : "No channel"}
          {ws.chat ? ` · Chat: ${ws.chat.channel}` : ""}
          {ws.quietHours ? ` · Quiet ${ws.quietHours.start} to ${ws.quietHours.end} (${ws.quietHours.timezone})` : ""}
        </p>
      </header>
      <div role="tablist" aria-label="Window" className="ws-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => actions.onTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === "conversation" && (
          <>
            <ul className="ws-owner-tasks" aria-label="Owner tasks">
              {data.ownerTasks.map((t) => (
                <li key={t.id} className="ws-owner-task">
                  <strong>{t.title}</strong>
                  <p>{t.why}</p>
                  <ul>
                    {t.steps.map((s, i) => (
                      <li key={i}>
                        <label>
                          <input type="checkbox" /> {s}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <button type="button" onClick={() => actions.onDone(t.id)}>
                    Done{t.check ? " (runs its check)" : ""}
                  </button>
                </li>
              ))}
            </ul>
            <ol className="ws-events" aria-label="Conversation">
              {data.inbox.map((e) => (
                <li key={e.id} className={e.untrusted ? "untrusted" : undefined} data-user-content="">
                  <time dateTime={e.receivedAt}>{e.receivedAt.slice(11, 16)}</time> {eventLine(e)}
                </li>
              ))}
            </ol>
            <div className="ws-quick" role="group" aria-label="Quick actions">
              <button type="button" onClick={actions.onStatus}>
                Status now
              </button>
              <button type="button" onClick={() => actions.onRestart(false)}>
                Restart when idle
              </button>
              <button type="button" onClick={() => actions.onRestart(true)}>
                Cancel restart
              </button>
            </div>
            {status ? (
              <pre className="ws-status" aria-label="Status">
                {status}
              </pre>
            ) : null}
            <form
              className="ws-input"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (draft.trim()) actions.onSend(draft.trim());
                setDraft("");
              }}
            >
              <label htmlFor="ws-message">Message the coordinator</label>
              <input id="ws-message" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit">Send</button>
            </form>
          </>
        )}
        {tab === "decisions" && (
          <ul className="ws-decisions" aria-label="Decisions">
            {data.decisions.length === 0 ? <li className="empty">No decisions yet.</li> : null}
            {data.decisions.map((d) => (
              <li key={d.id} className="ws-decision">
                <span className="ws-decision-text">{d.text}</span>
                <span className="ws-decision-meta">
                  {" "}
                  ({d.status === "flipped" ? "flipped" : `by ${d.by}`}; alternative: {d.alternative})
                </span>
                <button type="button" onClick={() => actions.onFlip(d.id)} aria-label={`Flip: ${d.text}`}>
                  Flip
                </button>
              </li>
            ))}
          </ul>
        )}
        {tab === "log" && (
          <>
            <h2>Channel</h2>
            <ul className="ws-channel" aria-label="Channel">
              {data.channel.length === 0 ? <li className="empty">Nothing posted.</li> : null}
              {data.channel.map((r) => (
                <li key={r.id}>
                  {r.message.kind}: {r.message.text} · {r.status}
                </li>
              ))}
            </ul>
            <h2>Gate</h2>
            <ul className="ws-gate" aria-label="Gate log">
              {data.gateLog.map((r) => (
                <li key={r.id}>
                  {r.action.kind}
                  {r.action.message ? ` (${r.action.message})` : ""}: {r.verdict}
                  {r.mode === "shadow" ? " (shadow)" : ""} · {r.rule}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === "settings" && (
          <>
            <h2>Roles</h2>
            <ul className="ws-role-settings">
              {ws.projects.map((p) => (
                <li key={p.projectId}>
                  <label>
                    {projectName(p.projectId)}{" "}
                    <select aria-label={`Role of ${projectName(p.projectId)}`} value={p.role} onChange={(e) => actions.onRole(p.projectId, e.target.value)}>
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              ))}
            </ul>
            <h2>Duties</h2>
            <ul className="ws-duties">
              {data.duties.map((d) => (
                <li key={d.duty}>
                  {d.duty}: {d.owner === "wissel" ? "Wissel" : "external coordinator"}{" "}
                  <button type="button" onClick={() => actions.onDuty(d.duty, d.owner === "wissel" ? "external" : "wissel")}>
                    Hand to {d.owner === "wissel" ? "the external coordinator" : "Wissel"}
                  </button>
                </li>
              ))}
            </ul>
            <h2>Shadow</h2>
            <button type="button" onClick={() => actions.onShadow(!data.shadow)}>
              {data.shadow ? "Turn Shadow off" : "Turn Shadow on"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** The screen: the list, or one workstream's window with its confirm
 *  dialog. */
export function CoordinatorScreen({ workstreamId }: { workstreamId?: string }) {
  const projects = useProjects();
  const [list, setList] = useState<Workstream[] | undefined>();
  const [data, setData] = useState<WindowData | undefined>();
  const [tab, setTab] = useState<WindowTab>("conversation");
  const [error, setError] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<{ message: string; send: () => Promise<WriteResult> } | undefined>();
  const [status, setStatus] = useState<string | undefined>();

  const load = useCallback(() => {
    if (!workstreamId) {
      fetchWorkstreams().then(setList, (e: unknown) => setError(String(e)));
      return;
    }
    fetchWindow(workstreamId).then(setData, (e: unknown) => setError(String(e)));
  }, [workstreamId]);
  useEffect(load, [load]);

  const write = async (first: () => Promise<WriteResult>, confirmed?: () => Promise<WriteResult>) => {
    setError(undefined);
    const r = await first();
    if (r.kind === "confirm" && confirmed) setConfirm({ message: r.message, send: confirmed });
    else if (r.kind === "error") setError(r.message);
    load();
  };

  if (error && !data && !list) return <p role="alert">{error}</p>;
  if (!workstreamId) return list ? <WorkstreamList workstreams={list} /> : <p>Loading…</p>;
  if (!data) return <p>Loading…</p>;
  const w = encodeURIComponent(data.ws.id);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  return (
    <>
      <WorkstreamWindow
        data={data}
        tab={tab}
        projectName={projectName}
        status={status}
        actions={{
          onStatus: () =>
            void fetch(`/workstreams/${w}/digest`)
              .then((r) => r.json() as Promise<{ text?: string }>)
              .then((d) => setStatus(d.text ?? ""), (e: unknown) => setError(String(e))),
          onRestart: (cancel) =>
            void fetch("/admin/restart-when-idle", { method: cancel ? "DELETE" : "POST" })
              .then(async (r) => {
                const body = (await r.json().catch(() => ({}))) as { error?: string; pending?: boolean; running?: number };
                if (!r.ok) setError(body.error ?? `HTTP ${r.status}`);
                else setStatus(body.pending ? `A restart is pending; ${body.running ?? 0} card(s) still running.` : "No restart is pending.");
              }),
          onTab: setTab,
          onFlip: (id) => void write(() => post(`/decisions/${encodeURIComponent(id)}/flip`)),
          onDone: (id) => void write(() => post(`/owner-tasks/${encodeURIComponent(id)}/done`)),
          onSend: (text) => void write(() => post("/inbox", { text, workstreamId: data.ws.id })),
          onRole: (projectId, role) => void write(() => post(`/workstreams/${w}/projects/${encodeURIComponent(projectId)}/role`, { role }), () => post(`/workstreams/${w}/projects/${encodeURIComponent(projectId)}/role`, { role, confirm: true })),
          onDuty: (duty, owner) => void write(() => post(`/workstreams/${w}/duties/${duty}`, { owner }), () => post(`/workstreams/${w}/duties/${duty}`, { owner, confirm: true })),
          onShadow: (on) => void write(() => post("/admin/shadow", { on }), () => post("/admin/shadow", { on, confirm: true })),
        }}
      />
      {error ? (
        <p role="alert" className="ws-error">
          {error}
        </p>
      ) : null}
      {confirm ? (
        <div role="dialog" aria-modal="true" aria-label="Confirm the change" className="ws-confirm">
          <p>{confirm.message}</p>
          <button
            type="button"
            onClick={() => {
              const send = confirm.send;
              setConfirm(undefined);
              void write(send);
            }}
          >
            Confirm
          </button>
          <button type="button" onClick={() => setConfirm(undefined)}>
            Cancel
          </button>
        </div>
      ) : null}
    </>
  );
}
