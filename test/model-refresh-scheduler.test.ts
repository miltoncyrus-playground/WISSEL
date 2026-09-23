import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { CLAUDE_CLI_STATIC_MODELS, CODEX_CLI_STATIC_MODELS, type AnthropicModelsClient } from "../src/core/model-catalog.ts";
import { runModelRefreshTick, startModelRefreshScheduler, type ModelsCache } from "../src/core/model-refresh-scheduler.ts";

async function tmpCachePath(): Promise<{ dir: string; cachePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-model-refresh-scheduler-test-"));
  return { dir, cachePath: join(dir, "models-cache.json") };
}

function fakeAnthropicClient(ids: string[]): (apiKey?: string) => AnthropicModelsClient {
  return () => ({ models: { list: async () => ({ data: ids.map((id) => ({ id })) }) } });
}

// --- runModelRefreshTick: resolves every harness, writes the cache file ---

test("runModelRefreshTick: writes static lists for claude-cli/codex-cli and a live-queried list for anthropic-api, keyed by harness id", async () => {
  const { dir, cachePath } = await tmpCachePath();
  try {
    const harnesses = HarnessPool.from([
      { id: "claude-personal", tool: "claude-cli", label: "Claude personal", enabled: true },
      { id: "codex-personal", tool: "codex-cli", label: "Codex personal", enabled: true },
      { id: "api-key-1", tool: "anthropic-api", label: "API key", enabled: true },
    ]);

    const cache = await runModelRefreshTick(harnesses, cachePath, fakeAnthropicClient(["claude-sonnet-5", "claude-opus-5-5"]));

    expect(cache["claude-personal"]!.models).toEqual(CLAUDE_CLI_STATIC_MODELS);
    expect(cache["codex-personal"]!.models).toEqual(CODEX_CLI_STATIC_MODELS);
    expect(cache["api-key-1"]!.models).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
    for (const entry of Object.values(cache)) {
      expect(typeof entry.fetchedAt).toBe("string");
      expect(new Date(entry.fetchedAt).toISOString()).toBe(entry.fetchedAt);
    }

    const onDisk = JSON.parse(await readFile(cachePath, "utf8")) as ModelsCache;
    expect(onDisk).toEqual(cache);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runModelRefreshTick: one harness's query throwing never blocks another's, and keeps that harness's previous cache entry", async () => {
  const { dir, cachePath } = await tmpCachePath();
  try {
    const harnesses = HarnessPool.from([
      { id: "broken-api", tool: "anthropic-api", label: "Broken", enabled: true, apiKeyEnv: "WISSEL_DEFINITELY_UNSET_REFRESH_VAR" },
      { id: "claude-personal", tool: "claude-cli", label: "Claude personal", enabled: true },
    ]);

    // First tick: the broken harness fails (unset apiKeyEnv), but the
    // static-list harness still gets a real entry. `now` is injected
    // (two distinct instants) instead of relying on real wall-clock time
    // elapsing between two back-to-back calls, which routinely land in
    // the same millisecond and would make the fetchedAt-changed
    // assertion below flaky.
    const first = await runModelRefreshTick(harnesses, cachePath, fakeAnthropicClient(["claude-sonnet-5"]), new Date("2025-01-01T00:00:00.000Z"));
    expect(first["broken-api"]).toBeUndefined();
    expect(first["claude-personal"]!.models).toEqual(CLAUDE_CLI_STATIC_MODELS);

    // Seed a prior successful entry for the broken harness directly, then
    // tick again — the second failure must leave that entry untouched
    // (stale-but-present beats empty), not delete it.
    const seeded: ModelsCache = { ...first, "broken-api": { models: ["claude-sonnet-5"], fetchedAt: "2020-01-01T00:00:00.000Z" } };
    await Bun.write(cachePath, JSON.stringify(seeded));

    const second = await runModelRefreshTick(harnesses, cachePath, fakeAnthropicClient(["claude-sonnet-5"]), new Date("2025-01-02T00:00:00.000Z"));
    expect(second["broken-api"]).toEqual(seeded["broken-api"]);
    expect(second["claude-personal"]!.fetchedAt).not.toBe(first["claude-personal"]!.fetchedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runModelRefreshTick: an empty harness pool writes an empty cache object without throwing", async () => {
  const { dir, cachePath } = await tmpCachePath();
  try {
    const cache = await runModelRefreshTick(HarnessPool.from([]), cachePath);
    expect(cache).toEqual({});
    const onDisk = JSON.parse(await readFile(cachePath, "utf8"));
    expect(onDisk).toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- startModelRefreshScheduler: off by default, ticks immediately ---

test("startModelRefreshScheduler: ticks immediately and writes the cache without waiting for the interval", async () => {
  const { dir, cachePath } = await tmpCachePath();
  try {
    const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli" as const, label: "Claude personal", enabled: true }]);

    // intervalHours defaults to 24 — irrelevant here, since
    // startModelRefreshScheduler ticks immediately regardless of interval
    // (see its own doc comment); this test only waits on that first tick.
    const scheduler = startModelRefreshScheduler({ harnesses, cachePath });
    try {
      const deadline = Date.now() + 1000;
      let cache: ModelsCache | undefined;
      while (Date.now() < deadline) {
        try {
          cache = JSON.parse(await readFile(cachePath, "utf8")) as ModelsCache;
          if (cache["claude-personal"]) break;
        } catch {
          // cache file not written yet
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(cache?.["claude-personal"]?.models).toEqual(CLAUDE_CLI_STATIC_MODELS);
    } finally {
      scheduler.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startModelRefreshScheduler: stop() prevents any further ticks", async () => {
  const { dir, cachePath } = await tmpCachePath();
  try {
    const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli" as const, label: "Claude personal", enabled: true }]);
    // 1 second, so a second tick would fire fast if stop() didn't work.
    const scheduler = startModelRefreshScheduler({ harnesses, cachePath, intervalHours: 1 / 3600 });

    // Wait for the immediate first tick to actually land before stopping.
    const deadline = Date.now() + 1000;
    let afterFirstTick: string | undefined;
    while (Date.now() < deadline) {
      try {
        afterFirstTick = await readFile(cachePath, "utf8");
        if (afterFirstTick) break;
      } catch {
        // cache file not written yet
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(afterFirstTick).toBeDefined();
    scheduler.stop();

    const fetchedAtAfterStop = (JSON.parse(afterFirstTick!) as ModelsCache)["claude-personal"]!.fetchedAt;
    await new Promise((r) => setTimeout(r, 1300));
    const afterWait = JSON.parse(await readFile(cachePath, "utf8")) as ModelsCache;
    expect(afterWait["claude-personal"]!.fetchedAt).toBe(fetchedAtAfterStop);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
