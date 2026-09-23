import { expect, test } from "bun:test";
import { CLAUDE_CLI_STATIC_MODELS, CODEX_CLI_STATIC_MODELS, queryAnthropicModels, type AnthropicModelsClient } from "../src/core/model-catalog.ts";
import type { Harness } from "../src/core/types.ts";

// --- static lists: non-empty, no CLI way to enumerate these ---

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
