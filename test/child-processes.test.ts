import { expect, test } from "bun:test";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { createShutdownHandler, isTracked, trackChild, trackedChildren } from "../src/executors/child-processes.ts";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

/** The pid runViaBun just spawned for `cmd`, found through the registry
 *  itself — runViaBun never hands its pid back to the caller. */
async function trackedPidFor(cmd: string[]): Promise<number> {
  let pid: number | undefined;
  await waitFor(() => {
    pid = trackedChildren().find((c) => c.cmd.join(" ") === cmd.join(" "))?.pid;
    return pid !== undefined;
  });
  return pid!;
}

test("runViaBun: a real subprocess is registered while it runs and unregistered once it exits", async () => {
  const cmd = ["sleep", "0.3"];
  const run = runViaBun(cmd, { cwd: "/tmp" });
  const pid = await trackedPidFor(cmd);
  expect(isTracked(pid)).toBe(true);
  expect(trackedChildren().find((c) => c.pid === pid)?.cwd).toBe("/tmp");

  const result = await run;
  expect(result.exitCode).toBe(0);
  expect(isTracked(pid)).toBe(false);
});

test("runViaBun: a subprocess that exits non-zero is unregistered too", async () => {
  const result = await runViaBun(["sh", "-c", "exit 3"], { cwd: "/tmp" });
  expect(result.exitCode).toBe(3);
  expect(trackedChildren().some((c) => c.cmd.join(" ") === "sh -c exit 3")).toBe(false);
});

test("shutdown hook: kills a real tracked sleep child, logs it, then exits 143 on SIGTERM", async () => {
  const cmd = ["sleep", "30.1"];
  const run = runViaBun(cmd, { cwd: "/tmp" });
  let settled = false;
  run.then(
    () => (settled = true),
    () => (settled = true),
  );
  const pid = await trackedPidFor(cmd);
  expect(pidAlive(pid)).toBe(true);

  const exits: number[] = [];
  const lines: string[] = [];
  const handler = createShutdownHandler({ exit: (code) => exits.push(code), graceMs: 2000, log: (l) => lines.push(l) });
  await handler("SIGTERM");

  expect(pidAlive(pid)).toBe(false);
  expect(isTracked(pid)).toBe(false);
  expect(exits).toEqual([143]);
  expect(lines.some((l) => l.includes(`agent process ${pid} (sleep)`) && l.includes("SIGTERM"))).toBe(true);
  // A run we killed ourselves never resolves back into its caller, so
  // nothing records a "failed" result for it on the way down.
  await Bun.sleep(50);
  expect(settled).toBe(false);
});

test("shutdown hook: a child that ignores SIGTERM is SIGKILLed after the grace period", async () => {
  // `trap '' TERM` makes the shell ignore SIGTERM; `exec` would lose the
  // trap, so the shell itself stays the tracked process.
  const proc = Bun.spawn(["sh", "-c", "trap '' TERM; while :; do sleep 0.05; done"], { stdout: "ignore", stderr: "ignore" });
  trackChild(proc, ["sh", "-c", "trap-loop"], "/tmp");
  await Bun.sleep(100); // let the trap install before we signal

  const lines: string[] = [];
  const handler = createShutdownHandler({ exit: () => {}, graceMs: 200, log: (l) => lines.push(l) });
  await handler("SIGINT");

  expect(pidAlive(proc.pid)).toBe(false);
  expect(lines.some((l) => l.includes(`agent process ${proc.pid}`) && l.includes("SIGKILL after 200ms"))).toBe(true);
});

test("shutdown hook: SIGINT exits 130, and a second signal while shutting down doesn't run a second pass", async () => {
  const exits: number[] = [];
  const lines: string[] = [];
  const handler = createShutdownHandler({ exit: (code) => exits.push(code), graceMs: 100, log: (l) => lines.push(l) });
  await Promise.all([handler("SIGINT"), handler("SIGTERM")]);
  expect(exits).toEqual([130]);
  expect(lines.filter((l) => l.includes("received")).length).toBe(1);
});
