// Type declaration for board-run-canvas.js — a plain browser script (no
// build step, see its own header comment) that's also imported directly
// by bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
import type { PipelineDef, PipelineEdgeDef, PipelineStepDef, TaskCard } from "../../core/types.ts";
import type { DisplayStatus } from "./board-lanes.d.ts";

type CanvasTask = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
type CanvasPipeline = Partial<Pick<PipelineDef, "graph">> | null | undefined;

export const RUN_CANVAS_GEOMETRY: {
  nodeWidth: number;
  nodeHeight: number;
  columnGap: number;
  rowGap: number;
  pad: number;
  backEdgeDrop: number;
};

export interface RunCanvasNode {
  id: string;
  name: string;
  agentId: string | null;
  status: DisplayStatus | "pending";
  taskId: string | null;
  taskStatus: TaskCard["status"] | null;
  attempt: number;
  inDefinition: boolean;
  layer: number;
  x: number;
  y: number;
}

export interface RunCanvasEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  back: boolean;
  reached: boolean;
  path: string;
  labelAt: { x: number; y: number };
}

export interface RunCanvasModel {
  nodes: RunCanvasNode[];
  edges: RunCanvasEdge[];
  width: number;
  height: number;
}

export function canvasLayers(
  steps: Pick<PipelineStepDef, "id">[],
  edges: Pick<PipelineEdgeDef, "id" | "from" | "to">[],
): { layer: Record<string, number>; back: Record<string, true>; edges: Pick<PipelineEdgeDef, "id" | "from" | "to">[] };

export function runCanvasModel(
  root: CanvasTask | null | undefined,
  steps: CanvasTask[] | null | undefined,
  def: CanvasPipeline,
): RunCanvasModel;
