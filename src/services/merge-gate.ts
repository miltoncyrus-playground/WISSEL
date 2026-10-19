import { trackChild } from "../executors/child-processes.ts";

/**
 * The merge gate: a repo's own check commands (typecheck, tests), run in
 * the task's worktree on the exact commit about to land, before
 * mergeTaskWorktree lets it reach the user's checkout. Configured per
 * project (Project.mergeGate); no gate configured means the merge lands
 * as it always did, recorded as `gate: "none"`. Deterministic: argv
 * arrays and exit codes, no LLM anywhere. See
 * docs/SDD-worktree-isolation.md §7.
 */

/** A project's gate: each command an argv array, run in order, first
 *  failure stops. `timeoutMs` applies to each command; default 10 min. */
export interface MergeGateConfig {
  commands: string[][];
  timeoutMs?: number;
}

/** Looks up the gate for a repo path (the project registered at that
 *  path); undefined means none configured. */
export type MergeGateResolver = (repo: string) => Promise<MergeGateConfig | undefined>;

export const DEFAULT_GATE_TIMEOUT_MS = 10 * 60 * 1000;
/** How much of a failing command's output goes back to the implementer. */
export const GATE_OUTPUT_TAIL_LINES = 200;

/** The gate wissel seeds for its own checkout (projects.ts). */
export const WISSEL_MERGE_GATE: string[][] = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "test"],
];

export interface GateCommandResult {
  /** Null when the command was killed (timeout). */
  exitCode: number | null;
  /** stdout and stderr, interleaved as written. */
  output: string;
  timedOut: boolean;
}

/** Injectable so tests can fake a gate without spawning anything. */
export type GateCommandRunner = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<GateCommandResult>;

export interface GateRun {
  argv: string[];
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface GateReport {
  /** `none`: no gate configured. `skipped`: nothing new to land, so
   *  nothing to check. */
  status: "none" | "passed" | "failed" | "skipped";
  runs: GateRun[];
  durationMs: number;
  /** On failure: the failing command and the tail of its output, the
   *  text a pushback attempt is given. */
  feedback?: string;
}

/**
 * Spawns one gate command. stderr is folded into stdout by a `sh` exec
 * wrapper (`exec "$@" 2>&1`), so the output tail reads the way a
 * terminal would show it. Detached into its own process group, so a
 * timeout kills the command and everything it started (a test runner's
 * workers) instead of leaving them holding the output pipe open.
 * Tracked like every agent subprocess (child-processes.ts), so a server
 * shutdown stops a gate mid-run; that run never resolves, and nothing
 * lands.
 */
export const runGateCommand: GateCommandRunner = async (argv, { cwd, timeoutMs }) => {
  const cmd = ["sh", "-c", 'exec "$@" 2>&1', "sh", ...argv];
  // The server's own WISSEL_* settings (its board, telemetry, ports,
  // orchestrator switch) are not the gate's business: a repo's tests
  // run the way they would in a fresh terminal.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("WISSEL_"))) as Record<string, string>;
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true } as Parameters<typeof Bun.spawn>[1]);
  const tracked = trackChild(proc, argv, cwd);

  let timedOut = false;
  const killGroup = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, timeoutMs);

  const chunks: string[] = [];
  const decoder = new TextDecoder();
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  })().catch(() => undefined);

  const exitCode = await proc.exited;
  clearTimeout(timer);
  // A grandchild that outlived its parent can still hold the pipe; the
  // group kill above covers a timeout, this covers a clean exit.
  await Promise.race([reading, Bun.sleep(2000)]);
  reader.cancel().catch(() => undefined);

  if (tracked.killedForShutdown) return new Promise<never>(() => {});
  return { exitCode: timedOut ? null : exitCode, output: chunks.join(""), timedOut };
};

/** The last `lines` lines of `text`, without a trailing blank. */
export function tailLines(text: string, lines = GATE_OUTPUT_TAIL_LINES): string {
  const all = text.replace(/\s+$/, "").split("\n");
  return all.slice(-lines).join("\n");
}

/** An argv as a shell would show it, for feedback text. */
export function shellWords(argv: string[]): string {
  return argv.map((a) => (/^[\w./:=@%+-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

/** Runs `gate`'s commands in order in `cwd`; stops at the first failure. */
export async function runMergeGate(gate: MergeGateConfig | undefined, cwd: string, runner: GateCommandRunner = runGateCommand): Promise<GateReport> {
  if (!gate || gate.commands.length === 0) return { status: "none", runs: [], durationMs: 0 };
  const timeoutMs = gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const runs: GateRun[] = [];
  const start = performance.now();
  for (const argv of gate.commands) {
    const t0 = performance.now();
    const res = await runner(argv, { cwd, timeoutMs });
    const run: GateRun = { argv, exitCode: res.exitCode, durationMs: Math.round(performance.now() - t0), timedOut: res.timedOut };
    runs.push(run);
    if (res.timedOut || res.exitCode !== 0) {
      const why = res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exited ${res.exitCode}`;
      const tail = tailLines(res.output);
      const feedback =
        `Merge gate failed: \`${shellWords(argv)}\` ${why} on the merge of your branch with the repo's current HEAD. ` +
        `The work did not land. Fix it so the gate passes.\n\n` +
        `Last ${GATE_OUTPUT_TAIL_LINES} lines of its output:\n\`\`\`\n${tail}\n\`\`\``;
      return { status: "failed", runs, durationMs: Math.round(performance.now() - start), feedback };
    }
  }
  return { status: "passed", runs, durationMs: Math.round(performance.now() - start) };
}

/** Validates a gate as it arrives from the API or the DB: a non-empty
 *  list of non-empty string arrays, and a positive timeout if given. */
export function validateMergeGate(commands: unknown, timeoutMs: unknown): { ok: true; gate: MergeGateConfig } | { ok: false; error: string } {
  if (!Array.isArray(commands)) return { ok: false, error: "mergeGate must be a list of commands, each a list of strings (argv)" };
  for (const c of commands) {
    if (!Array.isArray(c) || c.length === 0 || !c.every((a) => typeof a === "string" && a !== "")) {
      return { ok: false, error: `each mergeGate command must be a non-empty list of non-empty strings, got ${JSON.stringify(c)}` };
    }
  }
  if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    return { ok: false, error: "mergeGateTimeoutMs must be a positive whole number of milliseconds" };
  }
  return { ok: true, gate: { commands: commands as string[][], ...(typeof timeoutMs === "number" ? { timeoutMs } : {}) } };
}
