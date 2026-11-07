import { useState } from "react";
import { postAction } from "../api";
import { needsYouView, type LaneId, type NeedsYouView } from "../lanes";
import { routeHash } from "../routes";
import { startsChip } from "../schedules";
import { cardTicket } from "../ticket";
import type { TaskCard } from "../types";
import { agentName, useAgents } from "../useAgents";
import { useProjects } from "../useProjects";
import { Avatar } from "./Avatar";

/** One card as a link to its detail (`#/board/<id>`). The lane picks
 *  the colour and the line under the title. A card with an agent shows
 *  the agent's face, pulsing while it runs (SDD §3.6). In Needs a human
 *  the line is what the card wants, then why in full, the steps as
 *  tick-boxes, its reason, blocker and one button, beside the link
 *  (never inside it). In Next step it is the line and the button only.
 *  `onChanged` refetches the cards after a POST button lands. */
export function TaskRow({ task, lane, onChanged }: { task: TaskCard; lane: LaneId; onChanged?: () => void | Promise<void> }) {
  const agents = useAgents();
  const ticket = cardTicket(task, useProjects());
  const agent = task.routedTo ? agentName(agents, task.routedTo) : undefined;
  const human = lane === "needs-you";
  const view = human || lane === "next-step" ? needsYouView(task) : null;
  if (view && !human) {
    delete view.why;
    delete view.checklist;
    delete view.reason;
  }
  const sub = view
    ? view.line
    : lane === "review" && task.reviewInProgress
      ? ["Review in progress", ticket].filter(Boolean).join(" · ")
      : [ticket, agent, task.harness].filter(Boolean).join(" · ") || task.status;
  const starts = startsChip(task.notBefore, Date.now());
  const extra = view && (view.why || view.checklist || view.reason || view.blocker || view.action);
  return (
    <li className={extra ? "task-item has-needs" : "task-item"}>
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
      {extra && <NeedsYouExtra view={view} checkKey={`${task.id}|${task.needsYou?.value ?? ""}`} title={task.title || task.id.slice(0, 8)} onChanged={onChanged} />}
    </li>
  );
}

/** Ticks per card and needsYou.value, so a tick survives a reload but
 *  not a change in what the card wants. Browser-only: storage can be
 *  missing or throw, and then nothing is kept. */
const CHECKS_KEY = "wissel.needsYouChecks";

function readChecks(key: string): number[] {
  try {
    const all = JSON.parse(localStorage.getItem(CHECKS_KEY) ?? "{}") as Record<string, number[]>;
    return Array.isArray(all[key]) ? all[key] : [];
  } catch {
    return [];
  }
}

function writeChecks(key: string, ticks: number[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(CHECKS_KEY) ?? "{}") as Record<string, number[]>;
    if (ticks.length) all[key] = ticks;
    else delete all[key];
    localStorage.setItem(CHECKS_KEY, JSON.stringify(all));
  } catch {
    /* not kept */
  }
}

function Checklist({ steps, checkKey, title }: { steps: string[]; checkKey: string; title: string }) {
  const [ticks, setTicks] = useState<number[]>(() => readChecks(checkKey));
  return (
    <ul className="task-checks" aria-label={`Steps for ${title}`}>
      {steps.map((step, i) => (
        <li key={i}>
          <label>
            <input
              type="checkbox"
              checked={ticks.includes(i)}
              onChange={(e) => {
                const next = e.target.checked ? [...ticks.filter((n) => n !== i), i] : ticks.filter((n) => n !== i);
                setTicks(next);
                writeChecks(checkKey, next);
              }}
            />
            <span>{step}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function NeedsYouExtra({ view, checkKey, title, onChanged }: { view: NeedsYouView; checkKey: string; title: string; onChanged?: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="task-needs">
      {view.why && <p className="task-sub task-why">{view.why}</p>}
      {view.checklist && <Checklist steps={view.checklist} checkKey={checkKey} title={title} />}
      {view.reason && (
        <>
          <p className={view.reasonLong && !open ? "task-sub task-reason is-clipped" : "task-sub task-reason"}>{view.reason}</p>
          {view.reasonLong && (
            <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
      {(view.round || view.grants) && (
        <p className="task-sub">
          {view.round}
          {view.round && view.grants && " · "}
          {view.grants && <span className="mono">{view.grants.join(", ")}</span>}
        </p>
      )}
      {view.blocker && <p className="task-sub mono">Blocked by {view.blocker}</p>}
      {view.action && <NeedsYouButton action={view.action} title={title} onChanged={onChanged} />}
    </div>
  );
}

function NeedsYouButton({ action, title, onChanged }: { action: NonNullable<NeedsYouView["action"]>; title: string; onChanged?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (action.method === "GET") {
    return (
      <a className="btn btn-small" href={action.href} aria-label={`${action.label}: ${title}`}>
        {action.label}
      </a>
    );
  }
  return (
    <div className="task-action">
      <button
        type="button"
        className="btn btn-small btn-primary"
        disabled={busy}
        aria-label={`${action.label}: ${title}`}
        onClick={() => {
          setBusy(true);
          setError(null);
          postAction(action.href).then(
            async () => {
              setBusy(false);
              await onChanged?.();
            },
            (err: unknown) => {
              setBusy(false);
              setError(err instanceof Error ? err.message : String(err));
            },
          );
        }}
      >
        {busy ? `${action.label}…` : action.label}
      </button>
      {error && (
        <p className="error task-sub" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
