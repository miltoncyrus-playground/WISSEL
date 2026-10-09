#!/usr/bin/env bun
/**
 * Creates the stored "AI news podcast" pipeline (docs/SDD-ai-news-podcast.md
 * §3.3) through the same PipelineStore `POST /pipelines` writes to, on the
 * board database the server uses (`WISSEL_DB_PATH`, default
 * `~/.wissel/board.sqlite`).
 *
 * Keyed by name. If a pipeline called "AI news podcast" already exists
 * and its graph differs from the template (the three-step version from
 * before the "Make audio" step, §3.7, or a hand-edited one), its graph is
 * replaced in place: same id, so its past runs stay linked; its name and
 * description are kept. When the graph already matches, nothing is
 * written, so running this twice changes nothing the second time.
 *
 *   bun run seed:ai-news
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { aiNewsPodcastDraft } from "../pipeline-editor/src/templates.ts";
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
  const draft = aiNewsPodcastDraft();
  const missing = draft.graph.steps.filter((s) => !registry.get(s.agentId)).map((s) => s.agentId);
  if (missing.length > 0) {
    throw new Error(`agents/manifest.yaml has no agent(s) ${missing.join(", ")}; the "${draft.name}" pipeline needs them`);
  }
  const existing = (await store.list()).find((p) => p.name === draft.name);
  if (!existing) return { pipeline: await store.create(draft), outcome: "created" };
  if (Bun.deepEquals(existing.graph, draft.graph)) return { pipeline: existing, outcome: "unchanged" };
  const pipeline = await store.update(existing.id, { name: existing.name, description: existing.description, graph: draft.graph });
  return { pipeline, outcome: "updated" };
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const board = new SqliteBoard(dbPath);
  const { pipeline, outcome } = await seedAiNewsPipeline(new SqlitePipelineStore(board.db), await Registry.load());
  const steps = pipeline.graph.steps.map((s) => s.name).join(" -> ");
  console.log(
    outcome === "created"
      ? `Created "${pipeline.name}" (${pipeline.id}) in ${dbPath}: ${steps}.`
      : outcome === "updated"
        ? `Updated "${pipeline.name}" (${pipeline.id}) in place in ${dbPath}: ${steps}.`
        : `"${pipeline.name}" (${pipeline.id}) in ${dbPath} already matches the template; left unchanged.`,
  );
}
