/**
 * The deterministic half of the sandboxed-Postgres live check
 * (scripts/live-check-sandbox-postgres.ts, docs/SDD-sandboxed-postgres.md):
 * which binaries, the fixed commands the agent runs, and the parsers
 * over what came back. No network, no sandbox, no LLM in here; gate-tested
 * in test/sandbox-postgres-checks.test.ts.
 *
 * The Postgres binaries come from an npm package, not PyPI: the npm
 * registry is on every write-tier run's allowlist (SANDBOX_ALLOWED_DOMAINS),
 * so the check needs no project setting, and this proves the sandbox can
 * run a real server regardless of where the binaries came from.
 */

import { existsSync, lstatSync, readFileSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

/** Postgres 18 binaries (initdb, pg_ctl, postgres + libs, no psql),
 *  the linux-x64 half of the `embedded-postgres` npm package. */
export const PG_BINARIES_PACKAGE = "@embedded-postgres/linux-x64";
export const PG_BINARIES_VERSION = "18.4.0-beta.17";

/** The TCP port the vendored server listens on inside the sandbox.
 *  Fixed, not free-port: the last command probes it from a new Bash call
 *  to prove the server did not outlive the call that started it. */
export const PG_CHECK_PORT = 54329;

/** The fixture files copied next to the binaries (FIXTURE_DIR). The
 *  client lives in the `client/` dir so bun resolves `pg` from there. */
export const PG_CHECK_FIXTURES = ["pg-check.sh", "unix-probe.mjs", "port-probe.mjs"] as const;
export const PG_CHECK_CLIENT = "rls-check.mjs";
export const FIXTURE_DIR = join(import.meta.dir, "fixtures", "sandbox-postgres");

/** npm's tarball URL for a scoped package version. */
export function pgBinariesTarballUrl(pkg: string = PG_BINARIES_PACKAGE, version: string = PG_BINARIES_VERSION): string {
  const slash = pkg.indexOf("/");
  const name = slash === -1 ? pkg : pkg.slice(slash + 1);
  return `https://registry.npmjs.org/${pkg}/-/${name}-${version}.tgz`;
}

/** Makes the symlinks the package's npm postinstall would have
 *  (native/pg-symlinks.json: libicuuc.so.60 -> libicuuc.so.60.2 and so
 *  on). Without them `postgres` fails to load (`libicui18n.so.60 => not
 *  found`). Skips a target that already exists, link or file. Returns
 *  how many links it made, so a second call returns 0. */
export function hydratePgSymlinks(pkgDir: string): number {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "native", "pg-symlinks.json"), "utf8")) as { source: string; target: string }[];
  let made = 0;
  for (const e of manifest) {
    const target = join(pkgDir, e.target);
    if (present(target)) continue;
    symlinkSync(basename(e.source), target);
    made++;
  }
  return made;
}

function present(path: string): boolean {
  if (existsSync(path)) return true;
  try {
    lstatSync(path); // a dangling symlink
    return true;
  } catch {
    return false;
  }
}

/** The commands the agent is told to run, one Bash call each, in order.
 *  `vendor` is the absolute path of the dir vendorPostgres() made in the
 *  task's repo (readable from the sandbox; only writes are bounded). */
export function postgresCheckCommands(vendor: string): string[] {
  return [
    "docker ps",
    `bun run ${vendor}/unix-probe.mjs "$TMPDIR"`,
    `bash ${vendor}/pg-check.sh ${vendor} default`,
    `bash ${vendor}/pg-check.sh ${vendor} unixdir`,
    `bash ${vendor}/pg-check.sh ${vendor} tcp`,
    `bun run ${vendor}/port-probe.mjs ${PG_CHECK_PORT}`,
  ];
}

/** How a `pg-check.sh` run ended, read from its output. */
export type PgStartOutcome = "started" | "readonly-tmp" | "unix-socket-blocked" | "unknown";

/** Classifies a pg-check.sh output. The two failure classes are the
 *  stock configuration meeting the sandbox: the lock file for the unix
 *  socket goes to /tmp, read-only inside bubblewrap; with a writable
 *  socket dir the seccomp filter refuses the AF_UNIX socket. */
export function classifyPgStart(output: string): PgStartOutcome {
  if (/^PG_STARTED\b/m.test(output)) return "started";
  if (/could not create lock file "[^"]*\.s\.PGSQL\.\d+\.lock": Read-only file system/.test(output)) return "readonly-tmp";
  if (/could not create Unix socket for address "[^"]*": Operation not permitted|could not create any Unix-domain sockets/.test(output)) {
    return "unix-socket-blocked";
  }
  return "unknown";
}

/** `check:<name>=<value>` lines of rls-check.mjs, last one per name. */
export function parseCheckLines(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of output.matchAll(/^check:([a-z_]+)=([^\n]*?)(?: ok| FAIL.*)?$/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** What rls-check.mjs must observe for the three features acme-platform
 *  relies on: a policy on a FORCE RLS table, read through a NOINHERIT
 *  application role with a transaction-local set_config principal. */
export const EXPECTED_RLS_CHECKS: Readonly<Record<string, string>> = {
  force_rls: "true",
  app_it_rows: "2",
  app_it_titles: "laptop,vpn",
  app_no_setting_rows: "0",
  owner_hr_rows: "1",
  smuggle_error: "42501",
  smuggled_rows: "0",
  superuser_rows: "3",
};

export interface RlsVerdict {
  pass: boolean;
  /** One line per expected check that is missing or differs, plus the
   *  missing pass marker. Empty when pass. */
  problems: string[];
  /** The server version number seen (`server_version_num`), if any. */
  version?: string;
}

/** Compares a pg-check.sh (tcp) output against EXPECTED_RLS_CHECKS.
 *  Both the per-check values and the client's own RLS_CHECK_PASS marker
 *  must be there: the marker alone would trust the client's verdict,
 *  the values alone would miss a client that crashed after printing. */
export function rlsVerdict(output: string, expected: Readonly<Record<string, string>> = EXPECTED_RLS_CHECKS): RlsVerdict {
  const seen = parseCheckLines(output);
  const problems: string[] = [];
  for (const [k, want] of Object.entries(expected)) {
    const got = seen[k];
    if (got === undefined) problems.push(`${k}: missing (want ${want})`);
    else if (got !== want) problems.push(`${k}: got ${got}, want ${want}`);
  }
  if (!/^RLS_CHECK_PASS$/m.test(output)) problems.push("no RLS_CHECK_PASS marker");
  const version = seen.version;
  return { pass: problems.length === 0, problems, ...(version !== undefined ? { version } : {}) };
}
