import { expect, test } from "bun:test";

/**
 * Spawns the real CLI as a subprocess rather than importing cli.ts
 * directly — cli.ts runs its switch at module top-level (no exported
 * entrypoint to call in-process), and this is also the only way to
 * assert on stdout exactly as a human running `wissel --version` sees
 * it. Asserted loosely (prefix/suffix, not the exact SHA) to avoid
 * coupling this test to whatever commit happens to be checked out.
 */
async function runCli(...args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { stdout, exitCode };
}

test("wissel --version prints commit/branch/package shape", async () => {
  const { stdout, exitCode } = await runCli("--version");
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/^wissel /);
  expect(stdout).toContain("pkg 0.0.0");
});

test("wissel -v is the same as --version", async () => {
  const { stdout, exitCode } = await runCli("-v");
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/^wissel /);
  expect(stdout).toContain("pkg 0.0.0");
});

test("usage message mentions --version", async () => {
  const { stdout } = await runCli();
  expect(stdout).toContain("--version");
});
