import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessPool } from "./harness-pool.ts";
import type { Harness } from "./types.ts";
import { CLAUDE_CLI_STATIC_MODELS, CODEX_CLI_STATIC_MODELS, queryAnthropicModels, type AnthropicModelsClient } from "./model-catalog.ts";

/** Default frequency — "daily-refreshed," per docs/SDD-model-selection.md
 *  §8. Same 24h default as memory curation/`DEFAULT_MEMORY_INTERVAL_HOURS`. */
export const DEFAULT_MODEL_REFRESH_INTERVAL_HOURS = 24;

/** Default cache path — matches the existing `~/.wissel/board.sqlite` /
 *  `~/.wissel/telemetry.jsonl` convention (`src/api/server.ts`).
 *  Overridable per-call via `ModelRefreshSchedulerOptions.cachePath`;
 *  `WISSEL_MODELS_CACHE_PATH` is read once at the `src/api/server.ts`
 *  bootstrap entrypoint, the same place `WISSEL_DB_PATH`/
 *  `WISSEL_TELEMETRY_PATH`/`WISSEL_MEMORY_PATH` are — this module never
 *  reads `process.env` itself. */
export const DEFAULT_MODELS_CACHE_PATH = join(homedir(), ".wissel", "models-cache.json");

export interface ModelCacheEntry {
  models: string[];
  fetchedAt: string;
}

/** `{ [harnessId]: { models, fetchedAt } }` — keyed by Harness id, not by
 *  HarnessTool: two harnesses sharing a tool (e.g. two `anthropic-api`
 *  harnesses on different keys) can legitimately see different model
 *  lists, so each harness gets its own cache entry rather than one
 *  shared per-tool entry. */
export type ModelsCache = Record<string, ModelCacheEntry>;

async function readCache(path: string): Promise<ModelsCache> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as ModelsCache;
  } catch {
    return {};
  }
}

async function writeCache(path: string, cache: ModelsCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2));
}

/** Resolves one harness's known model list — the static list for
 *  claude-cli/codex-cli (§7 of the SDD: no CLI enumeration exists, so
 *  "refresh" just re-copies the current-in-code constant), or a live
 *  `client.models.list()` call for anthropic-api. Can throw (an unset
 *  `apiKeyEnv`, a failed API call) — callers are expected to catch this
 *  per-harness, per `runModelRefreshTick` below. */
async function resolveHarnessModels(harness: Harness, clientFactory?: (apiKey?: string) => AnthropicModelsClient): Promise<string[]> {
  switch (harness.tool) {
    case "claude-cli":
      return CLAUDE_CLI_STATIC_MODELS;
    case "codex-cli":
      return CODEX_CLI_STATIC_MODELS;
    case "anthropic-api":
      return queryAnthropicModels(harness, clientFactory);
  }
}

/**
 * One tick: resolves every harness's model list and writes the merged
 * result to the cache file. A harness whose resolution throws (bad
 * `apiKeyEnv`, a failed API call) keeps its *previous* cache entry
 * untouched instead of being cleared — stale-but-present beats empty
 * (docs/SDD-model-selection.md §8) — and never stops any other
 * harness's resolution from proceeding (each is its own try/catch).
 * Returns the full cache as written, so a caller/test can assert on it
 * directly instead of re-reading the file.
 *
 * `now` is injectable (default `new Date()`) — same convention as
 * `findArchivableRoots`/`isMemoryCurationDue` — so a test asserting
 * that two ticks produce different `fetchedAt` values can pass distinct
 * clock values instead of relying on real wall-clock elapsing between
 * two back-to-back calls, which routinely land in the same millisecond.
 */
export async function runModelRefreshTick(
  harnesses: Pick<HarnessPool, "all">,
  cachePath: string = DEFAULT_MODELS_CACHE_PATH,
  clientFactory?: (apiKey?: string) => AnthropicModelsClient,
  now: Date = new Date(),
): Promise<ModelsCache> {
  const cache = await readCache(cachePath);
  const fetchedAt = now.toISOString();

  for (const harness of harnesses.all()) {
    try {
      const models = await resolveHarnessModels(harness, clientFactory);
      cache[harness.id] = { models, fetchedAt };
    } catch (e) {
      console.error(`model-refresh-scheduler: failed to resolve models for harness "${harness.id}": ${(e as Error).message}`);
    }
  }

  await writeCache(cachePath, cache);
  return cache;
}

export interface ModelRefreshSchedulerOptions {
  harnesses: HarnessPool;
  /** Defaults to `DEFAULT_MODELS_CACHE_PATH`. */
  cachePath?: string;
  /** Defaults to `DEFAULT_MODEL_REFRESH_INTERVAL_HOURS` (24). */
  intervalHours?: number;
  /** Injectable so tests never construct a real Anthropic SDK client —
   *  passed straight through to `queryAnthropicModels`. */
  clientFactory?: (apiKey?: string) => AnthropicModelsClient;
}

export interface ModelRefreshScheduler {
  stop(): void;
}

/**
 * Wires `runModelRefreshTick` to an in-process `setInterval`, gated
 * behind `WISSEL_MODEL_REFRESH` (see `src/api/server.ts`) — off by
 * default, same pattern `WISSEL_AUTO_ARCHIVE`/`WISSEL_MEMORY_CURATION`
 * already use. Ticks once immediately (same "don't sit idle for a full
 * interval on a fresh install" reasoning `startArchiveScheduler`'s own
 * comment documents), then on the interval. A tick-level failure (e.g.
 * the cache file's directory isn't writable) is caught and logged here;
 * a single harness's own failure is already handled inside
 * `runModelRefreshTick` and never reaches this catch.
 */
export function startModelRefreshScheduler(opts: ModelRefreshSchedulerOptions): ModelRefreshScheduler {
  const intervalHours = opts.intervalHours ?? DEFAULT_MODEL_REFRESH_INTERVAL_HOURS;
  const tick = () =>
    void runModelRefreshTick(opts.harnesses, opts.cachePath, opts.clientFactory).catch((e) =>
      console.error(`model-refresh-scheduler: tick failed: ${(e as Error).message}`),
    );
  tick();
  const handle = setInterval(tick, intervalHours * 60 * 60 * 1000);
  return { stop: () => clearInterval(handle) };
}
