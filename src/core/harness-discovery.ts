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

/** Runs `claude auth status --json` under the given env overrides (merged
 *  onto the ambient environment by the runner — an empty/absent `env`
 *  checks whatever's already authenticated ambiently, not nothing).
 *  Never throws; a spawn failure, non-zero exit, or unparseable output
 *  all read as "not authenticated," never a crash. */
export async function checkClaudeCliAuth(
  runner: CommandRunner,
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ authenticated: boolean; email?: string }> {
  try {
    const result = await runner(["claude", "auth", "status", "--json"], { cwd, env });
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
 * login — comes back disabled rather than silently claiming to be
 * usable: visible on the board so it's obvious why, not a confusing
 * failure the first time something tries to actually run under it.
 * Already-disabled entries are returned as-is — no reason to spawn a
 * probe for a harness nobody's going to pick anyway.
 */
export async function validateHarness(harness: Harness, opts: DiscoverHarnessesOptions = {}): Promise<Harness> {
  if (!harness.enabled) return harness;
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
