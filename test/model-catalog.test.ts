import { expect, test } from "bun:test";
import {
  CLAUDE_CLI_STATIC_MODELS,
  CODEX_CLI_STATIC_MODELS,
  MODEL_RANK,
  bestModelFor,
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

// --- MODEL_RANK / bestModelFor ---

test("every CLAUDE_CLI_STATIC_MODELS id is ranked for claude-cli and anthropic-api", () => {
  for (const id of CLAUDE_CLI_STATIC_MODELS) {
    expect(MODEL_RANK["claude-cli"]).toContain(id);
    expect(MODEL_RANK["anthropic-api"]).toContain(id);
  }
});

test("every CODEX_CLI_STATIC_MODELS id is ranked for codex-cli", () => {
  for (const id of CODEX_CLI_STATIC_MODELS) expect(MODEL_RANK["codex-cli"]).toContain(id);
});

test("MODEL_RANK has no duplicate ids per tool", () => {
  for (const [tool, ids] of Object.entries(MODEL_RANK)) {
    expect({ tool, size: new Set(ids).size }).toEqual({ tool, size: ids.length });
  }
});

test("MODEL_RANK codex-cli keeps `codex debug models` priority order", () => {
  expect(MODEL_RANK["codex-cli"]).toEqual(CODEX_CLI_STATIC_MODELS);
});

test("bestModelFor picks claude-fable-5-1 from the full claude-cli list", () => {
  expect(bestModelFor("claude-cli", CLAUDE_CLI_STATIC_MODELS)).toBe("claude-fable-5-1");
});

test("bestModelFor picks fable over opus regardless of input order", () => {
  expect(bestModelFor("claude-cli", ["claude-opus-5-5", "claude-fable-5"])).toBe("claude-fable-5");
});

test("bestModelFor skips unavailable ids: opus-5-5 when no fable is available", () => {
  const noFable = CLAUDE_CLI_STATIC_MODELS.filter((id) => !id.startsWith("claude-fable"));
  expect(bestModelFor("claude-cli", noFable)).toBe("claude-opus-5-5");
  expect(bestModelFor("anthropic-api", noFable)).toBe("claude-opus-5-5");
});

test("bestModelFor ranks haiku-5-5 over haiku-4-5", () => {
  expect(bestModelFor("claude-cli", ["claude-haiku-4-5", "claude-haiku-5-5"])).toBe("claude-haiku-5-5");
});

test("bestModelFor returns undefined for an empty list", () => {
  expect(bestModelFor("claude-cli", [])).toBeUndefined();
  expect(bestModelFor("codex-cli", [])).toBeUndefined();
});

test("bestModelFor returns undefined when nothing available is ranked", () => {
  expect(bestModelFor("claude-cli", ["claude-2", "gpt-6-astra"])).toBeUndefined();
});

test("bestModelFor ignores unknown ids mixed in with ranked ones", () => {
  expect(bestModelFor("anthropic-api", ["claude-zeta-9", "claude-sonnet-5", "claude-opus-4-1-20250805"])).toBe("claude-sonnet-5");
});

test("bestModelFor ranks per tool: claude ids don't count for codex-cli", () => {
  expect(bestModelFor("codex-cli", ["claude-fable-5-1", "gpt-5.5", "gpt-5.6-sol"])).toBe("gpt-5.6-sol");
});

test("bestModelFor does not modify its input", () => {
  const input = ["claude-sonnet-5", "claude-opus-5"];
  bestModelFor("claude-cli", input);
  expect(input).toEqual(["claude-sonnet-5", "claude-opus-5"]);
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
