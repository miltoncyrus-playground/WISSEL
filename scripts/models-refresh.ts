#!/usr/bin/env bun
/**
 * Fills ~/.wissel/models-cache.json once, without turning on the
 * background refresh (WISSEL_MODEL_REFRESH). Loads the harness pool the
 * way src/api/server.ts does (HarnessPool.autoload), runs one
 * runModelRefreshTick and prints each harness with its model count,
 * fetchedAt and any error. docs/SDD-model-selection.md §8.
 *
 *   bun run models:refresh
 *
 * Free: claude-cli is a static list, codex-cli runs `codex debug models`
 * locally, and anthropic-api makes one models.list() call per harness,
 * which is not billed.
 *
 * WISSEL_HARNESSES_PATH and WISSEL_MODELS_CACHE_PATH as for the server.
 */
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { AnthropicModelsClient } from "../src/core/model-catalog.ts";
import { DEFAULT_MODELS_CACHE_PATH, runModelRefreshTick } from "../src/core/model-refresh-scheduler.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

export interface RefreshRow {
  harnessId: string;
  tool: string;
  enabled: boolean;
  /** undefined when this harness has never been cached. */
  models?: number;
  fetchedAt?: string;
  error?: string;
}

/** One refresh tick over `pool`, reported per harness. A harness that
 *  failed this tick keeps its previous cache entry (runModelRefreshTick's
 *  own contract), so its row shows the old fetchedAt next to the error. */
export async function refreshModels(
  pool: Pick<HarnessPool, "all">,
  cachePath: string,
  clientFactory?: (apiKey?: string) => AnthropicModelsClient,
  now: Date = new Date(),
  codexRunner?: CommandRunner,
): Promise<RefreshRow[]> {
  const errors = new Map<string, string>();
  const cache = await runModelRefreshTick(pool, cachePath, clientFactory, now, codexRunner, (id, e) => errors.set(id, e.message));
  return pool.all().map((h) => ({
    harnessId: h.id,
    tool: h.tool,
    enabled: h.enabled,
    models: cache[h.id]?.models.length,
    fetchedAt: cache[h.id]?.fetchedAt,
    error: errors.get(h.id),
  }));
}

export function formatRefresh(rows: RefreshRow[], cachePath: string): string {
  const lines = [`models cache: ${cachePath}`, ""];
  const header = ["harness", "tool", "enabled", "models", "fetchedAt", "error"];
  const body = rows.map((r) => [r.harnessId, r.tool, r.enabled ? "yes" : "no", r.models === undefined ? "-" : String(r.models), r.fetchedAt ?? "-", r.error ?? ""]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  for (const row of [header, ...body]) lines.push(row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
  if (rows.length === 0) lines.push("(no harnesses found)");
  return lines.join("\n");
}

if (import.meta.main) {
  const cachePath = process.env.WISSEL_MODELS_CACHE_PATH ?? DEFAULT_MODELS_CACHE_PATH;
  const pool = await HarnessPool.autoload(process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml");
  const rows = await refreshModels(pool, cachePath);
  console.log(formatRefresh(rows, cachePath));
  process.exitCode = rows.some((r) => r.error) ? 1 : 0;
}
