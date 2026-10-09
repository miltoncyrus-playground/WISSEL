import { expect, test } from "bun:test";
import { Registry } from "../src/core/registry.ts";
import { CLAUDE_CLI_STATIC_MODELS, CODEX_CLI_STATIC_MODELS } from "../src/core/model-catalog.ts";
import { MODEL_PRICING } from "../src/executors/anthropic-api.ts";

// Guards the hand-maintained model lists against drift from the real
// manifest. On 2026-10-06 the manifest moved agents to claude-opus-5-5 /
// claude-sonnet-5-5 while CLAUDE_CLI_STATIC_MODELS still lacked both, so
// once the models cache filled, POST /tasks would have rejected those
// models as unknown and API runs would have recorded no cost.

test("every claude-cli agent's manifest model is in CLAUDE_CLI_STATIC_MODELS", async () => {
  const registry = await Registry.load();
  const missing = registry
    .all()
    // executor: tts is the local Kokoro step (TtsExecutor), not an LLM.
    .filter((a) => a.executor !== "api" && a.executor !== "codex" && a.executor !== "tts")
    .filter((a) => !CLAUDE_CLI_STATIC_MODELS.includes(a.costProfile.model))
    .map((a) => `${a.id}: ${a.costProfile.model}`);
  expect(missing).toEqual([]);
});

test("every codex agent's manifest model is in CODEX_CLI_STATIC_MODELS", async () => {
  const registry = await Registry.load();
  const missing = registry
    .all()
    .filter((a) => a.executor === "codex")
    .filter((a) => !CODEX_CLI_STATIC_MODELS.includes(a.costProfile.model))
    .map((a) => `${a.id}: ${a.costProfile.model}`);
  expect(missing).toEqual([]);
});

test("every api agent's manifest model has a MODEL_PRICING entry, so its real cost is recorded", async () => {
  const registry = await Registry.load();
  const missing = registry
    .all()
    .filter((a) => a.executor === "api")
    .filter((a) => !MODEL_PRICING[a.costProfile.model])
    .map((a) => `${a.id}: ${a.costProfile.model}`);
  expect(missing).toEqual([]);
});

test("every model the claude-cli list offers has known pricing (one source of truth for current ids)", () => {
  expect(CLAUDE_CLI_STATIC_MODELS.filter((m) => !MODEL_PRICING[m])).toEqual([]);
});
