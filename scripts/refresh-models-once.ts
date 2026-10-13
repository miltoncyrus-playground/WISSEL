#!/usr/bin/env bun
/**
 * Runs one model-refresh tick against the real harness pool, the same pool
 * the server builds at startup (`HarnessPool.autoload` over
 * `WISSEL_HARNESSES_PATH`, default `harnesses.yaml`), and writes the result
 * to the models cache (`WISSEL_MODELS_CACHE_PATH`, default
 * `~/.wissel/models-cache.json`). Use it to refresh model lists without
 * waiting for the scheduler's 24h interval, or to check that a harness's
 * live discovery (e.g. `codex debug models`) works.
 *
 * A harness whose lookup fails keeps its previous cache entry and the error
 * goes to stderr (runModelRefreshTick's per-harness try/catch). Prints each
 * harness id with its model list and fetchedAt.
 *
 *   bun run models:refresh
 */
import { HarnessPool } from "../src/core/harness-pool.ts";
import { DEFAULT_MODELS_CACHE_PATH, runModelRefreshTick } from "../src/core/model-refresh-scheduler.ts";

const harnessesPath = process.env.WISSEL_HARNESSES_PATH ?? "harnesses.yaml";
const cachePath = process.env.WISSEL_MODELS_CACHE_PATH ?? DEFAULT_MODELS_CACHE_PATH;

const harnesses = await HarnessPool.autoload(harnessesPath);
const cache = await runModelRefreshTick(harnesses, cachePath);

console.log(`models cache: ${cachePath}`);
for (const h of harnesses.all()) {
  const entry = cache[h.id];
  console.log(`${h.id} (${h.tool}): ${entry ? `${entry.fetchedAt} ${JSON.stringify(entry.models)}` : "no entry"}`);
}
