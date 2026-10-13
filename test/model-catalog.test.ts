import { expect, test } from "bun:test";
import {
  CLAUDE_CLI_STATIC_MODELS,
  CODEX_CLI_STATIC_MODELS,
  queryAnthropicModels,
  queryCodexModels,
  type AnthropicModelsClient,
} from "../src/core/model-catalog.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { Harness } from "../src/core/types.ts";

// --- static lists: non-empty ---

test("CLAUDE_CLI_STATIC_MODELS is non-empty", () => {
  expect(CLAUDE_CLI_STATIC_MODELS.length).toBeGreaterThan(0);
  for (const id of CLAUDE_CLI_STATIC_MODELS) expect(typeof id).toBe("string");
});

test("CODEX_CLI_STATIC_MODELS is non-empty", () => {
  expect(CODEX_CLI_STATIC_MODELS.length).toBeGreaterThan(0);
  for (const id of CODEX_CLI_STATIC_MODELS) expect(typeof id).toBe("string");
});

// --- queryAnthropicModels: injected fake client only, never a real SDK client ---

function fakeClient(ids: string[]): (apiKey?: string) => AnthropicModelsClient {
  return () => ({ models: { list: async () => ({ data: ids.map((id) => ({ id })) }) } });
}

const harness: Harness = { id: "personal", tool: "anthropic-api", label: "Personal", enabled: true };

test("queryAnthropicModels returns the ids from the injected client's models.list()", async () => {
  const ids = await queryAnthropicModels(harness, fakeClient(["claude-sonnet-5", "claude-opus-5-5"]));
  expect(ids).toEqual(["claude-sonnet-5", "claude-opus-5-5"]);
});

test("queryAnthropicModels passes the harness's resolved apiKeyEnv value to the client factory", async () => {
  process.env.WISSEL_TEST_MODEL_CATALOG_KEY = "sk-ant-test-456";
  try {
    let seenKey: string | undefined;
    const clientFactory = (apiKey?: string): AnthropicModelsClient => {
      seenKey = apiKey;
      return { models: { list: async () => ({ data: [{ id: "claude-sonnet-5" }] }) } };
    };
    const keyedHarness: Harness = { ...harness, apiKeyEnv: "WISSEL_TEST_MODEL_CATALOG_KEY" };

    await queryAnthropicModels(keyedHarness, clientFactory);

    expect(seenKey).toBe("sk-ant-test-456");
  } finally {
    delete process.env.WISSEL_TEST_MODEL_CATALOG_KEY;
  }
});

test("queryAnthropicModels throws (not a silent empty list) when apiKeyEnv names an unset var", async () => {
  const brokenHarness: Harness = { ...harness, apiKeyEnv: "WISSEL_DEFINITELY_UNSET_MODEL_CATALOG_VAR" };

  await expect(queryAnthropicModels(brokenHarness, fakeClient(["claude-sonnet-5"]))).rejects.toThrow("WISSEL_DEFINITELY_UNSET_MODEL_CATALOG_VAR");
});

test("queryAnthropicModels propagates a client failure rather than swallowing it", async () => {
  const failingClient: (apiKey?: string) => AnthropicModelsClient = () => ({
    models: {
      list: async () => {
        throw new Error("network down");
      },
    },
  });

  await expect(queryAnthropicModels(harness, failingClient)).rejects.toThrow("network down");
});

// --- queryCodexModels: injected fake runner only, never a real codex spawn ---

const CODEX_DEBUG_MODELS_FIXTURE = await Bun.file(new URL("./fixtures/codex-debug-models.json", import.meta.url)).text();

type RunnerCall = { cmd: string[]; env?: Record<string, string> };

function fakeCodexRunner(stdout: string, exitCode = 0, stderr = ""): { runner: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const runner: CommandRunner = async (cmd, opts) => {
    calls.push({ cmd, env: opts.env });
    return { stdout, stderr, exitCode };
  };
  return { runner, calls };
}

const codexHarness: Harness = { id: "codex", tool: "codex-cli", label: "Codex", enabled: true, env: { CODEX_HOME: "/home/test/.codex" } };

test("queryCodexModels keeps only visibility:list entries, sorted by ascending priority", async () => {
  const { runner } = fakeCodexRunner(CODEX_DEBUG_MODELS_FIXTURE);
  expect(await queryCodexModels(codexHarness, runner)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"]);
});

test("queryCodexModels runs `codex debug models` with the harness's CODEX_HOME env", async () => {
  const { runner, calls } = fakeCodexRunner(CODEX_DEBUG_MODELS_FIXTURE);
  await queryCodexModels(codexHarness, runner);
  expect(calls).toEqual([{ cmd: ["codex", "debug", "models"], env: { CODEX_HOME: "/home/test/.codex" } }]);
});

test("queryCodexModels throws on a non-zero exit, with codex's stderr in the message", async () => {
  const { runner } = fakeCodexRunner("", 2, "error: unrecognized subcommand 'debug'");
  await expect(queryCodexModels(codexHarness, runner)).rejects.toThrow("unrecognized subcommand");
});

test("queryCodexModels throws on unparseable JSON", async () => {
  const { runner } = fakeCodexRunner("not json at all");
  await expect(queryCodexModels(codexHarness, runner)).rejects.toThrow("invalid JSON");
});

test("queryCodexModels throws when the output has no models array", async () => {
  const { runner } = fakeCodexRunner(JSON.stringify({ data: [] }));
  await expect(queryCodexModels(codexHarness, runner)).rejects.toThrow('no "models" array');
});

test("queryCodexModels throws on an empty list", async () => {
  const { runner } = fakeCodexRunner(JSON.stringify({ models: [] }));
  await expect(queryCodexModels(codexHarness, runner)).rejects.toThrow("no models");
});

test("queryCodexModels throws when every model is hidden, rather than returning []", async () => {
  const { runner } = fakeCodexRunner(JSON.stringify({ models: [{ slug: "x", visibility: "hide", priority: 1 }] }));
  await expect(queryCodexModels(codexHarness, runner)).rejects.toThrow("no models");
});

test("queryCodexModels throws when codex hangs past the timeout, instead of stalling the tick", async () => {
  const hung: CommandRunner = () => new Promise(() => {});
  await expect(queryCodexModels(codexHarness, hung, 20)).rejects.toThrow("no result within 20ms");
});

test("queryCodexModels returns normally when codex answers before the timeout", async () => {
  const { runner } = fakeCodexRunner(CODEX_DEBUG_MODELS_FIXTURE);
  expect(await queryCodexModels(codexHarness, runner, 1_000)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"]);
});
