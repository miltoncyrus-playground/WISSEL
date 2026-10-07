/**
 * Live registry of every subprocess `runViaBun` has spawned and not yet
 * seen exit — the only spawn path wissel's agents (claude-cli and
 * codex-cli alike) ever go through. Exists so a server shutdown can stop
 * its own children instead of leaving them running, reparented to PID 1,
 * in a worktree the next server start would then hand to a *second*
 * session — confirmed live 2026-10-07 (card 53dfecf8, see
 * docs/SDD-crash-recovery.md §10).
 *
 * Pure in-process state, same as HarnessPool's in-flight map: it only
 * ever knows about this process's own children. Whatever an earlier
 * process left behind is crash recovery's job (`findLiveAgentProcesses`
 * in src/core/crash-recovery.ts), not this module's.
 */

/** The slice of a Bun `Subprocess` this module needs — narrow on purpose
 *  so a test can hand in a real `Bun.spawn` result without any cast. */
export interface KillableProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface TrackedChild {
  pid: number;
  cmd: string[];
  cwd: string;
  proc: KillableProcess;
  /** Set the moment shutdown starts killing this child. `runViaBun`
   *  checks it so a run *we* killed never resolves back into its caller —
   *  see runViaBun's own comment on why. */
  killedForShutdown: boolean;
}

const children = new Map<number, TrackedChild>();

/** Registers `proc` until it exits. Removal hangs off `proc.exited`
 *  itself, not the caller's own control flow, so a caller that throws
 *  mid-read (a broken stdin pipe, say) can never leave a dead entry
 *  behind or drop a live one early. */
export function trackChild(proc: KillableProcess, cmd: string[], cwd: string): TrackedChild {
  const entry: TrackedChild = { pid: proc.pid, cmd, cwd, proc, killedForShutdown: false };
  children.set(proc.pid, entry);
  const untrack = () => {
    if (children.get(proc.pid) === entry) children.delete(proc.pid);
  };
  proc.exited.then(untrack, untrack);
  return entry;
}

export function trackedChildren(): TrackedChild[] {
  return [...children.values()];
}

export function isTracked(pid: number): boolean {
  return children.has(pid);
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 3000;

function exitedWithin(proc: KillableProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    proc.exited.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/**
 * SIGTERM every tracked child, wait up to `graceMs` for each to exit,
 * SIGKILL whatever's still alive, then wait for those too. All children
 * are signalled together, not one after another, so shutdown takes one
 * grace period total, not one per child. Logs exactly one line per
 * process. Never throws: a child that already exited between the
 * snapshot and the signal is just logged as such.
 */
export async function killTrackedChildren(opts: { graceMs?: number; log?: (line: string) => void } = {}): Promise<number> {
  const graceMs = opts.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const log = opts.log ?? ((line: string) => console.log(line));
  const snapshot = trackedChildren();

  await Promise.all(
    snapshot.map(async (child) => {
      child.killedForShutdown = true;
      const label = `agent process ${child.pid} (${child.cmd[0] ?? "?"}) in ${child.cwd}`;
      try {
        child.proc.kill("SIGTERM");
      } catch (e) {
        log(`shutdown: couldn't signal ${label}: ${(e as Error).message}`);
        return;
      }
      if (await exitedWithin(child.proc, graceMs)) {
        log(`shutdown: killed ${label} (SIGTERM)`);
        return;
      }
      try {
        child.proc.kill("SIGKILL");
      } catch {
        // exited in the gap between the timeout and this call — fine.
      }
      await child.proc.exited.catch(() => undefined);
      log(`shutdown: killed ${label} (SIGKILL after ${graceMs}ms)`);
    }),
  );
  return snapshot.length;
}

const SIGNAL_EXIT_CODES: Record<"SIGTERM" | "SIGINT", number> = { SIGTERM: 143, SIGINT: 130 };

/**
 * The server's SIGTERM/SIGINT handler, returned rather than installed so
 * a test can drive it with a fake `exit`. Kills every tracked child (see
 * killTrackedChildren), then exits with the conventional 128+signal
 * code. A second signal while the first is still waiting on children is
 * ignored rather than racing a second kill pass — the first one already
 * ends in SIGKILL, so there's nothing a second pass could add.
 */
export function createShutdownHandler(opts: { exit?: (code: number) => void; graceMs?: number; log?: (line: string) => void } = {}) {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  let inProgress: Promise<void> | undefined;

  return (signal: "SIGTERM" | "SIGINT"): Promise<void> => {
    if (inProgress) return inProgress;
    inProgress = (async () => {
      const count = trackedChildren().length;
      log(`shutdown: ${signal} received, stopping ${count} agent process(es)`);
      await killTrackedChildren({ graceMs: opts.graceMs, log });
      exit(SIGNAL_EXIT_CODES[signal]);
    })();
    return inProgress;
  };
}

/** Wires createShutdownHandler to the real process signals. Called once,
 *  from the server bootstrap only (src/api/server.ts's import.meta.main
 *  block) — never from createApp, which tests construct many times per
 *  process. */
export function installShutdownHandlers(opts: { graceMs?: number } = {}): void {
  const handler = createShutdownHandler(opts);
  process.on("SIGTERM", () => void handler("SIGTERM"));
  process.on("SIGINT", () => void handler("SIGINT"));
}
