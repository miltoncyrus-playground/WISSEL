import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { CLAUDE_CLI_STATIC_MODELS } from "../src/core/model-catalog.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { formatRefresh, refreshModels } from "../scripts/models-refresh.ts";

// `bun run models:refresh`: one runModelRefreshTick, reported per harness.

let dir: string;
let cachePath: string;
const now = new Date("2026-10-13T08:00:00Z");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wissel-models-refresh-"));
  cachePath = join(dir, "models-cache.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const pool = HarnessPool.from([
  { id: "claude", tool: "claude-cli", label: "Claude", enabled: true, env: { CLAUDE_CONFIG_DIR: "/home/x/.claude" } },
  { id: "codex", tool: "codex-cli", label: "Codex", enabled: true },
  { id: "anthropic-api", tool: "anthropic-api", label: "API", enabled: true },
]);
const listing = (ids: string[]) => () => ({ models: { list: async () => ({ data: ids.map((id) => ({ id })) }) } });

const CODEX_DEBUG_MODELS_FIXTURE = await Bun.file(new URL("./fixtures/codex-debug-models.json", import.meta.url)).text();
/** Answers `codex debug models` with the fixture; never spawns codex. */
const fakeCodexRunner: CommandRunner = async () => ({ stdout: CODEX_DEBUG_MODELS_FIXTURE, stderr: "", exitCode: 0 });

test("fills the cache for every harness and reports count and fetchedAt", async () => {
  const rows = await refreshModels(pool, cachePath, listing(["claude-opus-5-5", "claude-haiku-5-5"]), now, fakeCodexRunner);

  expect(rows).toEqual([
    { harnessId: "claude", tool: "claude-cli", enabled: true, models: CLAUDE_CLI_STATIC_MODELS.length, fetchedAt: now.toISOString(), error: undefined },
    { harnessId: "codex", tool: "codex-cli", enabled: true, models: 4, fetchedAt: now.toISOString(), error: undefined },
    { harnessId: "anthropic-api", tool: "anthropic-api", enabled: true, models: 2, fetchedAt: now.toISOString(), error: undefined },
  ]);
  const written = JSON.parse(await readFile(cachePath, "utf8"));
  expect(written["anthropic-api"].models).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  expect(written.claude.models).toEqual(CLAUDE_CLI_STATIC_MODELS);
});

test("a failing harness reports its error and keeps its previous cache entry", async () => {
  await writeFile(cachePath, JSON.stringify({ "anthropic-api": { models: ["old-model"], fetchedAt: "2026-10-01T00:00:00.000Z" } }));
  const failing = () => ({
    models: {
      list: async (): Promise<{ data: { id: string }[] }> => {
        throw new Error("401 invalid x-api-key");
      },
    },
  });

  const rows = await refreshModels(pool, cachePath, failing, now, fakeCodexRunner);
  const api = rows.find((r) => r.harnessId === "anthropic-api")!;

  expect(api).toEqual({ harnessId: "anthropic-api", tool: "anthropic-api", enabled: true, models: 1, fetchedAt: "2026-10-01T00:00:00.000Z", error: "401 invalid x-api-key" });
  expect(rows.find((r) => r.harnessId === "claude")!.error).toBeUndefined();
});

test("a failing harness with no previous entry shows no count", async () => {
  const failing = () => ({
    models: {
      list: async (): Promise<{ data: { id: string }[] }> => {
        throw new Error("boom");
      },
    },
  });
  const rows = await refreshModels(pool, cachePath, failing, now, fakeCodexRunner);
  expect(rows.find((r) => r.harnessId === "anthropic-api")).toMatchObject({ models: undefined, fetchedAt: undefined, error: "boom" });
});

test("a failing `codex debug models` reports on the codex row only", async () => {
  const failingCodex: CommandRunner = async () => ({ stdout: "", stderr: "codex: not logged in", exitCode: 1 });
  const rows = await refreshModels(pool, cachePath, listing(["claude-opus-5-5"]), now, failingCodex);

  expect(rows.find((r) => r.harnessId === "codex")).toMatchObject({ models: undefined, fetchedAt: undefined });
  expect(rows.find((r) => r.harnessId === "codex")!.error).toContain("codex: not logged in");
  expect(rows.find((r) => r.harnessId === "anthropic-api")).toMatchObject({ models: 1, error: undefined });
});

test("formatRefresh prints one aligned row per harness, errors last", () => {
  const out = formatRefresh(
    [
      { harnessId: "claude", tool: "claude-cli", enabled: true, models: 12, fetchedAt: "2026-10-13T08:00:00.000Z" },
      { harnessId: "anthropic-api", tool: "anthropic-api", enabled: false, error: "boom" },
    ],
    "/tmp/cache.json",
  );
  const lines = out.split("\n");
  expect(lines[0]).toBe("models cache: /tmp/cache.json");
  expect(lines[2]).toMatch(/^harness\s+tool\s+enabled\s+models\s+fetchedAt\s+error$/);
  expect(lines[3]).toMatch(/^claude\s+claude-cli\s+yes\s+12\s+2026-10-13T08:00:00\.000Z$/);
  expect(lines[4]).toMatch(/^anthropic-api\s+anthropic-api\s+no\s+-\s+-\s+boom$/);
});

test("formatRefresh says so when there are no harnesses", () => {
  expect(formatRefresh([], "/tmp/c.json")).toContain("(no harnesses found)");
});
