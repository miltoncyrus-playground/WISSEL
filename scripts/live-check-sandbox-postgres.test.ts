/**
 * Live check for docs/SDD-sandboxed-postgres.md: can a write-tier agent
 * run a real PostgreSQL, with row-level security, inside Wissel's Bash
 * sandbox? A real `claude -p` write-tier run in a real temp worktree,
 * sandbox on, with the exact `--settings` WriteExecutor builds.
 *
 *   bun run live-check:sandbox-postgres   (= bun test scripts/live-check-sandbox-postgres.test.ts)
 *
 * Outside test/ so the gate lane never runs it: one real model run (a
 * few cents, about two minutes) plus a one-time 60 MB download of the
 * Postgres binaries from registry.npmjs.org, cached in the OS temp dir.
 * Skips with the preflight's reasons when the sandbox can't start here.
 *
 * Setup, outside the sandbox (vendorPostgres): the binaries and a `pg`
 * client are put under <repo>/vendor, readable from the sandbox. The
 * agent is told to run fixed commands, one Bash call each; every
 * assertion is on the tool results, never on what the agent says:
 *   (1) `docker ps` fails: the docker socket is unreachable
 *   (2) binding a unix socket fails with EPERM (seccomp)
 *   (3) stock Postgres settings fail to start (unix socket in /tmp), and
 *       with a writable socket dir the server itself reports the
 *       seccomp refusal ("Operation not permitted")
 *   (4) TCP-only Postgres starts on 127.0.0.1 and the RLS checks pass:
 *       FORCE ROW LEVEL SECURITY, a policy over a transaction-local
 *       set_config, a NOINHERIT application role
 *   (5) in the next Bash call the port is closed: the server lived and
 *       died with the call that started it
 */
import { expect, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../src/core/registry.ts";
import { WriteExecutor } from "../src/executors/write.ts";
import { probeSandbox } from "../src/executors/sandbox.ts";
import { evalHarness } from "../eval/eval-harness.ts";
import { bashCalls, findCall, isPermissionRefusal, tinyBunRepo } from "../eval/sandbox-checks.ts";
import {
  classifyPgStart,
  FIXTURE_DIR,
  hydratePgSymlinks,
  PG_BINARIES_PACKAGE,
  PG_BINARIES_VERSION,
  PG_CHECK_CLIENT,
  PG_CHECK_FIXTURES,
  PG_CHECK_PORT,
  pgBinariesTarballUrl,
  postgresCheckCommands,
  rlsVerdict,
} from "../eval/sandbox-postgres-checks.ts";

const status = await probeSandbox();

function sh(cmd: string[], cwd?: string): void {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode}): ${r.stderr.toString()}`);
}

/** <repo>/vendor: pg/package/native/bin/* (the npm tarball, extracted,
 *  symlinks hydrated), client/ with `pg` installed and rls-check.mjs,
 *  and the probe scripts. The tarball is cached in the OS temp dir by
 *  package version, so only the first run downloads it. */
export async function vendorPostgres(repo: string): Promise<string> {
  const vendor = join(repo, "vendor");
  const pkgDir = join(vendor, "pg");
  await mkdir(pkgDir, { recursive: true });
  const tarball = join(tmpdir(), `wissel-${PG_BINARIES_PACKAGE.replace(/[@/]/g, "-")}-${PG_BINARIES_VERSION}.tgz`);
  if (!existsSync(tarball)) {
    const res = await fetch(pgBinariesTarballUrl());
    if (!res.ok) throw new Error(`downloading ${pgBinariesTarballUrl()}: HTTP ${res.status}`);
    await Bun.write(tarball, res);
  }
  sh(["tar", "-xzf", tarball, "-C", pkgDir]);
  hydratePgSymlinks(join(pkgDir, "package"));

  const client = join(vendor, "client");
  await mkdir(client, { recursive: true });
  await Bun.write(join(client, "package.json"), JSON.stringify({ name: "wissel-pg-check-client", private: true, type: "module" }, null, 2));
  sh(["bun", "add", "pg@^8"], client);
  copyFileSync(join(FIXTURE_DIR, PG_CHECK_CLIENT), join(client, PG_CHECK_CLIENT));
  for (const f of PG_CHECK_FIXTURES) copyFileSync(join(FIXTURE_DIR, f), join(vendor, f));
  return vendor;
}

if (status.state !== "on") {
  test.skip(`sandboxed Postgres live check (skipped: sandbox ${status.state}: ${status.problems.join("; ")})`, () => {});
  console.log(`live-check:sandbox-postgres skipped, the sandbox can't start here:\n  ${status.problems.join("\n  ")}`);
} else {
  test(
    "a real write-tier run: Postgres with RLS runs on loopback inside the sandbox, docker and unix sockets do not",
    async () => {
      const repo = await tinyBunRepo("live-check-sandbox-postgres");
      const home = await mkdtemp(join(tmpdir(), "wissel-live-check-sandbox-postgres-home-"));
      const lines: unknown[] = [];
      const run = await evalHarness();
      try {
        const vendor = await vendorPostgres(repo);
        const commands = postgresCheckCommands(vendor);
        const base = (await Registry.load()).get("implementer")!;
        const agent = { ...base, verificationContract: undefined, outputContract: undefined, handoffs: undefined };
        const executor = new WriteExecutor({ homeDir: home, sandbox: status, onChunk: (_id, line) => lines.push(line) });
        const result = await executor.run(
          {
            id: `live-check-sandbox-postgres-${process.pid}`,
            title: "Sandboxed Postgres live check",
            body: [
              "This is an infrastructure check, not a coding task. Change no files.",
              "Run each of these commands exactly as written, each as its own Bash call, in this order, even when one fails.",
              "Some take up to a minute. Don't retry, rewrite or explain them; don't use any other tool. Then reply with the single word: done",
              "",
              ...commands.map((c) => `    ${c}`),
            ].join("\n"),
            labels: ["code"],
            repo,
            status: "dispatched",
          },
          agent,
          run.harness,
        );
        const calls = bashCalls(lines);
        console.log(JSON.stringify({ ok: result.ok, sandbox: result.sandbox, denials: result.denials, permissionDenials: result.permissionDenials, calls }, null, 2));
        expect(result.sandbox).toBe("on");

        // (1) docker: ran (no permission refusal), could not reach the daemon.
        const docker = findCall(calls, "docker ps");
        expect(docker && !isPermissionRefusal(docker)).toBe(true);
        expect(docker!.output).toMatch(/permission denied|Operation not permitted|Cannot connect to the Docker daemon|command not found/i);
        expect(docker!.output).not.toMatch(/CONTAINER ID/);

        // (2) a unix socket bind is refused.
        const unix = findCall(calls, "unix-probe.mjs");
        expect(unix && !isPermissionRefusal(unix)).toBe(true);
        expect(unix!.output).toContain("UNIX_SOCKET_BIND=refused");
        expect(unix!.output).not.toContain("UNIX_SOCKET_BIND=ok");

        // (3) stock settings: the unix socket's /tmp lock file (or the
        // socket itself) stops the start; with a writable socket dir it
        // is the seccomp filter, in Postgres's own words.
        const stock = findCall(calls, "pg-check.sh " + vendor + " default");
        expect(stock && !isPermissionRefusal(stock)).toBe(true);
        expect(["readonly-tmp", "unix-socket-blocked"]).toContain(classifyPgStart(stock!.output));
        const unixdir = findCall(calls, "pg-check.sh " + vendor + " unixdir");
        expect(unixdir && !isPermissionRefusal(unixdir)).toBe(true);
        expect(classifyPgStart(unixdir!.output)).toBe("unix-socket-blocked");

        // (4) TCP-only: started on loopback, every RLS check as expected.
        const tcp = findCall(calls, "pg-check.sh " + vendor + " tcp");
        expect(tcp && !isPermissionRefusal(tcp)).toBe(true);
        expect(classifyPgStart(tcp!.output)).toBe("started");
        const verdict = rlsVerdict(tcp!.output);
        expect(verdict.problems).toEqual([]);
        expect(verdict.pass).toBe(true);
        expect(Number(verdict.version)).toBeGreaterThanOrEqual(180000);

        // (5) the next call's loopback has nothing on the port.
        const port = findCall(calls, "port-probe.mjs");
        expect(port && !isPermissionRefusal(port)).toBe(true);
        expect(port!.output).toContain(`PORT_${PG_CHECK_PORT}=closed`);
      } finally {
        run.release();
        await rm(repo, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    },
    600_000,
  );
}
