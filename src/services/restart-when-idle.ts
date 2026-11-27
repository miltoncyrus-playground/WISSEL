// Restart when idle (docs/SDD-coordinator.md §4.12, phase 1 card 5).
//
// The pilot timed seven restarts by hand around running cards. A pending
// restart instead stops new dispatches (the sweep, Run, and pipeline
// starts all ask `holding()`), waits until no card is running, then exits
// with RESTART_EXIT_CODE. Wissel can't restart itself: its supervisor does.
// That is systemd (`Restart=on-failure` restarts on any non-zero exit, and
// `RestartForceExitStatus=75` makes it explicit), or `bun run
// serve:supervised` (scripts/serve-supervised.sh) by hand. Phase 0 spike
// S3 confirmed both, and that `bun run` passes the code through. With no
// supervisor the route refuses: exiting would leave the board down.

/** EX_TEMPFAIL: "try again", what a supervisor treats as restart. */
export const RESTART_EXIT_CODE = 75;
export const RESTART_POLL_MS = 5000;

export type Supervisor = "systemd" | "script";

/** Who would start Wissel again after it exits 75, from the environment:
 *  systemd sets INVOCATION_ID for every unit it starts, and the wrapper
 *  script sets WISSEL_SUPERVISOR=script. */
export function detectSupervisor(env: Record<string, string | undefined>): Supervisor | undefined {
  if (env.WISSEL_SUPERVISOR === "script") return "script";
  if (env.WISSEL_SUPERVISOR === "systemd" || (env.INVOCATION_ID && env.INVOCATION_ID.trim())) return "systemd";
  return undefined;
}

export interface RestartState {
  pending: boolean;
  requestedAt?: string;
  /** Cards still running, which the restart waits for. */
  running: number;
  supervisor: Supervisor | null;
}

export interface RestartDeps {
  /** How many cards are running right now (status "running"). */
  runningCount: () => Promise<number>;
  supervisor: Supervisor | undefined;
  /** process.exit unless a test fakes it. */
  exit: (code: number) => void;
  now?: () => Date;
  log?: (line: string) => void;
  pollMs?: number;
}

export class RestartWhenIdle {
  private requestedAt: Date | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private exiting = false;

  constructor(private readonly deps: RestartDeps) {}

  /** Why new work must wait, or undefined when it may start. */
  holding(): string | undefined {
    return this.requestedAt ? `a restart is pending (asked at ${this.requestedAt.toISOString()}); new work starts after it, or cancel it with DELETE /admin/restart-when-idle` : undefined;
  }

  async state(): Promise<RestartState> {
    return {
      pending: this.requestedAt !== undefined,
      ...(this.requestedAt ? { requestedAt: this.requestedAt.toISOString() } : {}),
      running: await this.deps.runningCount(),
      supervisor: this.deps.supervisor ?? null,
    };
  }

  /** Asks for a restart once the board is idle. Refused with no
   *  supervisor. Asking again while one is pending changes nothing. */
  async request(): Promise<{ ok: true; state: RestartState } | { ok: false; error: string }> {
    if (!this.deps.supervisor) {
      return {
        ok: false,
        error: "nothing would start Wissel again: run it under systemd (Restart=on-failure, or RestartForceExitStatus=75) or with `bun run serve:supervised`. Not restarting.",
      };
    }
    if (!this.requestedAt) {
      this.requestedAt = (this.deps.now ?? (() => new Date()))();
      this.log(`restart when idle: asked; no new cards start, waiting for ${await this.deps.runningCount()} running`);
      this.timer = setInterval(() => void this.check(), this.deps.pollMs ?? RESTART_POLL_MS);
      await this.check();
    }
    return { ok: true, state: await this.state() };
  }

  /** Cancels a pending restart; new work may start again. */
  async cancel(): Promise<RestartState> {
    if (this.requestedAt) this.log("restart when idle: cancelled; new cards may start");
    this.requestedAt = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.state();
  }

  /** Exits once nothing is running. Called on a timer and after board
   *  events, so a finishing card triggers the restart promptly. */
  async check(): Promise<void> {
    if (!this.requestedAt || this.exiting) return;
    const running = await this.deps.runningCount();
    if (running > 0 || !this.requestedAt) return;
    this.exiting = true;
    if (this.timer) clearInterval(this.timer);
    this.log(`restart when idle: no card running; exiting with ${RESTART_EXIT_CODE} for the ${this.deps.supervisor} supervisor to start Wissel again`);
    this.deps.exit(RESTART_EXIT_CODE);
  }

  private log(line: string): void {
    (this.deps.log ?? console.log)(line);
  }
}
