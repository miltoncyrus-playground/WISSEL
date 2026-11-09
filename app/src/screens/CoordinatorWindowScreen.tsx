import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { approveAsk, createWorkstream, fetchWindow, fetchWorkstreams, flipDecision, ownerTaskDone, postWindowMessage, rejectAsk, resolveWindowAction, setProjectRole } from "../api";
import { events } from "../events";
import { routeHash } from "../routes";
import { timeAgo } from "../time";
import { useProjects } from "../useProjects";
import { PROJECT_ROLES, type ChannelEntry, type ChatMessage, type CoordinatorAsk, type Decision, type OwnerTask, type ProjectRole, type QuickAction, type WindowDocument, type WindowExecuted, type WindowItem, type Workstream } from "../types";
import { askConfirmLine, describeAsk, pendingRoleText, resolvedAskLine } from "../window-asks";
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
const POLL_MS = 3000;
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
  const [heardAt, setHeardAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastJson = useRef("");
  const projects = useProjects();

  const load = useCallback(async () => {
    if (!workstreamId) return;
    try {
      const next = await fetchWindow(workstreamId);
      const json = JSON.stringify(next);
      if (json !== lastJson.current) {
        lastJson.current = json; // an unchanged document is not a re-render: open confirm lines and drafts stay put
        setDoc(next);
      }
      setHeardAt(Date.now());
      setError(null);
    } catch (err) {
      setError(text(err));
    } finally {
      setLoaded(true);
    }
  }, [workstreamId]);

  useEffect(() => {
    setDoc(null);
    lastJson.current = "";
    setLoaded(false);
    setRoleChange(null);
    void load();
    // A board event refetches, debounced like the board. The channel, the asks, the gate log and the outbound queue
    // raise no board event, so the window also looks again every POLL_MS while it is on screen.
    const off = events.subscribe(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
    });
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
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
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const needsYou = (doc?.items ?? []).filter((it) => it.kind === "ask" || it.kind === "owner-task").length;
  const ago = heardAt === null ? "" : `updated ${Math.max(0, Math.round((now - heardAt) / 1000))}s ago`;
  return (
    <div className="screen window-screen cw">
      <div className="screen-head cw-bar">
        <h1>Coordinator window{h ? `: ${h.workstream.name}` : ""}</h1>
        <span className={`cw-live${error ? " is-down" : ""}`} role="status">
          <span className="cw-dot" aria-hidden="true" />
          {error ? "offline" : "live"}
          {ago && !error ? <span className="muted"> · {ago}</span> : null}
        </span>
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
          <div className="cw-chips">
            <span className="cw-name">
              {h.workstream.name}
              {h.workstream.ticket && <span className="mono"> {h.workstream.ticket}</span>}
            </span>
            {h.roles.length === 0 && <span className="muted">no projects</span>}
            {h.roles.map((r) => (
              <span className="cw-role" key={r.projectId} title={r.projectId}>
                <span>{nameOf(r.projectId)}</span>
                <select aria-label={`Role for ${r.projectId}`} value={roleChange?.projectId === r.projectId ? roleChange.to : r.role} onChange={(e) => setRoleChange(e.target.value === r.role ? null : { projectId: r.projectId, from: r.role, to: e.target.value as ProjectRole })}>
                  {PROJECT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                {r.decider && <span className="muted">({r.decider})</span>}
                {r.pendingRole && <span className="muted cw-pending-role">{pendingRoleText(r)}</span>}
              </span>
            ))}
            {needsYou > 0 && <span className="cw-chip is-hot">{needsYou} need{needsYou === 1 ? "s" : ""} you</span>}
            <span className={`cw-chip${paused ? " is-hot" : ""}`} title={paused ? h.live.dispatchHold ?? undefined : undefined}>
              {paused ? "New cards paused" : "New cards start"}
            </span>
            {h.live.restartPending && <span className="cw-chip is-hot">Restart pending</span>}
            <span className="cw-chip">{h.live.running} running</span>
            {h.outbound.queued > 0 && <span className="cw-chip">{h.outbound.queued} queued</span>}
            {h.quietHours?.quiet && <span className="cw-chip">Quiet hours</span>}
          </div>
          <details className="cw-more">
            <summary>Details</summary>
            <dl>
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
              <dt>Dispatch</dt>
              <dd>{paused ? `paused: ${h.live.dispatchHold}` : "open"}</dd>
            </dl>
          </details>
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
          <div className="cw-toolbar">
            <div className="segmented cw-tabs" role="tablist" aria-label="Window tabs">
              {TABS.map((t) => (
                <button key={t} type="button" role="tab" id={`cw-tab-${t}`} className="segment" aria-selected={tab === t} aria-controls="cw-panel" onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
            <ul className="cw-quick" aria-label="Quick actions">
              {QUICK.map((q) => (
                <li key={q.action}>
                  <button type="button" className="btn btn-small" disabled={sending} onClick={() => send({ action: q.action === "pause-new-cards" && paused ? "resume-new-cards" : q.action })}>
                    {q.action === "pause-new-cards" && paused ? "Resume new cards" : q.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div role="tabpanel" id="cw-panel" aria-labelledby={`cw-tab-${tab}`} className="cw-panel">
            {tab === "Conversation" && <Conversation doc={doc} workstreamId={workstreamId} now={now} resolve={resolve} reload={load} hold={() => send({ action: "pause-new-cards" })} />}
            {tab === "Decisions" && <Decisions decisions={doc.decisions} now={now} reload={load} />}
            {tab === "Log" && <Log entries={doc.log} resolvedAsks={doc.resolvedAsks ?? []} now={now} />}
          </div>
          <div className="cw-foot">
            <form className="cw-compose" onSubmit={onSubmit}>
              <label htmlFor="cw-input" className="sr-only">
                Message to the window
              </label>
              <input id="cw-input" type="text" autoComplete="off" placeholder="Ask the window" value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className="btn btn-small btn-primary" disabled={sending || !draft.trim()}>
                Send
              </button>
              <label className="cw-toggle">
                <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
                Log it on the channel
              </label>
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
 *  them; owner tasks, asks and plans (no time of their own) wait at the end. */
function Conversation({ doc, workstreamId, now, resolve, reload, hold }: { doc: WindowDocument; workstreamId: string; now: number; resolve: (id: string, verb: "confirm" | "cancel") => Promise<void>; reload: () => Promise<void>; hold: () => void }) {
  const timed: Timed[] = [
    ...(doc.conversation?.messages ?? []).map((m) => ({ at: m.at, key: m.id, node: <Message message={m} resolve={resolve} /> })),
    ...doc.items.flatMap((it, i): Timed[] => {
      if (it.kind === "status") return [{ at: it.at, key: `s${i}`, node: <StatusLine at={it.at} from={it.from} text={it.text} now={now} /> }];
      if (it.kind === "decision") return [{ at: it.decision.at, key: it.decision.id, node: <DecisionItem decision={it.decision} now={now} reload={reload} /> }];
      return [];
    }),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const waiting = doc.items.filter((it): it is Extract<WindowItem, { kind: "owner-task" | "ask" | "plan" }> => it.kind === "owner-task" || it.kind === "ask" || it.kind === "plan");
  if (timed.length === 0 && waiting.length === 0) return <p className="lede">Nothing yet. Ask for the status, or what is waiting on you.</p>;
  return (
    <ol className="cw-items" role="log" aria-label="Conversation">
      {timed.map((t) => (
        <li key={t.key} className="cw-entry">
          {t.node}
        </li>
      ))}
      {waiting.map((it) => (
        <li key={it.kind === "owner-task" ? it.task.id : it.kind === "ask" ? it.ask.id : it.card.id} className="cw-entry">
          {it.kind === "owner-task" ? <OwnerTaskItem task={it.task} hasCheck={it.hasCheck} reload={reload} /> : it.kind === "ask" ? <AskItem ask={it.ask} workstreamId={workstreamId} reload={reload} /> : <PlanItem card={it.card} held={it.held} hold={hold} />}
        </li>
      ))}
    </ol>
  );
}

/** An open ask (§4.2 rules 5 and 7): what wissel wants to do and why the
 *  gate asked, with Approve and Reject. Approve first shows the change as
 *  the window's Confirm line and runs nothing until Confirm, so a stray
 *  tap never arms a PR; Reject runs nothing, so it goes straight through.
 *  A 409 (a hard limit trips now, resolved meanwhile, Shadow) stays under
 *  the item in the server's words; the item stays until a refetch drops it. */
function AskItem({ ask, workstreamId, reload }: { ask: CoordinatorAsk; workstreamId: string; reload: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = describeAsk(ask);
  const answer = (verb: "approve" | "reject") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    (verb === "approve" ? approveAsk : rejectAsk)(workstreamId, ask.id).then(
      () => reload().then(() => setBusy(false)),
      (err: unknown) => {
        setBusy(false);
        setConfirming(false);
        setError(text(err));
      },
    );
  };
  return (
    <div className="cw-item cw-ask" data-ask-id={ask.id}>
      <p>
        <span className="cw-kind">Ask</span>
        <strong className="cw-text">wissel wants to {d.what}</strong>
      </p>
      <p className="muted">{d.why}</p>
      {d.onChannel && <p className="muted">The decider can also answer approve or reject on the channel.</p>}
      {confirming ? (
        <div className="cw-change" role="group" aria-label="Confirm the approval">
          <p className="confirm-head">{askConfirmLine(ask)}</p>
          <div className="confirm-actions">
            <button type="button" className="btn btn-small btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={() => answer("approve")}>
              Confirm
            </button>
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="cw-actions">
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => setConfirming(true)}>
            Approve
          </button>
          <button type="button" className="btn btn-small" disabled={busy} aria-busy={busy || undefined} onClick={() => answer("reject")}>
            Reject
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
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

/** The channel log, the decider's entries included, and the resolved asks
 *  (who answered, how) in time order among them. */
function Log({ entries, resolvedAsks, now }: { entries: ChannelEntry[]; resolvedAsks: CoordinatorAsk[]; now: number }) {
  // The entry's own fields, as text or as JSON for the structured kinds (claim, question...).
  const body = (m: ChannelEntry["message"]) => (typeof m.text === "string" ? m.text : JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => !["kind", "from", "about"].includes(k)))));
  const rows = [
    ...entries.map((e) => ({ key: e.ref, at: e.at, from: e.message.from, kind: e.message.kind, text: body(e.message), askId: undefined as string | undefined })),
    ...resolvedAsks.map((a) => ({ key: `ask-${a.id}`, at: a.resolvedAt ?? a.askedAt, askId: a.id, ...resolvedAskLine(a) })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (rows.length === 0) return <p className="empty">Nothing on the channel yet.</p>;
  return (
    <ol className="cw-log">
      {rows.map((r) => (
        <li key={r.key} data-ask-id={r.askId}>
          <time className="mono" dateTime={r.at}>
            {timeAgo(r.at, now)}
          </time>
          <span className="cw-from">{r.from}</span>
          <span className="cw-kind">{r.kind}</span>
          <span className="cw-text">{r.text}</span>
        </li>
      ))}
    </ol>
  );
}
