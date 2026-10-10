#!/usr/bin/env bun
/**
 * Creates the stored "AI news podcast", "World news podcast" and "Wissel
 * retrospective podcast" pipelines (docs/SDD-ai-news-podcast.md §3.3,
 * §3.8, docs/SDD-wissel-retro-podcast.md §3.4) through the same
 * PipelineStore `POST /pipelines` writes to, on the
 * board database the server uses (`WISSEL_DB_PATH`, default
 * `~/.wissel/board.sqlite`).
 *
 * Keyed by name. If a pipeline called "AI news podcast" already exists
 * and its graph differs from the template (the three-step version from
 * before the "Make audio" step, §3.7, or a hand-edited one), its graph is
 * replaced in place: same id, so its past runs stay linked; its name and
 * description are kept (unless the description is an older template's
 * own text, OLD_TEMPLATE_DESCRIPTIONS). When the graph already matches, nothing is
 * written, so running this twice changes nothing the second time.
 *
 *   bun run seed:ai-news
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { aiNewsPodcastDraft, wisselRetroPodcastDraft, worldNewsPodcastDraft, type PipelineDraft } from "../pipeline-editor/src/templates.ts";
import { Registry } from "../src/core/registry.ts";
import type { PipelineDef } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore, type PipelineStore } from "../src/services/pipelines.ts";

export interface SeedResult {
  pipeline: PipelineDef;
  /** "created": there was none. "updated": the stored graph differed and
   *  was replaced (same id). "unchanged": it already matched. */
  outcome: "created" | "updated" | "unchanged";
}

/** Creates or upgrades the pipeline. Throws before writing anything if a
 *  step's agent isn't in `registry`, so a manifest without the news
 *  agents can't seed a pipeline that would only fail at run time. */
export async function seedAiNewsPipeline(store: PipelineStore, registry: Registry): Promise<SeedResult> {
  return seedPipeline(store, registry, aiNewsPodcastDraft());
}

/** The "World news podcast" pipeline, seeded the same way. */
export async function seedWorldNewsPipeline(store: PipelineStore, registry: Registry): Promise<SeedResult> {
  return seedPipeline(store, registry, worldNewsPodcastDraft());
}

/** The "Wissel retrospective podcast" pipeline, seeded the same way. */
export async function seedWisselRetroPipeline(store: PipelineStore, registry: Registry): Promise<SeedResult> {
  return seedPipeline(store, registry, wisselRetroPodcastDraft());
}

/** Descriptions earlier templates wrote. A stored pipeline still carrying
 *  one of these gets the current template's description on reseed; any
 *  other description is the user's own and is kept. §3.9 dropped
 *  "explains it simply". */
export const OLD_TEMPLATE_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "Gathers the week's AI news from the web, explains it simply, writes a 5 minute podcast script with a quick read, and makes it an MP3 with a local voice.",
  "Gathers today's top world headlines plus the main news from Spain and the Netherlands, explains them simply, writes a 5 minute podcast script with a quick read, and makes it an MP3 with a local voice.",
]);

/** Creates or upgrades one podcast pipeline from its template, keyed by name. */
export async function seedPipeline(store: PipelineStore, registry: Registry, draft: PipelineDraft): Promise<SeedResult> {
  const missing = draft.graph.steps.filter((s) => !registry.get(s.agentId)).map((s) => s.agentId);
  if (missing.length > 0) {
    throw new Error(`agents/manifest.yaml has no agent(s) ${missing.join(", ")}; the "${draft.name}" pipeline needs them`);
  }
  const existing = (await store.list()).find((p) => p.name === draft.name);
  if (!existing) return { pipeline: await store.create(draft), outcome: "created" };
  const description = OLD_TEMPLATE_DESCRIPTIONS.has(existing.description) ? draft.description : existing.description;
  if (Bun.deepEquals(existing.graph, draft.graph) && description === existing.description) return { pipeline: existing, outcome: "unchanged" };
  const pipeline = await store.update(existing.id, { name: existing.name, description, graph: draft.graph });
  return { pipeline, outcome: "updated" };
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const board = new SqliteBoard(dbPath);
  const store = new SqlitePipelineStore(board.db);
  const registry = await Registry.load();
  for (const { pipeline, outcome } of [
    await seedAiNewsPipeline(store, registry),
    await seedWorldNewsPipeline(store, registry),
    await seedWisselRetroPipeline(store, registry),
  ]) {
    const steps = pipeline.graph.steps.map((s) => s.name).join(" -> ");
    console.log(
      outcome === "created"
        ? `Created "${pipeline.name}" (${pipeline.id}) in ${dbPath}: ${steps}.`
        : outcome === "updated"
          ? `Updated "${pipeline.name}" (${pipeline.id}) in place in ${dbPath}: ${steps}.`
          : `"${pipeline.name}" (${pipeline.id}) in ${dbPath} already matches the template; left unchanged.`,
    );
  }
}
