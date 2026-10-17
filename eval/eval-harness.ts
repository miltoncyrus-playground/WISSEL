/**
 * The harness pool a paid eval or live check should run under: the same
 * one the server builds (HarnessPool.autoload validates each entry, so
 * a stale one like a macOS CLAUDE_CONFIG_DIR is dropped; HarnessPool.load
 * doesn't, and picks it).
 *
 * Why: model precedence is task.model ?? harness.model ?? manifest
 * (src/core/model-resolution.ts). An executor called with no harness
 * runs the manifest model, not what production runs, and fails at $0
 * when the account can't use that model (credits_required on
 * claude-fable-5-1, 2026-10-17). Passing this pool to an Orchestrator,
 * a PipelineRunnerContext or createApp, or this harness to
 * `executor.run(task, agent, harness)`, makes the eval run what the
 * server would.
 *
 * Which file: the server reads WISSEL_HARNESSES_PATH, else
 * ./harnesses.yaml in the main checkout it runs from. A human's
 * Manage harnesses decisions (enable, disable, the opus pin on
 * `claude`) are persisted to that file and may not be committed yet, so
 * an eval run from a card's worktree must not read the worktree's own
 * committed copy. serverHarnessesPath() resolves the main checkout
 * through git's common dir.
 *
 * test/eval-harness-wiring.test.ts fails any eval or live check that
 * builds an executor, Orchestrator, pipeline context or app without
 * going through this file (or HarnessPool.autoload).
 */
import { dirname, join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { Harness, HarnessTool } from "../src/core/types.ts";

const REPO_ROOT = join(import.meta.dir, "..");

/** The main checkout this repo copy belongs to: itself for the main
 *  checkout, the checkout a worktree was made from otherwise, itself
 *  when git can't say (not a git repo). */
export function mainCheckoutRoot(cwd: string = REPO_ROOT): string {
  const out = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, stdout: "pipe", stderr: "ignore" });
  if (out.exitCode !== 0) return cwd;
  return dirname(out.stdout.toString().trim());
}

/** The harnesses.yaml the running server reads. */
export function serverHarnessesPath(env: Record<string, string | undefined> = process.env, cwd: string = REPO_ROOT): string {
  return env.WISSEL_HARNESSES_PATH ?? join(mainCheckoutRoot(cwd), "harnesses.yaml");
}

let pool: Promise<HarnessPool> | undefined;

/** The server's harness pool, built once per process (autoload probes
 *  every account, and one pool keeps in-flight counts honest across an
 *  eval's runs, as the server's single pool does).
 *
 *  Throws, before anything is spent, when no `require` harness is
 *  enabled: an Orchestrator or pipeline run with a pool but no usable
 *  harness holds its cards forever, so the eval would hang instead of
 *  failing. Pass `require: null` when the eval checks for its own
 *  harness and skips (exit 2) on its own. */
export async function evalHarnessPool(require: HarnessTool | null = "claude-cli"): Promise<HarnessPool> {
  pool ??= HarnessPool.autoload(serverHarnessesPath());
  const p = await pool;
  if (require) requireEnabled(p, require, serverHarnessesPath());
  return p;
}

/** Throws unless `pool` has an enabled `tool` harness; the error lists
 *  what it did find, so "disabled: not authenticated here" is visible. */
export function requireEnabled(pool: HarnessPool, tool: HarnessTool, path: string): void {
  if (pool.all().some((h) => h.enabled && h.tool === tool)) return;
  const seen = pool.all().filter((h) => h.tool === tool).map((h) => `${h.id}${h.enabled ? "" : " (disabled)"}`);
  throw new Error(`no enabled ${tool} harness in ${path} [${seen.join(", ")}]; not run, nothing spent`);
}

export interface EvalHarness {
  harness: Harness;
  release(): void;
}

/** One harness from the server's pool for a direct `executor.run`.
 *  Pass the agent's own `harnesses` list as `preferred`, as the
 *  orchestrator does, so an agent pinned to an account runs there. */
export async function evalHarness(tool: HarnessTool = "claude-cli", preferred?: string[]): Promise<EvalHarness> {
  const p = await evalHarnessPool(tool);
  const harness = p.acquire(tool, undefined, preferred);
  if (!harness) {
    const which = preferred?.length ? `none of [${preferred.join(", ")}] is an enabled ${tool} harness under capacity` : `every enabled ${tool} harness is at capacity`;
    throw new Error(`${which} in ${serverHarnessesPath()}; not run, nothing spent`);
  }
  return { harness, release: () => p.release(harness.id) };
}
