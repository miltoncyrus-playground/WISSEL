import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { AgentDef, JoinMode, PipelineStepDef, TransitionType } from "../types";
import type { StepNode as StepNodeType } from "../graph";

/** The interactive fields App.tsx layers onto graph.ts's pure
 *  StepNodeData before handing nodes to <ReactFlow> — see
 *  App.tsx's withStepCallbacks. Not part of graph.ts's own data shape
 *  because callbacks/agents aren't something graphToFlow/flowToGraph
 *  need to know about to stay pure and testable. */
export interface StepNodeInteractive {
  agents: AgentDef[];
  onChange: (patch: Partial<PipelineStepDef>) => void;
  onDelete: () => void;
}

type StepNodeProps = NodeProps<StepNodeType> & { data: StepNodeType["data"] & StepNodeInteractive };

/** One step's canvas card: rename, agent picker, transition toggle, and
 *  — only when this step actually has more than one incoming edge, per
 *  PipelineStepDef.joinMode's own doc comment — a join-mode toggle.
 *  Acceptance criteria: docs/SDD-pipelines.md §6 subtask 6. */
export function StepNode({ data }: StepNodeProps) {
  const { step, incomingCount, agents, onChange, onDelete } = data;

  return (
    <div className="step-node">
      <Handle type="target" position={Position.Top} />

      <div className="step-node-header">
        <input
          className="step-node-name"
          value={step.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Step name"
          aria-label="Step name"
        />
        <button type="button" className="step-node-delete" onClick={onDelete} title="Delete step" aria-label={`Delete step ${step.name}`}>
          ×
        </button>
      </div>

      <label className="step-node-field">
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

      <label className="step-node-field">
        <span>Transition</span>
        <select
          value={step.transition}
          onChange={(e) => onChange({ transition: e.target.value as TransitionType })}
          aria-label="Transition type"
        >
          <option value="choose">choose — next picks one outgoing edge</option>
          <option value="all">all — fan out to every outgoing edge</option>
        </select>
      </label>

      {incomingCount > 1 && (
        <label className="step-node-field">
          <span>Join mode</span>
          <select
            value={step.joinMode ?? "any"}
            onChange={(e) => onChange({ joinMode: e.target.value as JoinMode })}
            aria-label="Join mode"
          >
            <option value="any">any — fires on first predecessor</option>
            <option value="all">all — waits for every predecessor</option>
          </select>
        </label>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
