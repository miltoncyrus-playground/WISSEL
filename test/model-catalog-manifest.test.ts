import { expect, test } from "bun:test";
import { Registry } from "../src/core/registry.ts";
import {
  APPROVED_DOWNGRADES,
  bestModelFor,
  CLAUDE_CLI_STATIC_MODELS,
  CODEX_CLI_STATIC_MODELS,
  expectedModelFor,
  staticModelsFor,
  toolForExecutor,
  type ApprovedDowngrade,
} from "../src/core/model-catalog.ts";
import type { AgentDef } from "../src/core/types.ts";
import { ApiExecutor, MODEL_PRICING } from "../src/executors/anthropic-api.ts";
import { CodexReadOnlyExecutor } from "../src/executors/codex-readonly.ts";
import { CodexWriteExecutor } from "../src/executors/codex-write.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import { WriteExecutor } from "../src/executors/write.ts";

// Re-exported so the downgrade table is reachable from the policy test
// that enforces it. The table itself lives in src/core/model-catalog.ts
// so scripts/apply-best-models.ts reads the same rows without importing
// a test file.
export { APPROVED_DOWNGRADES };

// Guards the hand-maintained model lists against drift from the real
// manifest. On 2026-10-06 the manifest moved agents to claude-opus-5-5 /
// claude-sonnet-5-5 while CLAUDE_CLI_STATIC_MODELS still lacked both, so
// once the models cache filled, POST /tasks would have rejected those
// models as unknown and API runs would have recorded no cost.

test("every claude-cli agent's manifest model is in CLAUDE_CLI_STATIC_MODELS", async () => {
  const registry = await Registry.load();
  const missing = registry
    .all()
    // executor: tts is the local Kokoro step (TtsExecutor) and executor:
    // digest the retrospective's collect step (DigestExecutor); neither is an LLM.
    .filter((a) => a.executor !== "api" && a.executor !== "codex" && a.executor !== "tts" && a.executor !== "digest")
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

// ---- best-model policy -------------------------------------------------
// House rule: always use the best available model unless Milton
// explicitly instructs otherwise. Every LLM entry in agents/manifest.yaml
// runs on bestModelFor(its tool), or on its row in APPROVED_DOWNGRADES
// (src/core/model-catalog.ts), which only Milton adds to. See
// docs/SDD-model-selection.md §7.3. When this fails because a better
// model was ranked: `bun run scripts/apply-best-models.ts --write`.

/** Executors that never call an LLM: tts is Kokoro, digest reads the board. */
const NON_LLM_EXECUTORS = ["tts", "digest"];

/** `id: has X, want Y` for every entry off the policy. */
function policyViolations(agents: AgentDef[], downgrades: Record<string, ApprovedDowngrade>): string[] {
  return agents.flatMap((a) => {
    const want = expectedModelFor(a, downgrades);
    return want && a.costProfile.model !== want ? [`${a.id} (${a.kind}, ${a.executor}): has ${a.costProfile.model}, want ${want}`] : [];
  });
}

/** Problems with the downgrade table itself: a row for an id that isn't
 *  an LLM entry, a model its tool can't run, a row that isn't a
 *  downgrade, or missing approval fields. */
function downgradeTableProblems(agents: AgentDef[], downgrades: Record<string, ApprovedDowngrade>): string[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  return Object.entries(downgrades).flatMap(([id, row]) => {
    const agent = byId.get(id);
    const tool = agent && toolForExecutor(agent.executor);
    if (!agent || !tool) return [`${id}: not an LLM entry in agents/manifest.yaml`];
    const problems: string[] = [];
    if (!staticModelsFor(tool).includes(row.model)) problems.push(`${id}: ${row.model} is not a ${tool} model`);
    if (row.model === bestModelFor(tool, staticModelsFor(tool))) problems.push(`${id}: ${row.model} is already the best ${tool} model, drop the row`);
    if (row.approvedBy !== "Milton") problems.push(`${id}: approvedBy must be Milton, got "${row.approvedBy}"`);
    if (!row.reason.trim()) problems.push(`${id}: reason is empty`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) problems.push(`${id}: date must be YYYY-MM-DD, got "${row.date}"`);
    return problems;
  });
}

test("every manifest executor is either mapped to a harness tool or listed as non-LLM", async () => {
  const registry = await Registry.load();
  const unknown = registry.all().filter((a) => !toolForExecutor(a.executor) && !NON_LLM_EXECUTORS.includes(a.executor));
  expect(unknown.map((a) => `${a.id}: executor ${a.executor}`)).toEqual([]);
});

test("toolForExecutor agrees with the harnessTool of the real executor that runs each agent", async () => {
  const registry = await Registry.load();
  const pool = [new ReadOnlyExecutor(), new WriteExecutor(), new ApiExecutor(), new CodexReadOnlyExecutor(), new CodexWriteExecutor()];
  const checked = registry.all().flatMap((a) => {
    const executor = pool.find((e) => e.canHandle(a));
    return executor ? [{ id: a.id, mapped: toolForExecutor(a.executor), real: executor.harnessTool }] : [];
  });
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.filter((c) => c.mapped !== c.real)).toEqual([]);
});

test("policy: every LLM agent and skill runs on the best model for its tool, unless Milton approved a downgrade", async () => {
  const registry = await Registry.load();
  expect(policyViolations(registry.all(), APPROVED_DOWNGRADES)).toEqual([]);
});

test("policy: the APPROVED_DOWNGRADES table only holds real, Milton-approved downgrades", async () => {
  const registry = await Registry.load();
  expect(downgradeTableProblems(registry.all(), APPROVED_DOWNGRADES)).toEqual([]);
});

test("policy checks catch an off-policy entry and honour an approved row", () => {
  const best = bestModelFor("claude-cli", CLAUDE_CLI_STATIC_MODELS)!;
  const entry = (id: string, executor: string, model: string): AgentDef => ({
    id, name: id, kind: "skill", tier: "readonly", description: "", whenToUse: "", tags: [], executor,
    inputs: [], outputs: [], trustLevel: "low", toolAccess: [], costProfile: { model, estUsdPerTask: 0 },
  });
  const agents = [
    entry("on-best", "readonly", best),
    entry("cheap", "api", "claude-haiku-4-5"),
    entry("codex-old", "codex", "gpt-5.5"),
    entry("audio", "tts", "kokoro"),
  ];
  expect(policyViolations(agents, {})).toEqual([
    `cheap (skill, api): has claude-haiku-4-5, want ${best}`,
    `codex-old (skill, codex): has gpt-5.5, want ${bestModelFor("codex-cli", CODEX_CLI_STATIC_MODELS)}`,
  ]);
  const approved = { cheap: { model: "claude-haiku-4-5", reason: "test", approvedBy: "Milton", date: "2026-10-13" } };
  expect(policyViolations(agents, approved)).toEqual([`codex-old (skill, codex): has gpt-5.5, want ${bestModelFor("codex-cli", CODEX_CLI_STATIC_MODELS)}`]);
  expect(downgradeTableProblems(agents, approved)).toEqual([]);
  expect(downgradeTableProblems(agents, {
    audio: { model: "kokoro", reason: "x", approvedBy: "Milton", date: "2026-10-13" },
    cheap: { model: "gpt-5.5", reason: "", approvedBy: "claude", date: "13/10/2026" },
    "on-best": { model: best, reason: "x", approvedBy: "Milton", date: "2026-10-13" },
  })).toEqual([
    "audio: not an LLM entry in agents/manifest.yaml",
    "cheap: gpt-5.5 is not a anthropic-api model",
    'cheap: approvedBy must be Milton, got "claude"',
    "cheap: reason is empty",
    'cheap: date must be YYYY-MM-DD, got "13/10/2026"',
    `on-best: ${best} is already the best claude-cli model, drop the row`,
  ]);
});
