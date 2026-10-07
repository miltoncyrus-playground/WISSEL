import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StepNode as StepNodeType } from "../graph";

/** The interactive fields App.tsx layers onto graph.ts's pure
 *  StepNodeData before handing nodes to <ReactFlow>. Not part of
 *  graph.ts's own data shape so graphToFlow/flowToGraph stay pure. */
export interface StepNodeInteractive {
  /** The step's agent's display name, or undefined if none is picked. */
  agentName: string | undefined;
}

type StepNodeProps = NodeProps<StepNodeType> & { data: StepNodeType["data"] & StepNodeInteractive };

/** One step's canvas card: a read-only summary. Clicking it opens the
 *  step side panel (components/StepPanel.tsx), which holds the name,
 *  agent, transition and join-mode fields (docs/SDD-ui-cleanup.md
 *  §4.2). The join tag only shows on a step with more than one
 *  incoming edge, the only case where joinMode means anything. */
export function StepNode({ data, selected }: StepNodeProps) {
  const { step, incomingCount, agentName } = data;

  return (
    <div className={selected ? "step-node selected" : "step-node"} data-step-id={step.id}>
      <Handle type="target" position={Position.Top} />
      <div className="step-node-name" title={step.name}>
        {step.name || "Unnamed step"}
      </div>
      <div className={agentName ? "step-node-agent" : "step-node-agent missing"}>{agentName ?? "No agent picked"}</div>
      <div className="step-node-tags">
        <span className="step-node-tag" title="Transition">
          {step.transition === "all" ? "fan out: all" : "choose one"}
        </span>
        {incomingCount > 1 && (
          <span className="step-node-tag" title="Join mode">
            join: {step.joinMode ?? "any"}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
