import { homedir } from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";
import type { Harness, HarnessTool } from "./types.ts";

/**
 * Known `claude-cli` model ids — hand-maintained, not enumerable.
 * Verified live (see docs/SDD-model-selection.md §3/§7 and the parent
 * card's shared design context): `claude --help`'s `--model` flag
 * describes aliases ("fable", "opus", "sonnet") and one example full
 * name ("claude-fable-5") but there is no list-models subcommand and no
 * flag that enumerates every valid id. This list mirrors
 * `src/executors/anthropic-api.ts`'s own `MODEL_PRICING` keys, the
 * existing checked-in source of truth for "current-generation model ids
 * this project knows about" — claude-cli runs under the same account/
 * model surface the raw API does.
 *
 * How a human updates this: when a new model ships, add its id here
 * and its verified price per million tokens to `MODEL_PRICING` in
 * `anthropic-api.ts` (`test/model-catalog-manifest.test.ts` fails if
 * either is missing). No command derives this list, but two scripts
 * check and publish it (docs/SDD-model-selection.md §7.1/§8):
 * - `bun run scripts/verify-claude-models.ts [--harness <id>] [--models a,b]`
 *   runs `claude -p --model <id>` per entry on one claude-cli harness
 *   (default `claude`) and prints ok/FAIL. Spends tokens; manual only.
 * - `bun run models:refresh` writes this list (and every other
 *   harness's) into `~/.wissel/models-cache.json` once, without
 *   `WISSEL_MODEL_REFRESH`.
 */
export const CLAUDE_CLI_STATIC_MODELS: string[] = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-haiku-5-5",
];

/**
 * Known `codex-cli` model ids — a snapshot, not the live source. The live
 * list comes from `queryCodexModels` below (`codex debug models`, codex-cli
 * 0.155.1+), which the refresh scheduler calls for every `codex-cli`
 * harness. This constant is the fallback/validation list for code that
 * needs codex ids without spawning codex (e.g.
 * test/model-catalog-manifest.test.ts).
 *
 * Snapshot: the `visibility: "list"` slugs, in ascending priority, that
 * `queryCodexModels` returned for the `codex` and `codex-personal`
 * harnesses (codex-cli 0.155.1, `CODEX_HOME=/home/mcyrus/.codex`) in a
 * live `bun run models:refresh` on 2026-10-13. `codex debug models` also
 * lists `gpt-5.4`, `codex-auto-review` and `gpt-daybreak-{blue,red}-latest`,
 * but not as `list`, so they're left out. The old entry `gpt-5.1-codex`
 * was dropped: it 404s for this account.
 *
 * How a human updates this: run `bun run models:refresh` and copy the
 * `codex` line it prints (the same list it writes to
 * ~/.wissel/models-cache.json), then update the date above.
 */
export const CODEX_CLI_STATIC_MODELS: string[] = [
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
];

/** Claude model ids, best first: capability tier (fable > opus > sonnet >
 *  haiku), then newest first within a tier. Shared by claude-cli and
 *  anthropic-api, which run on the same model surface. */
const CLAUDE_MODEL_RANK: string[] = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-5-5",
  "claude-haiku-4-5",
];

/**
 * Model ids per harness tool, best first. `bestModelFor` reads this so
 * "use the best available model" is a lookup, not a judgment call.
 *
 * codex-cli follows `codex debug models` priority order (the order of
 * `CODEX_CLI_STATIC_MODELS`). `test/model-catalog.test.ts` fails when an
 * id in either static list is missing here; see
 * docs/SDD-model-selection.md §7.2 for how to place a new model.
 */
export const MODEL_RANK: Record<HarnessTool, string[]> = {
  "claude-cli": CLAUDE_MODEL_RANK,
  "anthropic-api": CLAUDE_MODEL_RANK,
  "codex-cli": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

/**
 * The highest-ranked id in `available` for `tool`, per `MODEL_RANK`.
 * Ids `MODEL_RANK` doesn't know are ignored; returns undefined when no
 * ranked id is available. Pure: no I/O, `available` is not modified.
 */
export function bestModelFor(tool: HarnessTool, available: string[]): string | undefined {
  const have = new Set(available);
  return MODEL_RANK[tool].find((id) => have.has(id));
}

/**
 * The harness tool a manifest `executor` value runs on, or undefined for
 * the non-LLM executors (`tts` is Kokoro, `digest` reads the board).
 * `concierge` runs through ReadOnlyExecutor on the `claude` harness
 * (src/services/concierge.ts). An executor value this doesn't know also
 * returns undefined; `test/model-catalog-manifest.test.ts` fails on any
 * manifest executor that is neither mapped here nor listed as non-LLM.
 */
export function toolForExecutor(executor: string): HarnessTool | undefined {
  switch (executor) {
    case "readonly":
    case "handoff":
    case "concierge":
      return "claude-cli";
    case "api":
      return "anthropic-api";
    case "codex":
      return "codex-cli";
    default:
      return undefined;
  }
}

/** The checked-in model list for `tool`. anthropic-api shares the
 *  claude-cli list (same model surface, see CLAUDE_CLI_STATIC_MODELS). */
export function staticModelsFor(tool: HarnessTool): string[] {
  return tool === "codex-cli" ? CODEX_CLI_STATIC_MODELS : CLAUDE_CLI_STATIC_MODELS;
}

/** One approved exception to "every agent runs on the best model". */
export interface ApprovedDowngrade {
  model: string;
  reason: string;
  approvedBy: string;
  /** YYYY-MM-DD. */
  date: string;
}

/**
 * Agents and skills Milton has approved to run below the best model for
 * their tool, keyed by manifest id. Only Milton adds rows. Every other
 * LLM entry in agents/manifest.yaml must have `costProfile.model ===
 * bestModelFor(tool, staticModelsFor(tool))`;
 * `test/model-catalog-manifest.test.ts` fails otherwise. See
 * docs/SDD-model-selection.md §7.3.
 */
export const APPROVED_DOWNGRADES: Record<string, ApprovedDowngrade> = {};

/**
 * The model an agent's `costProfile.model` must be under the house rule:
 * its approved downgrade if it has one, otherwise the best model in its
 * tool's static list. Undefined for non-LLM executors.
 */
export function expectedModelFor(
  agent: { id: string; executor: string },
  downgrades: Record<string, ApprovedDowngrade> = APPROVED_DOWNGRADES,
): string | undefined {
  const tool = toolForExecutor(agent.executor);
  if (!tool) return undefined;
  return downgrades[agent.id]?.model ?? bestModelFor(tool, staticModelsFor(tool));
}

/** How long `queryCodexModels` waits for `codex debug models` by default. */
export const CODEX_MODELS_TIMEOUT_MS = 30_000;

/** One entry of `codex debug models`' `models` array. Only the fields this
 *  module reads; codex prints many more (display_name, supported_in_api,
 *  reasoning levels, ...). */
interface CodexDebugModel {
  slug: string;
  visibility: string;
  priority: number;
}

/**
 * Live model listing for the `codex-cli` harness tool via `codex debug
 * models`, which prints `{"models":[{slug, visibility, priority, ...}]}`.
 * Keeps entries with `visibility === "list"` (the ones codex's own model
 * picker shows; "hide" entries are internal) sorted by ascending
 * `priority` (1 = codex's default), and returns their slugs.
 *
 * Runs under `harness.env` (CODEX_HOME), so each codex harness lists the
 * models its own account can use. `runner` is injectable, defaulting to
 * `runViaBun`, same as the codex executors, so tests never spawn codex.
 *
 * Throws on a non-zero exit, unparseable JSON, a missing `models` array,
 * zero visible models, or no result within `timeoutMs` (default 30s; a
 * live call takes about a second). The timeout exists because the refresh
 * tick queries harnesses one after another, so a hung codex would stall
 * every harness after it. On timeout the child is left running (runViaBun
 * tracks it, so server shutdown still stops it); only the wait ends. Never
 * returns a fallback list: the caller (the refresh scheduler) catches per
 * harness and keeps the previous cache entry instead.
 */
export async function queryCodexModels(
  harness: Harness,
  runner: CommandRunner = runViaBun,
  timeoutMs: number = CODEX_MODELS_TIMEOUT_MS,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`harness "${harness.id}": \`codex debug models\` gave no result within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  const result = await Promise.race([
    runner(["codex", "debug", "models"], { cwd: homedir(), env: harness.env }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  if (result.exitCode !== 0) {
    throw new Error(`harness "${harness.id}": \`codex debug models\` exited ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`harness "${harness.id}": \`codex debug models\` printed invalid JSON: ${(e as Error).message}`);
  }
  const models = (parsed as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    throw new Error(`harness "${harness.id}": \`codex debug models\` output has no "models" array`);
  }
  const visible = (models as CodexDebugModel[])
    .filter((m) => m && m.visibility === "list" && typeof m.slug === "string" && m.slug.length > 0)
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));
  if (visible.length === 0) {
    throw new Error(`harness "${harness.id}": \`codex debug models\` listed no models with visibility "list"`);
  }
  return visible.map((m) => m.slug);
}

/** Minimal surface this module needs from an Anthropic client — mirrors
 *  `AnthropicMessagesClient` in `src/executors/anthropic-api.ts` exactly,
 *  same reasoning: injectable so tests never construct a real SDK client
 *  or make a real network call. */
export interface AnthropicModelsClient {
  models: {
    list(): Promise<{ data: { id: string }[] }>;
  };
}

/**
 * Live model listing for the `anthropic-api` harness tool, via the
 * already-installed `@anthropic-ai/sdk`'s `client.models.list()` (see
 * docs/SDD-model-selection.md §7). `clientFactory` mirrors
 * `ApiExecutorOptions.clientFactory` (`anthropic-api.ts:36-44`) exactly
 * — same default construction, same injectability — so this and
 * `ApiExecutor` share one client-construction convention instead of two.
 *
 * Throws (never returns a fallback list) when `harness.apiKeyEnv` names
 * an env var that isn't set, or when the SDK call itself fails — the
 * caller (the refresh scheduler) is responsible for catching this
 * per-harness so one broken harness's query never blocks another's.
 */
export async function queryAnthropicModels(
  harness: Harness,
  clientFactory: (apiKey?: string) => AnthropicModelsClient = (apiKey) => new Anthropic(apiKey ? { apiKey } : {}),
): Promise<string[]> {
  let apiKey: string | undefined;
  if (harness.apiKeyEnv) {
    apiKey = process.env[harness.apiKeyEnv];
    if (!apiKey) {
      throw new Error(`harness "${harness.id}" names env var ${harness.apiKeyEnv} for its API key, but it isn't set`);
    }
  }
  const client = clientFactory(apiKey);
  const page = await client.models.list();
  return page.data.map((m) => m.id);
}
