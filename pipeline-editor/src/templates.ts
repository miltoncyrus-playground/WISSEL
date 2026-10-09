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

/** The AI news podcast pipeline (docs/SDD-ai-news-podcast.md §3.3,
 *  §3.7): gather -> explain simply -> podcast script -> make audio, in a
 *  line, "all" on every step so no `next` is needed. Every agent is
 *  readonly with no write/bash (the audio step is TtsExecutor, no LLM),
 *  so it runs with no repo. The one definition both the
 *  "New pipeline" built-in list and scripts/seed-ai-news-pipeline.ts
 *  use; type-only imports keep this file loadable from bun test and
 *  the seed script without React. */
export function aiNewsPodcastDraft(): PipelineDraft {
  return {
    name: AI_NEWS_PODCAST_NAME,
    description: "Gathers the week's AI news from the web, explains it simply, writes a 5 minute podcast script with a quick read, and makes it an MP3 with a local voice.",
    graph: {
      steps: [
        { id: "gather", name: "Gather news", agentId: "ai-news-gatherer", transition: "all" },
        { id: "explain", name: "Explain simply", agentId: "eli5-explainer", transition: "all" },
        { id: "script", name: "Write podcast script", agentId: "podcast-scriptwriter", transition: "all" },
        { id: "audio", name: "Make audio", agentId: "podcast-audio", transition: "all" },
      ],
      edges: [
        { id: "gather-explain", from: "gather", to: "explain" },
        { id: "explain-script", from: "explain", to: "script" },
        { id: "script-audio", from: "script", to: "audio" },
      ],
    },
  };
}

export const WORLD_NEWS_PODCAST_NAME = "World news podcast";

/** The same four steps as the AI news podcast with a different gather
 *  step: world-news-gatherer finds the last 48 hours' top world
 *  headlines plus Spain and the Netherlands, each story tagged with a
 *  `region`. Explain, script and audio are shared unchanged (the
 *  explainer copies `region` through; the scriptwriter groups by it). */
export function worldNewsPodcastDraft(): PipelineDraft {
  const draft = aiNewsPodcastDraft();
  return {
    name: WORLD_NEWS_PODCAST_NAME,
    description: "Gathers today's top world headlines plus the main news from Spain and the Netherlands, explains them simply, writes a 5 minute podcast script with a quick read, and makes it an MP3 with a local voice.",
    graph: {
      steps: draft.graph.steps.map((s) => (s.id === "gather" ? { ...s, name: "Gather headlines", agentId: "world-news-gatherer" } : s)),
      edges: draft.graph.edges,
    },
  };
}

export const WISSEL_RETRO_PODCAST_NAME = "Wissel retrospective podcast";

/** docs/SDD-wissel-retro-podcast.md: collect wissel's own activity
 *  (wissel-digest, deterministic, no LLM) -> analyse it into done,
 *  learnings, improve and ideas -> the shared script and audio steps.
 *  Readonly with no write/bash, so it runs with no repo; the run input
 *  optionally sets the period ("last 30 days", "since 2026-10-01"). */
export function wisselRetroPodcastDraft(): PipelineDraft {
  const draft = aiNewsPodcastDraft();
  const shared = draft.graph.steps.filter((s) => s.id === "script" || s.id === "audio");
  return {
    name: WISSEL_RETRO_PODCAST_NAME,
    description: "Collects what you did with wissel (cards, merges, spend, lessons, SDDs), picks what you built, what you learned, what to improve and ideas to think about, writes a 5 minute podcast script with a quick read, and makes it an MP3 with a local voice.",
    graph: {
      steps: [
        { id: "collect", name: "Collect activity", agentId: "wissel-digest", transition: "all" },
        { id: "analyse", name: "Analyse", agentId: "wissel-retro-analyst", transition: "all" },
        ...shared,
      ],
      edges: [
        { id: "collect-analyse", from: "collect", to: "analyse" },
        { id: "analyse-script", from: "analyse", to: "script" },
        ...draft.graph.edges.filter((e) => e.from === "script"),
      ],
    },
  };
}

/** Ready-made pipelines "New pipeline" offers next to the saved ones.
 *  Fresh objects each call, so editing a draft never changes the next. */
export function builtInTemplates(): PipelineDraft[] {
  return [aiNewsPodcastDraft(), worldNewsPodcastDraft(), wisselRetroPodcastDraft()];
}

/** The "start from" list: every saved pipeline, by name. */
export function templateChoices(pipelines: PipelineDef[]): PipelineDef[] {
  return [...pipelines].sort((a, b) => a.name.localeCompare(b.name));
}
