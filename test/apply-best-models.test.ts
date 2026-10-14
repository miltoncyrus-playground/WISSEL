import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Registry } from "../src/core/registry.ts";
import { bestModelFor, CLAUDE_CLI_STATIC_MODELS } from "../src/core/model-catalog.ts";
import type { AgentDef } from "../src/core/types.ts";
import { MANIFEST_PATH, planBestModels, renderPlan } from "../scripts/apply-best-models.ts";

const BEST = bestModelFor("claude-cli", CLAUDE_CLI_STATIC_MODELS)!;
const PRICING = {
  [BEST]: { input: 10, output: 50 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "odd-ratio": { input: 1, output: 2 },
};

function entry(id: string, executor: string, model: string, estUsdPerTask: number): AgentDef {
  return {
    id, name: id, kind: "agent", tier: "readonly", description: "", whenToUse: "", tags: [], executor,
    inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model, estUsdPerTask },
  };
}

const manifest = (agents: AgentDef[]) =>
  "agents:\n" + agents.map((a) => `  - id: ${a.id}\n    executor: ${a.executor}\n    costProfile: { model: ${a.costProfile.model}, estUsdPerTask: ${a.costProfile.estUsdPerTask.toFixed(2)} }\n`).join("\n");

test("the checked-in manifest is already on policy: a plan changes nothing", async () => {
  const registry = await Registry.load(MANIFEST_PATH);
  const text = readFileSync(MANIFEST_PATH, "utf8");
  const plan = planBestModels(registry.all(), text);
  expect(plan.rows.filter((r) => r.arithmetic !== "unchanged")).toEqual([]);
  expect(plan.text).toBe(text);
});

test("moves each entry to the best model and scales its cost by the input price ratio, rounded to the cent", () => {
  const agents = [entry("a", "readonly", "claude-sonnet-5-5", 0.03), entry("b", "handoff", "claude-opus-5-5", 0.35), entry("audio", "tts", "kokoro", 0)];
  const plan = planBestModels(agents, manifest(agents), PRICING, {});
  expect(plan.rows.map((r) => [r.id, r.oldModel, r.newModel, r.newUsd, r.arithmetic])).toEqual([
    ["a", "claude-sonnet-5-5", BEST, 0.15, "0.03 x 10/2"],
    ["b", "claude-opus-5-5", BEST, 0.88, "0.35 x 10/4"],
  ]);
  expect(plan.text).toContain(`  - id: a\n    executor: readonly\n    costProfile: { model: ${BEST}, estUsdPerTask: 0.15 }`);
  expect(plan.text).toContain(`  - id: b\n    executor: handoff\n    costProfile: { model: ${BEST}, estUsdPerTask: 0.88 }`);
  expect(plan.text).toContain("costProfile: { model: kokoro, estUsdPerTask: 0.00 }");
  expect([plan.oldTotal, plan.newTotal]).toEqual([0.38, 1.03]);
  expect(renderPlan(plan)).toContain("$0.38 -> $1.03, +$0.65 (x2.71)");
});

test("rewrites only the entry's own costProfile line, never a later entry's with the same model", () => {
  const agents = [entry("first", "readonly", BEST, 0.5), entry("second", "readonly", "claude-sonnet-5-5", 0.1)];
  // "first" is already on BEST; a sonnet line further down belongs to "second" only.
  const plan = planBestModels(agents, manifest(agents), PRICING, {});
  expect(plan.text).toContain(`  - id: first\n    executor: readonly\n    costProfile: { model: ${BEST}, estUsdPerTask: 0.50 }`);
  expect(plan.text).toContain(`  - id: second\n    executor: readonly\n    costProfile: { model: ${BEST}, estUsdPerTask: 0.50 }`);
});

test("keeps an approved downgrade on its approved model", () => {
  const agents = [entry("cheap", "readonly", "claude-sonnet-5-5", 0.1)];
  const plan = planBestModels(agents, manifest(agents), PRICING, {
    cheap: { model: "claude-sonnet-5-5", reason: "test", approvedBy: "Milton", date: "2026-10-13" },
  });
  expect(plan.rows[0]!.arithmetic).toBe("unchanged");
  expect(plan.text).toBe(manifest(agents));
});

test("refuses to guess: unknown price, a different output/input ratio, or a line it can't find", () => {
  const unpriced = [entry("x", "readonly", "claude-unknown", 0.1)];
  expect(() => planBestModels(unpriced, manifest(unpriced), PRICING, {})).toThrow("no price for claude-unknown");
  const odd = [entry("x", "readonly", "odd-ratio", 0.1)];
  expect(() => planBestModels(odd, manifest(odd), PRICING, {})).toThrow("different multiples of input");
  const missing = [entry("x", "readonly", "claude-sonnet-5-5", 0.1)];
  expect(() => planBestModels(missing, "agents:\n  - id: x\n", PRICING, {})).toThrow('x: no "costProfile');
});
