import type { AgentDef, JoinMode, PipelineStepDef, TransitionType } from "../types";

interface StepPanelProps {
  /** The selected step, or null when nothing is selected. */
  step: PipelineStepDef | null;
  incomingCount: number;
  agents: AgentDef[];
  onChange: (patch: Partial<PipelineStepDef>) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** The step side panel (docs/SDD-ui-cleanup.md §4.2): clicking a step on
 *  the canvas edits it here instead of in dropdowns inside the node.
 *  The panel always takes its column, empty or not, so selecting a
 *  step never resizes the canvas under the pointer. Field labels keep
 *  the aria-labels the old in-node fields had ("Step name", "Agent",
 *  "Transition type", "Join mode"). Join mode only shows for a step
 *  with more than one incoming edge (PipelineStepDef.joinMode: "only
 *  meaningful for a step with more than one incoming edge"). */
export function StepPanel({ step, incomingCount, agents, onChange, onDelete, onClose }: StepPanelProps) {
  if (!step) {
    return (
      <aside className="pe-step-panel" aria-label="Step settings">
        <p className="pe-panel-empty">Click a step to edit its name, agent, transition and join mode. Drag from a step's bottom handle to another step's top handle to connect them.</p>
      </aside>
    );
  }

  return (
    <aside className="pe-step-panel" aria-label="Step settings">
      <div className="pe-panel-head">
        <h2>Step</h2>
        <button type="button" className="pe-btn pe-icon-btn" onClick={onClose} aria-label="Close step panel" title="Close">
          ×
        </button>
      </div>

      <label className="pe-field">
        <span>Name</span>
        <input value={step.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="Step name" aria-label="Step name" />
      </label>

      <label className="pe-field">
        <span>Agent</span>
        <select value={step.agentId} onChange={(e) => onChange({ agentId: e.target.value })} aria-label="Agent">
          <option value="" disabled>
            Choose an agent…
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>

      <label className="pe-field">
        <span>Transition</span>
        <select value={step.transition} onChange={(e) => onChange({ transition: e.target.value as TransitionType })} aria-label="Transition type">
          <option value="choose">choose: the step's handoff picks one outgoing edge</option>
          <option value="all">all: fan out to every outgoing edge</option>
        </select>
      </label>

      {incomingCount > 1 ? (
        <label className="pe-field">
          <span>Join mode</span>
          <select value={step.joinMode ?? "any"} onChange={(e) => onChange({ joinMode: e.target.value as JoinMode })} aria-label="Join mode">
            <option value="any">any: start on the first predecessor</option>
            <option value="all">all: wait for every predecessor</option>
          </select>
        </label>
      ) : (
        <p className="pe-field-hint">Join mode applies once two or more steps lead into this one.</p>
      )}

      <p className="pe-field-hint mono" title="Step id">
        {step.id}
      </p>

      <button type="button" className="pe-btn pe-danger" onClick={onDelete} aria-label={`Delete step ${step.name}`}>
        Delete step
      </button>
    </aside>
  );
}
