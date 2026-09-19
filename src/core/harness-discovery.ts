import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";
import type { Harness } from "./types.ts";

interface ClaudeAuthStatusJson {
  loggedIn: boolean;
  email?: string;
}

export interface DiscoverHarnessesOptions {
  /** Injectable so tests never spawn a real `claude` process. */
  runner?: CommandRunner;
  /** Injectable so tests never scan the real $HOME. */
  homeDir?: string;
  /** Injectable so tests never read the real process environment —
   *  used by discoverApiKeyHarnesses and by validateHarness for an
   *  anthropic-api entry. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Finds every already-authenticated Claude account on this machine
 * without being told about it — the "auto detect if there are multiple
 * accounts available" half of harness setup, so `harnesses.yaml` only
 * has to name overrides, not every account.
 *
 * Heuristic: candidate config directories are `.claude*`-prefixed
 * directories directly under $HOME (the naming convention already in
 * use on this machine — `.claude`, `.claude-personal`, `.claude-work`,
 * ...). Every candidate is probed with `claude auth status --json` and
 * `CLAUDE_CONFIG_DIR` pointed at it; only ones that come back
 * `loggedIn: true` become a Harness. This is deliberate, not lazy: this
 * machine's own default `~/.claude` exists as a directory but has never
 * been logged into (confirmed while building this) — listing directory
 * names alone would have offered it as a fake, unusable harness.
 *
 * Never throws. A missing `claude` binary, an unreadable $HOME, or a
 * spawn failure for one candidate all degrade to "zero (or fewer)
 * discovered harnesses," never a startup failure — discovery augments
 * `harnesses.yaml`, it doesn't gate it.
 */
export async function discoverHarnesses(opts: DiscoverHarnessesOptions = {}): Promise<Harness[]> {
  const runner = opts.runner ?? runViaBun;
  const home = opts.homeDir ?? homedir();

  let candidateNames: string[];
  try {
    candidateNames = (await readdir(home, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const probed = await Promise.all(candidateNames.map((name) => probe(runner, home, name)));
  return probed.filter((h): h is Harness => h !== undefined);
}

const API_KEY_VAR = /^ANTHROPIC_API_KEY(_(.+))?$/;

/**
 * Finds every Anthropic API key already sitting in the environment —
 * `ANTHROPIC_API_KEY` itself, plus any `ANTHROPIC_API_KEY_<NAME>`
 * variant (mirrors claude-cli's multi-account `.claude-<name>`
 * convention, just via env vars instead of config directories).
 *
 * Unlike `discoverHarnesses`, this only checks that the variable is
 * *set*, not that the key actually works — there's no free way to
 * verify an API key the way `claude auth status` verifies a CLI
 * session (that's a local check; this would cost a real request, on
 * every startup, for every candidate key). A bad or revoked key still
 * surfaces honestly: ApiExecutor.run() reports the real API error the
 * first time it's actually used, same failure-visibility contract as
 * everything else here, just resolved at first use instead of at
 * startup.
 */
export function discoverApiKeyHarnesses(opts: DiscoverHarnessesOptions = {}): Harness[] {
  const env = opts.env ?? process.env;
  const harnesses: Harness[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    const match = API_KEY_VAR.exec(key);
    if (!match) continue;
    const name = match[2]; // undefined for bare ANTHROPIC_API_KEY
    const id = name ? `anthropic-api-${name.toLowerCase()}` : "anthropic-api";
    harnesses.push({
      id,
      tool: "anthropic-api",
      label: name ? `Anthropic API — ${name}` : "Anthropic API",
      enabled: true,
      apiKeyEnv: key,
    });
  }
  return harnesses;
}

/** Runs `claude auth status --json` under the given env overrides (merged
 *  onto the ambient environment by the runner — an empty/absent `env`
 *  checks whatever's already authenticated ambiently, not nothing).
 *  Never throws; a spawn failure, non-zero exit, or unparseable output
 *  all read as "not authenticated," never a crash.
 *
 *  Always forces ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN empty:
 *  `claude auth status` treats either as valid authentication on its
 *  own (`authMethod: "api_key"`), completely independent of
 *  CLAUDE_CONFIG_DIR — confirmed empirically while building this. Since
 *  the runner merges onto wissel's own ambient environment, and wissel
 *  itself now often holds an ANTHROPIC_API_KEY for the *separate*
 *  anthropic-api harness, every claude-cli probe would otherwise read
 *  as authenticated regardless of whether that CLAUDE_CONFIG_DIR has
 *  ever been logged into — silently defeating the whole point of this
 *  check the moment both harness kinds are configured at once. */
export async function checkClaudeCliAuth(
  runner: CommandRunner,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ authenticated: boolean; email?: string }> {
  try {
    const scoped = { ...env, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" };
    const result = await runner(["claude", "auth", "status", "--json"], { cwd, env: scoped });
    if (result.exitCode !== 0) return { authenticated: false };
    const status = JSON.parse(result.stdout) as ClaudeAuthStatusJson;
    return { authenticated: status.loggedIn === true, email: status.email };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Re-verifies a `harnesses.yaml` entry the same way an auto-discovered
 * one is verified, instead of trusting a checked-in file at face value.
 * A stale or wrong entry — a different machine's config path, a revoked
 * login, an env var that's simply unset here — comes back disabled
 * rather than silently claiming to be usable: visible on the board so
 * it's obvious why, not a confusing failure the first time something
 * tries to actually run under it. Already-disabled entries are returned
 * as-is — no reason to probe a harness nobody's going to pick anyway.
 *
 * claude-cli entries get the real `claude auth status` check (free,
 * local). anthropic-api entries get the presence check
 * `discoverApiKeyHarnesses` uses — same cost tradeoff as there: a
 * missing `apiKeyEnv` is exactly the bug this function exists to catch
 * (a key pointer that's real on one machine and not on this one), but
 * actually calling the API to verify the key works would spend money on
 * every startup. An entry with no `apiKeyEnv` at all trusts ambient
 * resolution, same as every other "no override configured" case here.
 */
export async function validateHarness(harness: Harness, opts: DiscoverHarnessesOptions = {}): Promise<Harness> {
  if (!harness.enabled) return harness;

  if (harness.tool === "anthropic-api") {
    if (!harness.apiKeyEnv) return harness;
    const env = opts.env ?? process.env;
    return env[harness.apiKeyEnv] ? harness : { ...harness, enabled: false };
  }

  const runner = opts.runner ?? runViaBun;
  const home = opts.homeDir ?? homedir();
  const { authenticated } = await checkClaudeCliAuth(runner, home, harness.env ?? {});
  return authenticated ? harness : { ...harness, enabled: false };
}

async function probe(runner: CommandRunner, home: string, dirName: string): Promise<Harness | undefined> {
  const configDir = join(home, dirName);
  const { authenticated, email } = await checkClaudeCliAuth(runner, home, { CLAUDE_CONFIG_DIR: configDir });
  if (!authenticated) return undefined;

  const id = dirName.replace(/^\./, "");
  return {
    id,
    tool: "claude-cli",
    label: email ? `Claude — ${email}` : id,
    enabled: true,
    env: { CLAUDE_CONFIG_DIR: configDir },
  };
}
