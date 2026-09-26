import type { Edge, Node } from "@xyflow/react";
import type { PipelineEdgeDef, PipelineGraph, PipelineStepDef } from "./types";

/** The data a "step" node carries — kept minimal and pure (no callbacks)
 *  so graphToFlow/flowToGraph stay deterministic, unit-testable
 *  functions. App.tsx layers interactivity (onChange/onDelete, live
 *  agents list) on top when it builds the nodes it actually hands to
 *  <ReactFlow>, via withStepCallbacks below. */
export interface StepNodeData extends Record<string, unknown> {
  step: PipelineStepDef;
  incomingCount: number;
}

export type StepNode = Node<StepNodeData, "step">;

const GRID_COLUMNS = 4;
const COLUMN_WIDTH = 260;
const ROW_HEIGHT = 200;

/** Counts incoming edges per target step id — what decides whether a
 *  step's join-mode toggle is shown (see docs/SDD-pipelines.md §3.6 and
 *  PipelineStepDef.joinMode's own doc comment: "only meaningful for a
 *  step with more than one incoming edge"). */
export function incomingCounts(edges: Pick<PipelineEdgeDef, "to">[] | Edge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    const target = "to" in e ? e.to : e.target;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return counts;
}

/** Converts a stored PipelineGraph into React Flow's node/edge shape.
 *  `positions` carries forward each step's last-known canvas position
 *  (keyed by step id) so reloading a saved pipeline doesn't reshuffle
 *  the layout the human already arranged; a step with no known position
 *  (new, or never positioned) falls back to a deterministic grid so it's
 *  never dropped at (0,0) on top of every other unpositioned step. */
export function graphToFlow(graph: PipelineGraph, positions: Record<string, { x: number; y: number }> = {}): { nodes: StepNode[]; edges: Edge[] } {
  const incoming = incomingCounts(graph.edges);
  const nodes: StepNode[] = graph.steps.map((step, i) => ({
    id: step.id,
    type: "step",
    position: positions[step.id] ?? { x: (i % GRID_COLUMNS) * COLUMN_WIDTH + 40, y: Math.floor(i / GRID_COLUMNS) * ROW_HEIGHT + 40 },
    data: { step, incomingCount: incoming.get(step.id) ?? 0 },
  }));
  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.label,
  }));
  return { nodes, edges };
}

/** The inverse of graphToFlow — what Save serializes back to the
 *  /pipelines API. Reads each node's own `data.step`, so any in-place
 *  edit (name, agentId, transition, joinMode) already applied to node
 *  state round-trips without a separate "diff against the original"
 *  step. */
export function flowToGraph(nodes: StepNode[], edges: Edge[]): PipelineGraph {
  return {
    steps: nodes.map((n) => n.data.step),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      label: typeof e.label === "string" ? e.label : undefined,
    })),
  };
}

/** Every step's current canvas position, keyed by id — what graphToFlow's
 *  `positions` argument expects on the next load, and what a save-then-
 *  reload round trip depends on to restore layout, not just graph shape. */
export function positionsOf(nodes: StepNode[]): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) out[n.id] = n.position;
  return out;
}
