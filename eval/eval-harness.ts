/**
 * The harness a paid eval or live check should run under: picked from
 * the same pool the server builds (HarnessPool.autoload validates each
 * entry, so a stale one like a macOS CLAUDE_CONFIG_DIR is dropped).
 *
 * Why: model precedence is task.model ?? harness.model ?? manifest
 * (src/core/model-resolution.ts). An executor called with no harness
 * runs the manifest model, not what production runs, and fails at $0
 * when the account can't use that model (credits_required on
 * claude-fable-5-1, 2026-10-17). Passing this harness to
 * `executor.run(task, agent, harness)` makes the eval run what the
 * server would.
 */
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { Harness, HarnessTool } from "../src/core/types.ts";

export interface EvalHarness {
  harness: Harness;
  release(): void;
}

export async function evalHarness(tool: HarnessTool = "claude-cli", preferred?: string[]): Promise<EvalHarness> {
  const pool = await HarnessPool.autoload();
  const harness = pool.acquire(tool, undefined, preferred);
  if (!harness) throw new Error(`no enabled ${tool} harness in harnesses.yaml; an eval can't run what production runs without one`);
  return { harness, release: () => pool.release(harness.id) };
}
