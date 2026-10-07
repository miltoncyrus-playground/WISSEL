import type { PipelineDef, PipelineGraph } from "./types";

// "New pipeline" offers "start blank" or "start from" a saved pipeline
// (docs/SDD-ui-cleanup.md §4.2). Pure, no React or DOM, so bun test
// covers it directly (test/pipeline-editor-templates.test.ts).

/** What the editor holds before the first Save gives it an id. */
export interface PipelineDraft {
  name: string;
  description: string;
  graph: PipelineGraph;
}

export function blankDraft(): PipelineDraft {
  return { name: "", description: "", graph: { steps: [], edges: [] } };
}

/** A copy of `source` to save as a new pipeline. Step and edge ids are
 *  kept: they only need to be unique within one pipeline, and a
 *  "choose" step's handoff `next` may name a step id (see
 *  resolveNextIds in src/core/pipeline-runner.ts), so new ids could
 *  change how the copy routes. Deep-copied, so editing the draft never
 *  touches `source`. */
export function draftFromPipeline(source: PipelineDef): PipelineDraft {
  return {
    name: `${source.name} (copy)`,
    description: source.description,
    graph: {
      steps: source.graph.steps.map((s) => ({ ...s })),
      edges: source.graph.edges.map((e) => ({ ...e })),
    },
  };
}

/** The "start from" list: every saved pipeline, by name. */
export function templateChoices(pipelines: PipelineDef[]): PipelineDef[] {
  return [...pipelines].sort((a, b) => a.name.localeCompare(b.name));
}
