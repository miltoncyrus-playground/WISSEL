#!/usr/bin/env bun
/**
 * Creates the stored "AI news podcast" pipeline (docs/SDD-ai-news-podcast.md
 * §3.3) through the same PipelineStore `POST /pipelines` writes to, on the
 * board database the server uses (`WISSEL_DB_PATH`, default
 * `~/.wissel/board.sqlite`).
 *
 * Idempotent by name: if a pipeline called "AI news podcast" already
 * exists it is left exactly as it is (it may hold your own edits), so
 * running this twice leaves one pipeline. Delete it on the Pipelines page
 * and run this again to get the original back.
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
  created: boolean;
}

/** Creates the pipeline unless one with the same name exists. Throws
 *  before writing anything if a step's agent isn't in `registry`, so a
 *  manifest without the three news agents can't seed a pipeline that
 *  would only fail at run time. */
export async function seedAiNewsPipeline(store: PipelineStore, registry: Registry): Promise<SeedResult> {
  const draft = aiNewsPodcastDraft();
  const missing = draft.graph.steps.filter((s) => !registry.get(s.agentId)).map((s) => s.agentId);
  if (missing.length > 0) {
    throw new Error(`agents/manifest.yaml has no agent(s) ${missing.join(", ")}; the "${draft.name}" pipeline needs them`);
  }
  const existing = (await store.list()).find((p) => p.name === draft.name);
  if (existing) return { pipeline: existing, created: false };
  return { pipeline: await store.create(draft), created: true };
}

if (import.meta.main) {
  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const board = new SqliteBoard(dbPath);
  const { pipeline, created } = await seedAiNewsPipeline(new SqlitePipelineStore(board.db), await Registry.load());
  console.log(
    created
      ? `Created "${pipeline.name}" (${pipeline.id}) in ${dbPath}.`
      : `"${pipeline.name}" already exists (${pipeline.id}) in ${dbPath}; left unchanged.`,
  );
}
