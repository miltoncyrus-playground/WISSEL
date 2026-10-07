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

export const AI_NEWS_PODCAST_NAME = "AI news podcast";

/** The AI news podcast pipeline (docs/SDD-ai-news-podcast.md §3.3):
 *  gather -> explain simply -> podcast script, in a line, "all" on every
 *  step so no `next` is needed. Every agent is readonly with no
 *  write/bash, so it runs with no repo. The one definition both the
 *  "New pipeline" built-in list and scripts/seed-ai-news-pipeline.ts
 *  use; type-only imports keep this file loadable from bun test and
 *  the seed script without React. */
export function aiNewsPodcastDraft(): PipelineDraft {
  return {
    name: AI_NEWS_PODCAST_NAME,
    description: "Gathers the week's AI news from the web, explains it simply, and writes a 5 minute podcast script with a quick read.",
    graph: {
      steps: [
        { id: "gather", name: "Gather news", agentId: "ai-news-gatherer", transition: "all" },
        { id: "explain", name: "Explain simply", agentId: "eli5-explainer", transition: "all" },
        { id: "script", name: "Write podcast script", agentId: "podcast-scriptwriter", transition: "all" },
      ],
      edges: [
        { id: "gather-explain", from: "gather", to: "explain" },
        { id: "explain-script", from: "explain", to: "script" },
      ],
    },
  };
}

/** Ready-made pipelines "New pipeline" offers next to the saved ones.
 *  Fresh objects each call, so editing a draft never changes the next. */
export function builtInTemplates(): PipelineDraft[] {
  return [aiNewsPodcastDraft()];
}

/** The "start from" list: every saved pipeline, by name. */
export function templateChoices(pipelines: PipelineDef[]): PipelineDef[] {
  return [...pipelines].sort((a, b) => a.name.localeCompare(b.name));
}
