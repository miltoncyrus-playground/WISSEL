#!/usr/bin/env bun
/**
 * Periodic eval for the write-tier Bash sandbox
 * (docs/SDD-write-tier-sandbox.md): real implementer runs, with the real
 * manifest contract (verificationContract included), on small real tasks
 * in throwaway repos, sandbox on. Not run by `bun test`; invoke with
 * `bun run eval:sandbox-denials` before ship / nightly.
 *
 * What it measures: the raw permission_denials count of each run
 * (TaskResult.denials, the number the telemetry result event carries).
 * Before the sandbox, implementer runs had a median of 8.5 denial keys
 * (card 494f87d6's baseline, inflated by the old key split; see
 * `bun run denials:baseline` for the raw figure).
 *
 * Pass bar: every fixture run succeeds (ok, and its own `bun test`
 * passes afterwards in the worktree) with at most 1 raw denial. One is
 * allowed because a model may still try a git write or `bun -e` once,
 * which stays denied by design. A run with 2+ means the steering or the
 * sandbox regressed.
 *
 * Exits 0 on pass, 1 on fail, 2 when the sandbox can't start on this
 * host (nothing measured; the preflight's reasons are printed).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { probeSandbox } from "../src/executors/sandbox.ts";
import { tinyBunRepo } from "./sandbox-checks.ts";
import { evalHarness } from "./eval-harness.ts";

export const MAX_DENIALS_PER_RUN = 1;

const FIXTURES = [
  {
    name: "subtract",
    title: "Add subtract(a, b) to src/math.ts",
    body: "Add an exported `subtract(a: number, b: number): number` to src/math.ts, next to add, and a test for it in test/math.test.ts.",
  },
  {
    name: "clamp",
    title: "Add clamp(x, lo, hi) in src/clamp.ts",
    body: "Create src/clamp.ts exporting `clamp(x: number, lo: number, hi: number): number` that returns x limited to [lo, hi], and test/clamp.test.ts covering below, inside and above the range.",
  },
];

async function main(): Promise<number> {
  const status = await probeSandbox();
  if (status.state !== "on") {
    console.log(`eval:sandbox-denials: not run, sandbox ${status.state}:\n  ${status.problems.join("\n  ")}`);
    return 2;
  }
  const agent = (await Registry.load()).get("implementer")!;
  let failed = 0;
  for (const f of FIXTURES) {
    const repo = await tinyBunRepo(`eval-sandbox-${f.name}`);
    const home = await mkdtemp(join(tmpdir(), "wissel-eval-sandbox-home-"));
    const run = await evalHarness();
    try {
      const result = await new WriteExecutor({ homeDir: home, sandbox: status }).run(
        { id: `eval-sandbox-${f.name}-${process.pid}`, title: f.title, body: f.body, labels: ["code"], repo, status: "dispatched" },
        agent,
        run.harness,
      );
      const worktree = result.worktree?.path;
      const testsPass = worktree ? Bun.spawnSync(["bun", "test"], { cwd: worktree, stdout: "ignore", stderr: "ignore" }).exitCode === 0 : false;
      const denials = result.denials ?? Number.POSITIVE_INFINITY;
      const pass = result.ok && testsPass && denials <= MAX_DENIALS_PER_RUN;
      if (!pass) failed++;
      console.log(
        JSON.stringify({ fixture: f.name, pass, ok: result.ok, testsPass, sandbox: result.sandbox, denials: result.denials, keys: result.permissionDenials ?? [], cost: result.actualCost }),
      );
    } finally {
      run.release();
      await rm(repo, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
  console.log(`eval:sandbox-denials: ${FIXTURES.length - failed}/${FIXTURES.length} passed (bar: every run ok with <= ${MAX_DENIALS_PER_RUN} raw denial)`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
