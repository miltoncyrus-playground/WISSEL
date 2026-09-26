// Mirrors the shapes in ../../src/core/types.ts (PipelineStepDef,
// PipelineEdgeDef, PipelineGraph, PipelineDef, AgentDef) — duplicated
// rather than imported, because this app is a genuinely separate
// deployable unit (own package.json, own build, own dependency tree; see
// docs/SDD-pipelines.md §3.2) and importing across that boundary would
// pull wissel's whole server-side dependency graph into a browser bundle.
// test/pipeline-editor-types-parity.test.ts diffs the four shared
// interfaces' fields against src/core/types.ts on every root test run —
// it fails the build if they drift, so this isn't just a comment promise.

export type TransitionType = "choose" | "all";
export type JoinMode = "any" | "all";

export interface PipelineStepDef {
  id: string;
  name: string;
  agentId: string;
  transition: TransitionType;
  joinMode?: JoinMode;
}

export interface PipelineEdgeDef {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface PipelineGraph {
  steps: PipelineStepDef[];
  edges: PipelineEdgeDef[];
}

export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  graph: PipelineGraph;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDef {
  id: string;
  name: string;
  kind: string;
  tier: string;
  description: string;
  tags: string[];
}

export interface TaskCard {
  id: string;
  status: string;
  pipelineId?: string;
  [key: string]: unknown;
}
