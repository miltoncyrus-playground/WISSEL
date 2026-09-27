import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicMessagesClient } from "../executors/anthropic-api.ts";

/** The one genuinely latent-space piece of the project summary box —
 *  everything else (branch, dirty state, latest commit, in
 *  project-status.ts) is a deterministic git lookup. Explaining what a
 *  codebase IS, in plain language, is real judgment/summarization work,
 *  so it's the only part that goes through an LLM call at all — see
 *  CLAUDE.md's latent-vs-deterministic split. */

const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README", "README.rst", "README.txt"];
// Generous enough for a real README's intro section without sending an
// entire large doc through — this is a one-paragraph summary, not a deep
// analysis, so it doesn't need the whole file.
const MAX_README_CHARS = 6000;

/** Reads whatever real signal is on disk about what this project is,
 *  cheapest and most direct first: a README, then package.json's own
 *  name/description, then (if neither exists) just the top-level
 *  directory listing so the model has something to reason from rather
 *  than nothing. Never invents content — every branch here is reading an
 *  actual file. */
function gatherGroundingText(path: string): string {
  for (const name of README_CANDIDATES) {
    const candidate = join(path, name);
    if (!existsSync(candidate)) continue;
    try {
      const text = readFileSync(candidate, "utf8");
      return `README (${name}):\n${text.slice(0, MAX_README_CHARS)}`;
    } catch {
      // unreadable (permissions, race) — try the next candidate
    }
  }

  const pkgPath = join(path, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: unknown; description?: unknown };
      const bits = [
        typeof pkg.name === "string" ? `name: ${pkg.name}` : null,
        typeof pkg.description === "string" ? `description: ${pkg.description}` : null,
      ].filter((b): b is string => b !== null);
      if (bits.length) return `package.json:\n${bits.join("\n")}`;
    } catch {
      // malformed package.json — fall through to the directory listing
    }
  }

  try {
    const entries = readdirSync(path)
      .filter((e) => !e.startsWith("."))
      .slice(0, 40);
    return `No README or package.json description found. Top-level entries:\n${entries.join("\n")}`;
  } catch {
    return "No README, package.json description, or readable directory listing found.";
  }
}

export interface ProjectEli5Options {
  /** Same injectable-client convention as ApiExecutor
   *  (src/executors/anthropic-api.ts) — defaults to a real Anthropic
   *  client using ambient credentials, overridable so tests never spend
   *  a real token. */
  clientFactory?: (apiKey?: string) => AnthropicMessagesClient;
  /** Defaults to claude-sonnet-5, matching every agent in
   *  agents/manifest.yaml's own costProfile — no reason for this one
   *  call to pick a different default model than everything else in
   *  this project already uses. */
  model?: string;
}

/**
 * Generates a single ELI5 paragraph for a registered project, grounded
 * in whatever real file this repo actually has (never a guess dressed up
 * as one). Callers are expected to cache the result (see
 * ProjectStore.setEli5) rather than call this on every render — an LLM
 * call per page load would be both slow and a real, avoidable cost.
 */
export async function generateProjectEli5(path: string, name: string, opts: ProjectEli5Options = {}): Promise<{ eli5: string } | { error: string }> {
  const grounding = gatherGroundingText(path);
  const clientFactory = opts.clientFactory ?? ((apiKey?: string) => new Anthropic(apiKey ? { apiKey } : {}));
  const model = opts.model ?? "claude-sonnet-5";
  const client = clientFactory();

  const prompt = [
    `Below is real content read directly from a software project's repository named "${name}".`,
    "Write exactly one paragraph, in plain language, explaining what this project does — as if to someone with no technical background (ELI5).",
    "Base it only on the text given below; never invent a feature or purpose the text doesn't actually evidence.",
    "If the content gives no real signal about the project's purpose, say plainly that not enough information is available yet, instead of guessing.",
    "Output ONLY the paragraph itself — no heading, no preamble, no markdown formatting, no code fence.",
    "",
    "---",
    grounding,
    "---",
  ].join("\n");

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    return { error: e instanceof Anthropic.APIError ? `API error (${e.status}): ${e.message}` : e instanceof Error ? e.message : String(e) };
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if (!text) return { error: "empty response from the model" };
  return { eli5: text };
}
