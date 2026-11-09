import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createWorkstream, fetchWindow, fetchWorkstreams, flipDecision, ownerTaskDone, postWindowMessage, resolveWindowAction, setProjectRole } from "../api";
import { events } from "../events";
import { routeHash } from "../routes";
import { timeAgo } from "../time";
import { useProjects } from "../useProjects";
import { PROJECT_ROLES, type ChannelEntry, type ChatMessage, type Decision, type OwnerTask, type ProjectRole, type QuickAction, type WindowDocument, type WindowExecuted, type WindowItem, type Workstream } from "../types";
import { ConfirmCard } from "./AskScreen";

/** The coordinator window (docs/SDD-coordinator.md §4.14): one component
 *  for the app screen (#/window/<id>) and for the board's dock, which
 *  loads the same screen in a frame with `?dock=1`. Everything it shows
 *  is GET /workstreams/:id/window; every button is one POST and a
 *  refetch. A policy change or a role change is shown as the change and
 *  does nothing until the Confirm click. */
const TABS = ["Conversation", "Decisions", "Log"] as const;
type Tab = (typeof TABS)[number];
const QUICK: { action: QuickAction; label: string }[] = [
  { action: "status-now", label: "Status now" },
  { action: "waiting-on-me", label: "What is waiting on me" },
  { action: "pause-new-cards", label: "Pause new cards" },
  { action: "restart-when-idle", label: "Restart when idle" },
];
const REFETCH_DEBOUNCE_MS = 150;
const text = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CoordinatorWindow({ workstreamId, now, dock = false }: { workstreamId?: string; now: number; dock?: boolean }) {
  const [doc, setDoc] = useState<WindowDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("Conversation");
  const [log, setLog] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [roleChange, setRoleChange] = useState<{ projectId: string; from: ProjectRole; to: ProjectRole; error?: string; busy?: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!workstreamId) return;
    try {
      setDoc(await fetchWindow(workstreamId));
      setError(null);
    } catch (err) {
      setError(text(err));
    } finally {
      setLoaded(true);
    }
  }, [workstreamId]);

  useEffect(() => {
    setDoc(null);
    setLoaded(false);
    setRoleChange(null);
    void load();
    // Any board event (a card moved, a channel entry) refetches, debounced like the board.
    const off = events.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const send = (input: { action?: QuickAction; text?: string }) => {
    if (!workstreamId || sending) return;
    setSending(true);
    setError(null);
    postWindowMessage(workstreamId, { ...input, log }).then(
      () => {
        setSending(false);
        setDraft("");
        setTab("Conversation");
        void load();
      },
      (err: unknown) => {
        setSending(false);
        setError(text(err));
      },
    );
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) send({ text: draft.trim() });
  };
  const resolve = useCallback(
    async (pendingId: string, verb: "confirm" | "cancel") => {
      await resolveWindowAction(workstreamId!, pendingId, verb);
      await load();
    },
    [workstreamId, load],
  );
  const confirmRole = () => {
    if (!roleChange || !workstreamId) return;
    setRoleChange({ ...roleChange, busy: true });
    setProjectRole(workstreamId, roleChange.projectId, roleChange.to).then(
      () => {
        setRoleChange(null);
        void load();
      },
      (err: unknown) => setRoleChange({ ...roleChange, busy: false, error: text(err) }),
    );
  };

  if (!workstreamId) return <Picker />;
  const h = doc?.header;
  const paused = Boolean(h?.live.dispatchHold);
  return (
    <div className="screen window-screen">
      <div className="screen-head">
        <h1>Coordinator window{h ? `: ${h.workstream.name}` : ""}</h1>
        {dock ? (
          <a className="btn btn-small" href={`/app${routeHash({ screen: "window", workstreamId })}`} target="_top">
            Open in the app
          </a>
        ) : (
          <a className="btn btn-small" href={routeHash({ screen: "window" })}>
            All workstreams
          </a>
        )}
      </div>
      {!loaded && <p className="empty">Loading…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {h && (
        <section className="cw-head" aria-label="Window header">
          <dl>
            <dt>Workstream</dt>
            <dd>
              <span>{h.workstream.name}</span>
              {h.workstream.ticket && <span className="mono"> {h.workstream.ticket}</span>}
            </dd>
            <dt>Roles</dt>
            <dd>
              {h.roles.length === 0 && "no projects"}
              {h.roles.map((r) => (
                <span className="cw-role" key={r.projectId}>
                  <span className="mono">{r.projectId}</span>
                  <select aria-label={`Role for ${r.projectId}`} value={roleChange?.projectId === r.projectId ? roleChange.to : r.role} onChange={(e) => setRoleChange(e.target.value === r.role ? null : { projectId: r.projectId, from: r.role, to: e.target.value as ProjectRole })}>
                    {PROJECT_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                  {r.decider && <span className="muted">({r.decider})</span>}
                </span>
              ))}
            </dd>
            <dt>Live</dt>
            <dd>
              {paused ? `New cards paused: ${h.live.dispatchHold}` : "New cards start"}
              {h.live.restartPending ? "; restart pending" : ""}; {h.live.running} running on the board
            </dd>
            <dt>Cards</dt>
            <dd>
              {h.cards.live} live{h.cards.cap === null ? ", no cap" : ` of ${h.cards.cap}`}
            </dd>
            <dt>Channel written</dt>
            <dd>{h.channelLastWrittenAt ? timeAgo(h.channelLastWrittenAt, now) : "never"}</dd>
            <dt>Quiet hours</dt>
            <dd>{h.quietHours ? `${h.quietHours.start} to ${h.quietHours.end} ${h.quietHours.timezone}, ${h.quietHours.quiet ? "on now" : "off now"}` : "none"}</dd>
            <dt>Outbound</dt>
            <dd>
              {h.outbound.queued} queued{h.outbound.flushAt ? `, flush ${timeAgo(h.outbound.flushAt, now)}` : ""}
            </dd>
          </dl>
        </section>
      )}
      {roleChange && (
        <div className="cw-change" role="group" aria-label="Confirm the role change">
          <p className="confirm-head">Change the role:</p>
          <p>
            {roleChange.projectId}: {roleChange.from} to {roleChange.to}. Takes effect at the next idle tick; open questions are handed over with a channel note.
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={roleChange.busy} onClick={confirmRole}>
              Confirm
            </button>
            <button type="button" className="btn btn-small" disabled={roleChange.busy} onClick={() => setRoleChange(null)}>
              Cancel
            </button>
          </div>
          {roleChange.error && (
            <p className="error" role="alert">
              {roleChange.error}
            </p>
          )}
        </div>
      )}
      {doc && (
        <>
          <div className="segmented cw-tabs" role="tablist" aria-label="Window tabs">
            {TABS.map((t) => (
              <button key={t} type="button" role="tab" id={`cw-tab-${t}`} className="segment" aria-selected={tab === t} aria-controls="cw-panel" onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="cw-panel" aria-labelledby={`cw-tab-${tab}`} className="cw-panel">
            {tab === "Conversation" && <Conversation doc={doc} now={now} resolve={resolve} reload={load} hold={() => send({ action: "pause-new-cards" })} />}
            {tab === "Decisions" && <Decisions decisions={doc.decisions} now={now} reload={load} />}
            {tab === "Log" && <Log entries={doc.log} now={now} />}
          </div>
          <div className="composer-wrap">
            <ul className="quick-replies" aria-label="Quick actions">
              {QUICK.map((q) => (
                <li key={q.action}>
                  <button type="button" className="quick-reply" disabled={sending} onClick={() => send({ action: q.action === "pause-new-cards" && paused ? "resume-new-cards" : q.action })}>
                    {q.action === "pause-new-cards" && paused ? "Resume new cards" : q.label}
                  </button>
                </li>
              ))}
            </ul>
            <label className="cw-toggle">
              <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
              Log it on the channel
            </label>
            <form className="composer" onSubmit={onSubmit}>
              <label htmlFor="cw-input" className="sr-only">
                Message to the window
              </label>
              <textarea id="cw-input" rows={1} placeholder="Ask the window" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className="btn btn-small" disabled={sending || !draft.trim()}>
                Send
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}

/** `#/window` with no id: the workstreams to pick from. In the dock the
 *  board's own select does this, so the list is the fallback. */
function Picker() {
  const [list, setList] = useState<Workstream[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchWorkstreams().then(setList, (err: unknown) => setError(text(err)));
  }, []);
  return (
    <div className="screen window-screen">
      <div className="screen-head">
        <h1>Coordinator window</h1>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list === null ? <p className="empty">Loading…</p> : list.length === 0 ? <p className="empty">No workstreams yet. Create one below.</p> : null}
      <ul className="chat-list">
        {(list ?? []).map((ws) => (
          <li key={ws.id}>
            <a className="chat-link" href={routeHash({ screen: "window", workstreamId: ws.id })}>
              <span className="chat-title">{ws.name}</span>
              <span className="mono">{ws.projects.map((p) => `${p.projectId} ${p.role}`).join(", ")}</span>
            </a>
          </li>
        ))}
      </ul>
      <NewWorkstreamForm onCreated={(ws) => setList((l) => [...(l ?? []), ws])} />
    </div>
  );
}

/** A workstream is a name and the projects it covers, each with a role. New projects start in Shadow, where the coordinator
 *  records what it would do and acts on nothing; a role is changed later from the window, with a Confirm. */
function NewWorkstreamForm({ onCreated }: { onCreated: (ws: Workstream) => void }) {
  const projects = useProjects();
  const [name, setName] = useState("");
  const [ticket, setTicket] = useState("");
  const [picked, setPicked] = useState<Record<string, ProjectRole>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (id: string, on: boolean) =>
    setPicked((p) => {
      const next = { ...p };
      if (on) next[id] = "shadow";
      else delete next[id];
      return next;
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkstream({ name: name.trim(), ...(ticket.trim() ? { ticket: ticket.trim() } : {}), projects: Object.entries(picked).map(([projectId, role]) => ({ projectId, role })) });
      onCreated(ws);
      window.location.hash = routeHash({ screen: "window", workstreamId: ws.id });
    } catch (err) {
      setError(text(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cw-new" onSubmit={submit} aria-labelledby="cw-new-title">
      <h2 id="cw-new-title">New workstream</h2>
      <label className="cw-field">
        <span>Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="cw-field">
        <span>Ticket (optional)</span>
        <input type="text" value={ticket} onChange={(e) => setTicket(e.target.value)} placeholder="ABC-123" />
      </label>
      <fieldset className="cw-field">
        <legend>Projects</legend>
        {projects.length === 0 ? <p className="muted">No projects are registered.</p> : null}
        {projects.map((p) => (
          <div key={p.id} className="cw-project">
            <label className="cw-toggle">
              <input type="checkbox" checked={p.id in picked} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span>{p.name}</span>
            </label>
            {p.id in picked && (
              <select aria-label={`Role in ${p.name}`} value={picked[p.id]} onChange={(e) => setPicked((x) => ({ ...x, [p.id]: e.target.value as ProjectRole }))}>
                {PROJECT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </fieldset>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
        Create workstream
      </button>
    </form>
  );
}

type Timed = { at: string; node: ReactNode; key: string };

/** Owner messages and replies by time, status lines and decisions among
 *  them; owner tasks and plans (no time of their own) wait at the end. */
function Conversation({ doc, now, resolve, reload, hold }: { doc: WindowDocument; now: number; resolve: (id: string, verb: "confirm" | "cancel") => Promise<void>; reload: () => Promise<void>; hold: () => void }) {
  const timed: Timed[] = [
    ...(doc.conversation?.messages ?? []).map((m) => ({ at: m.at, key: m.id, node: <Message message={m} resolve={resolve} /> })),
    ...doc.items.flatMap((it, i): Timed[] => {
      if (it.kind === "status") return [{ at: it.at, key: `s${i}`, node: <StatusLine at={it.at} from={it.from} text={it.text} now={now} /> }];
      if (it.kind === "decision") return [{ at: it.decision.at, key: it.decision.id, node: <DecisionItem decision={it.decision} now={now} reload={reload} /> }];
      return [];
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const waiting = doc.items.filter((it): it is Extract<WindowItem, { kind: "owner-task" | "plan" }> => it.kind === "owner-task" || it.kind === "plan");
  if (timed.length === 0 && waiting.length === 0) return <p className="lede">Nothing yet. Ask for the status, or what is waiting on you.</p>;
  return (
    <ol className="cw-items" role="log" aria-label="Conversation">
      {timed.map((t) => (
        <li key={t.key} className="cw-entry">
          {t.node}
        </li>
      ))}
      {waiting.map((it) => (
        <li key={it.kind === "owner-task" ? it.task.id : it.card.id} className="cw-entry">
          {it.kind === "owner-task" ? <OwnerTaskItem task={it.task} hasCheck={it.hasCheck} reload={reload} /> : <PlanItem card={it.card} held={it.held} hold={hold} />}
        </li>
      ))}
    </ol>
  );
}

function Message({ message, resolve }: { message: ChatMessage; resolve: (id: string, verb: "confirm" | "cancel") => Promise<void> }) {
  const results = message.actions.filter((a): a is WindowExecuted => "window" in a && a.window === true);
  return (
    <div className={`msg msg-${message.role}`} data-id={message.id}>
      <span className="sr-only">{message.role === "user" ? "You:" : "wissel:"}</span>
      <p className="msg-text">{message.text}</p>
      {results.length > 0 && (
        <ul className="results" aria-label="What was done">
          {results.map((r, i) => (
            <li key={i} className={`result tone-result-${r.ok ? "done" : "refused"}`}>
              <span className="result-mark" aria-hidden="true" />
              <span className="result-text">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      {(message.pending ?? []).map((p) => (
        <ConfirmCard key={p.id} pending={p} resolve={resolve} />
      ))}
    </div>
  );
}

function StatusLine({ at, from, text: body, now }: { at: string; from: string; text: string; now: number }) {
  return (
    <p className="cw-status">
      <time className="mono" dateTime={at}>
        {timeAgo(at, now)}
      </time>
      <span className="cw-from">{from}</span>
      <span className="cw-text">{body}</span>
    </p>
  );
}

/** A decision with Flip while it stands; Flip takes the alternative. */
function DecisionItem({ decision, now, reload }: { decision: Decision; now: number; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = () => {
    setBusy(true);
    setError(null);
    flipDecision(decision.id).then(
      () => reload().then(() => setBusy(false)),
      (err: unknown) => {
        setBusy(false);
        setError(text(err));
      },
    );
  };
  return (
    <div className="cw-item cw-decision" data-decision-id={decision.id}>
      <p>
        <span className="cw-kind">Decision</span>
        <strong className="cw-text">{decision.text}</strong>
      </p>
      <p className="muted">
        by {decision.by}, <time dateTime={decision.at}>{timeAgo(decision.at, now)}</time>. Alternative: <span>{decision.alternative}</span>
      </p>
      <div className="cw-actions">
        {decision.status === "taken" ? (
          <button type="button" className="btn btn-small" disabled={busy} aria-busy={busy || undefined} onClick={flip}>
            Flip
          </button>
        ) : (
          <span className="result-state mono">Flipped</span>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** An owner task: its steps as tick-boxes (yours to tick, not stored),
 *  and Done, which runs the check; a failing check leaves it open and
 *  shows what the check printed. */
function OwnerTaskItem({ task, hasCheck, reload }: { task: OwnerTask; hasCheck: boolean; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ error: string; output?: string } | null>(null);
  const done = () => {
    setBusy(true);
    setFailed(null);
    ownerTaskDone(task.id).then(
      (r) => {
        if (r.ok) return reload().then(() => setBusy(false));
        setBusy(false);
        setFailed(r);
      },
      (err: unknown) => {
        setBusy(false);
        setFailed({ error: text(err) });
      },
    );
  };
  return (
    <div className="cw-item cw-owner-task" data-owner-task-id={task.id}>
      <p>
        <span className="cw-kind">Owner task</span>
        <strong>{task.title}</strong>
      </p>
      <p className="muted">{task.why}</p>
      {task.steps.length > 0 && (
        <ul className="cw-steps">
          {task.steps.map((s) => (
            <li key={s}>
              <label>
                <input type="checkbox" /> {s}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="cw-actions">
        <button type="button" className="btn btn-small btn-primary" disabled={busy} aria-busy={busy || undefined} title={hasCheck ? `Runs: ${task.check!.join(" ")}` : undefined} onClick={done}>
          Done
        </button>
        {hasCheck && <span className="muted">runs the check first</span>}
      </div>
      {failed && (
        <>
          <p className="error" role="alert">
            {failed.error}
          </p>
          {failed.output && <pre className="cw-output">{failed.output}</pre>}
        </>
      )}
    </div>
  );
}

/** A planned card: it starts unless held. Hold pauses new cards, which asks for Confirm. */
function PlanItem({ card, held, hold }: { card: { id: string; key?: string; title: string }; held?: string; hold: () => void }) {
  return (
    <div className="cw-item cw-plan" data-plan-id={card.id}>
      <p>
        <span className="cw-kind">Plan</span>
        {card.key && <span className="mono">{card.key} </span>}
        <a href={routeHash({ screen: "board", taskId: card.id })}>{card.title}</a>
      </p>
      <div className="cw-actions">
        {held ? (
          <span className="muted">Held: {held}</span>
        ) : (
          <>
            <span className="muted">Starts unless held</span>
            <button type="button" className="btn btn-small" onClick={hold}>
              Hold
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Decisions({ decisions, now, reload }: { decisions: Decision[]; now: number; reload: () => Promise<void> }) {
  if (decisions.length === 0) return <p className="empty">No decisions recorded.</p>;
  return (
    <ol className="cw-items">
      {decisions.map((d) => (
        <li key={d.id} className="cw-entry">
          <DecisionItem decision={d} now={now} reload={reload} />
        </li>
      ))}
    </ol>
  );
}

/** The channel log, the decider's entries included. */
function Log({ entries, now }: { entries: ChannelEntry[]; now: number }) {
  if (entries.length === 0) return <p className="empty">Nothing on the channel yet.</p>;
  // The entry's own fields, as text or as JSON for the structured kinds (claim, question...).
  const body = (m: ChannelEntry["message"]) => (typeof m.text === "string" ? m.text : JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => !["kind", "from", "about"].includes(k)))));
  return (
    <ol className="cw-log">
      {entries.map((e) => (
        <li key={e.ref}>
          <time className="mono" dateTime={e.at}>
            {timeAgo(e.at, now)}
          </time>
          <span className="cw-from">{e.message.from}</span>
          <span className="cw-kind">{e.message.kind}</span>
          <span className="cw-text">{body(e.message)}</span>
        </li>
      ))}
    </ol>
  );
}
