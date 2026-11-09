import type { EventEmitter } from "node:events";

/** The exit code the start script or systemd unit restarts on
 *  (docs/SDD-coordinator.md §4.12). Any other code is a crash or a
 *  signal; this one means "start me again, I asked for it". */
export const RESTART_EXIT_CODE = 75;

export interface RestartWhenIdleOptions {
  /** WISSEL_SUPERVISED=1: something restarts the process on exit code
   *  75. Without it a restart request is refused — exiting with nothing
   *  to start wissel again leaves the team without it (§10). */
  supervised: boolean;
  /** Defaults to process.exit; tests pass a recorder. */
  exit?: (code: number) => void;
  /** Stops the sweep (and a human's Run) from starting new cards, and
   *  lets it again — Orchestrator.holdDispatch/releaseDispatch. */
  holdDispatch: (reason: string) => void;
  releaseDispatch: () => void;
  /** Ids of the cards this process is still running. Empty means idle. */
  running: () => Promise<string[]>;
  /** The board's event stream: a card finishing emits on it, so every
   *  event is a reason to look again. */
  events?: Pick<EventEmitter, "on" | "off">;
  /** Fallback poll in case an event is missed. Default 5 s; 0 turns it off. */
  pollMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface RestartWhenIdleStatus {
  supervised: boolean;
  pending: boolean;
  requestedAt?: string;
  running: string[];
  exitCode: number;
}

const HOLD_REASON = "restart pending: no new cards start until wissel restarts (DELETE /admin/restart-when-idle cancels)";

/**
 * The pending-restart state behind `/admin/restart-when-idle`
 * (docs/SDD-coordinator.md §4.12): once requested, new dispatches are
 * held, and the moment nothing is running the process exits with
 * RESTART_EXIT_CODE for the supervisor to restart. Wissel cannot
 * restart itself. One instance per app, same as the Orchestrator.
 */
export class RestartWhenIdle {
  private requestedAt: string | undefined;
  private exited = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> | undefined;
  private recheck = false;
  private onEvent = () => void this.check();

  constructor(private opts: RestartWhenIdleOptions) {}

  get pending(): boolean {
    return this.requestedAt !== undefined;
  }

  async status(): Promise<RestartWhenIdleStatus> {
    return {
      supervised: this.opts.supervised,
      pending: this.pending,
      requestedAt: this.requestedAt,
      running: await this.opts.running(),
      exitCode: RESTART_EXIT_CODE,
    };
  }

  /** Idempotent while pending. Refused unsupervised, with the fix. */
  request(): { ok: true } | { ok: false; error: string } {
    if (!this.opts.supervised) {
      return {
        ok: false,
        error: "no supervisor restarts wissel on exit code 75: set WISSEL_SUPERVISED=1 in the start script or systemd unit (Restart=on-failure) that does, then ask again",
      };
    }
    if (this.requestedAt) return { ok: true };
    this.requestedAt = (this.opts.now ?? (() => new Date()))().toISOString();
    this.opts.holdDispatch(HOLD_REASON);
    this.opts.events?.on("event", this.onEvent);
    const pollMs = this.opts.pollMs ?? 5000;
    if (pollMs > 0) {
      this.timer = setInterval(this.onEvent, pollMs);
      this.timer.unref?.();
    }
    this.log(`restart when idle: requested; no new cards start, exit ${RESTART_EXIT_CODE} once running cards finish`);
    void this.check();
    return { ok: true };
  }

  /** False when nothing was pending (or the exit already happened). */
  cancel(): boolean {
    if (!this.requestedAt || this.exited) return false;
    this.requestedAt = undefined;
    this.unwatch();
    this.opts.releaseDispatch();
    this.log("restart when idle: cancelled; cards dispatch again");
    return true;
  }

  private unwatch(): void {
    this.opts.events?.off("event", this.onEvent);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One check at a time; an event during a check queues one more round
   *  rather than racing two exits. */
  private check(): Promise<void> {
    if (this.checking) {
      this.recheck = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.recheck = false;
        if (!this.requestedAt || this.exited) return;
        const running = await this.opts.running();
        if (!this.requestedAt || this.exited) return; // cancelled meanwhile
        if (running.length === 0) {
          this.exited = true;
          this.unwatch();
          this.log(`restart when idle: nothing running, exiting with code ${RESTART_EXIT_CODE} for the supervisor to restart wissel`);
          (this.opts.exit ?? ((code: number) => process.exit(code)))(RESTART_EXIT_CODE);
          return;
        }
      } while (this.recheck);
    })().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }
}
