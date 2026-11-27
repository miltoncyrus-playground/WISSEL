// Where the board listens (docs/SDD-identity-and-permissions.md §4.1,
// build plan card 1). Until this existed `Bun.serve` got no `hostname`
// and the board answered on every interface of its host, with no
// authentication behind it. The default is now loopback; anything wider
// needs an explicit WISSEL_ALLOW_OPEN_BIND=1, which prints a warning on
// start and raises an owner task so the open door stays visible.
//
// Pure: reads only the env object it is handed, so tests pass their own.

export const DEFAULT_BIND = "127.0.0.1";

/** Title of the owner task an open bind raises. Also the dedup key, so a
 *  restart with the flag still set does not stack a second copy. */
export const OPEN_BIND_TASK_TITLE = "The board is open to the network";

export type BindResolution =
  | { ok: true; hostname: string; open: false }
  | { ok: true; hostname: string; open: true; warning: string }
  | { ok: false; hostname: string; error: string };

/** True for an address or name that only this host can reach. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // The whole of 127.0.0.0/8 is loopback, not just 127.0.0.1.
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

/** The hostname to pass to `Bun.serve`, or why the server must not start. */
export function resolveBind(env: Record<string, string | undefined>): BindResolution {
  const raw = env.WISSEL_BIND?.trim();
  const hostname = raw ? raw : DEFAULT_BIND;
  if (isLoopback(hostname)) return { ok: true, hostname, open: false };

  const allowed = ["1", "true"].includes(env.WISSEL_ALLOW_OPEN_BIND ?? "");
  if (!allowed) {
    return {
      ok: false,
      hostname,
      error:
        `refusing to start: WISSEL_BIND=${hostname} would let any machine that can reach this host use the board, ` +
        `and the board has no sign-in yet. Unset WISSEL_BIND to listen on ${DEFAULT_BIND} only, ` +
        `or set WISSEL_ALLOW_OPEN_BIND=1 if that exposure is intended.`,
    };
  }
  return {
    ok: true,
    hostname,
    open: true,
    warning:
      `WARNING: the board is listening on ${hostname} with no sign-in (WISSEL_ALLOW_OPEN_BIND=1). ` +
      `Anyone who can reach this host can create, run and merge work. Unset WISSEL_BIND to close it.`,
  };
}

/** The owner task's body: what is open, why it matters, how to close it. */
export function openBindTaskBody(hostname: string, port: number): string {
  return [
    `Wissel started with WISSEL_BIND=${hostname} and WISSEL_ALLOW_OPEN_BIND=1, so the board on port ${port} answers on more than loopback.`,
    "",
    "The board has no sign-in yet: anyone who can reach this host can create cards, run agents and merge their work.",
    "",
    `To close it: unset WISSEL_BIND (it defaults to ${DEFAULT_BIND}) and restart. If the exposure is intended, mark this done.`,
    "",
    "See docs/SDD-identity-and-permissions.md §4.1.",
  ].join("\n");
}
