import Anthropic from "@anthropic-ai/sdk";
import type { Harness } from "./types.ts";

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
 * (and to `MODEL_PRICING` in `anthropic-api.ts` if its per-token pricing
 * is known). There is no command that derives this list automatically —
 * it has to be edited by hand.
 */
export const CLAUDE_CLI_STATIC_MODELS: string[] = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

/**
 * Known `codex-cli` model ids — hand-maintained, not enumerable.
 * Verified live (per the parent card's shared design context): `codex
 * --help` has no list-models subcommand either. `gpt-5.1-codex` is the
 * only model id this project's research has turned up so far (see
 * docs/SDD-codex-cli-harness.md §6.1/§8.5 and
 * `src/executors/codex-cli.ts`'s own `MODEL_PRICING` comment) — it is
 * kept in this list as a *known candidate id*, not a *verified working*
 * one: it currently 404s against this project's own API key
 * ("The model gpt-5.1-codex does not exist or you do not have access to
 * it."). A model-selection UI surfacing this id is expected to let a
 * fail-loud error (docs/SDD-model-selection.md §5) surface if it's
 * picked and doesn't resolve for a given account, rather than this list
 * silently omitting the only id known to exist.
 *
 * How a human updates this: when OpenAI ships a new Codex CLI model, add
 * its id here. Verify it actually resolves via a real `codex exec -m
 * <id>` run before treating it as more than a "known candidate" the way
 * `gpt-5.1-codex` is today — there is no command that derives this list
 * automatically.
 */
export const CODEX_CLI_STATIC_MODELS: string[] = ["gpt-5.1-codex"];

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
