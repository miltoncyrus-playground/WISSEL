import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyPgStart,
  EXPECTED_RLS_CHECKS,
  FIXTURE_DIR,
  hydratePgSymlinks,
  parseCheckLines,
  PG_BINARIES_PACKAGE,
  PG_BINARIES_VERSION,
  PG_CHECK_CLIENT,
  PG_CHECK_FIXTURES,
  PG_CHECK_PORT,
  pgBinariesTarballUrl,
  postgresCheckCommands,
  rlsVerdict,
} from "../eval/sandbox-postgres-checks.ts";

// eval/sandbox-postgres-checks.ts: the deterministic half of
// scripts/live-check-sandbox-postgres.test.ts. The outputs below are
// verbatim from the spike runs of 2026-10-19 inside the bubblewrap
// sandbox (docs/SDD-sandboxed-postgres.md).

const STOCK_FAILURE = `PG_VERSION=postgres (PostgreSQL) 18.4
PG_START_FAILED mode=default
2026-10-19 21:40:32.141 UTC [24] LOG:  starting PostgreSQL 18.4 on x86_64-pc-linux-gnu, compiled by gcc (Ubuntu 7.5.0-3ubuntu1~18.04) 7.5.0, 64-bit
2026-10-19 21:40:32.141 UTC [24] LOG:  listening on IPv4 address "127.0.0.1", port 54329
2026-10-19 21:40:32.148 UTC [24] FATAL:  could not create lock file "/tmp/.s.PGSQL.54329.lock": Read-only file system
2026-10-19 21:40:32.151 UTC [24] LOG:  database system is shut down
`;

const SOCKET_FAILURE = `PG_START_FAILED mode=unixdir
2026-10-19 21:41:08.303 UTC [24] LOG:  listening on IPv4 address "127.0.0.1", port 54329
2026-10-19 21:41:08.328 UTC [24] LOG:  could not create Unix socket for address "/tmp/claude-1000/pgspike/.s.PGSQL.54329": Operation not permitted
2026-10-19 21:41:08.328 UTC [24] WARNING:  could not create Unix-domain socket in directory "/tmp/claude-1000/pgspike"
2026-10-19 21:41:08.328 UTC [24] FATAL:  could not create any Unix-domain sockets
`;

const TCP_PASS = `PG_VERSION=postgres (PostgreSQL) 18.4
PG_STARTED port=54329 mode=tcp
check:version=180004
check:force_rls=true ok
check:app_it_rows=2 ok
check:app_it_titles=laptop,vpn ok
check:app_no_setting_rows=0 ok
check:owner_hr_rows=1 ok
check:smuggle_error=42501 ok
check:smuggled_rows=0 ok
check:superuser_rows=3 ok
RLS_CHECK_PASS
CLIENT_EXIT=0
`;

describe("pgBinariesTarballUrl", () => {
  test("is npm's tarball URL for the scoped package (what the spike downloaded)", () => {
    expect(pgBinariesTarballUrl()).toBe("https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-18.4.0-beta.17.tgz");
    expect(pgBinariesTarballUrl("pg", "1.0.0")).toBe("https://registry.npmjs.org/pg/-/pg-1.0.0.tgz");
  });

  test("stays on the host every write-tier run may reach", () => {
    expect(new URL(pgBinariesTarballUrl()).host).toBe("registry.npmjs.org");
    expect(PG_BINARIES_PACKAGE).toBe("@embedded-postgres/linux-x64");
    expect(PG_BINARIES_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("classifyPgStart", () => {
  test("stock settings: the unix socket's /tmp lock file hits the read-only mount", () => {
    expect(classifyPgStart(STOCK_FAILURE)).toBe("readonly-tmp");
  });
  test("a writable socket dir: seccomp refuses the AF_UNIX socket", () => {
    expect(classifyPgStart(SOCKET_FAILURE)).toBe("unix-socket-blocked");
  });
  test("TCP-only: started", () => {
    expect(classifyPgStart(TCP_PASS)).toBe("started");
  });
  test("anything else is unknown, including a PG_STARTED that isn't at a line start", () => {
    expect(classifyPgStart("")).toBe("unknown");
    expect(classifyPgStart("INITDB_FAILED\ninitdb: error: ...")).toBe("unknown");
    expect(classifyPgStart("echo PG_STARTED")).toBe("unknown");
  });
});

describe("parseCheckLines / rlsVerdict", () => {
  test("parses every check line, dropping the client's own ok/FAIL suffix", () => {
    expect(parseCheckLines(TCP_PASS)).toEqual({
      version: "180004",
      force_rls: "true",
      app_it_rows: "2",
      app_it_titles: "laptop,vpn",
      app_no_setting_rows: "0",
      owner_hr_rows: "1",
      smuggle_error: "42501",
      smuggled_rows: "0",
      superuser_rows: "3",
    });
    expect(parseCheckLines("check:x=1 FAIL (want 2)\n")).toEqual({ x: "1" });
    expect(parseCheckLines("nothing here")).toEqual({});
  });

  test("the spike's passing output passes, with the version", () => {
    expect(rlsVerdict(TCP_PASS)).toEqual({ pass: true, problems: [], version: "180004" });
  });

  test("a wrong value fails and names the check", () => {
    const v = rlsVerdict(TCP_PASS.replace("check:owner_hr_rows=1 ok", "check:owner_hr_rows=3 FAIL (want 1)").replace("RLS_CHECK_PASS", "RLS_CHECK_FAIL 1"));
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual(["owner_hr_rows: got 3, want 1", "no RLS_CHECK_PASS marker"]);
  });

  test("a missing check fails even when the marker is there (a client that printed less)", () => {
    const v = rlsVerdict(TCP_PASS.replace("check:smuggled_rows=0 ok\n", ""));
    expect(v.pass).toBe(false);
    expect(v.problems).toEqual(["smuggled_rows: missing (want 0)"]);
  });

  test("the marker alone, with no values, fails (never trust the client's verdict alone)", () => {
    const v = rlsVerdict("RLS_CHECK_PASS\n");
    expect(v.pass).toBe(false);
    expect(v.problems).toHaveLength(Object.keys(EXPECTED_RLS_CHECKS).length);
    expect(v.version).toBeUndefined();
  });

  test("the expected values match what rls-check.mjs itself asserts", async () => {
    const src = await Bun.file(join(FIXTURE_DIR, PG_CHECK_CLIENT)).text();
    for (const [k, v] of Object.entries(EXPECTED_RLS_CHECKS)) expect(src).toContain(`${k}: "${v}"`);
    expect(src).toContain('from "pg"');
  });
});

describe("postgresCheckCommands", () => {
  const cmds = postgresCheckCommands("/tmp/repo/vendor");

  test("six commands, docker first, the failing starts before the TCP start, the port probe last", () => {
    expect(cmds).toHaveLength(6);
    expect(cmds[0]).toBe("docker ps");
    const at = (needle: string) => cmds.findIndex((c) => c.includes(needle));
    expect(at(" default")).toBeLessThan(at(" unixdir"));
    expect(at(" unixdir")).toBeLessThan(at(" tcp"));
    expect(at(" tcp")).toBeLessThan(at("port-probe.mjs"));
    expect(cmds[5]).toBe(`bun run /tmp/repo/vendor/port-probe.mjs ${PG_CHECK_PORT}`);
  });

  test("every fixture is referenced by its vendored path and no command sets a variable up front", () => {
    for (const f of PG_CHECK_FIXTURES) expect(cmds.some((c) => c.includes(`/tmp/repo/vendor/${f}`))).toBe(true);
    for (const c of cmds) expect(c).not.toMatch(/^\w+=/);
  });

  test("the fixture files exist and pg-check.sh parses as bash", () => {
    for (const f of [...PG_CHECK_FIXTURES, PG_CHECK_CLIENT]) expect(existsSync(join(FIXTURE_DIR, f))).toBe(true);
    const r = Bun.spawnSync(["bash", "-n", join(FIXTURE_DIR, "pg-check.sh")], { stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });

  test("pg-check.sh uses the same port, loopback only, and disables unix sockets for the tcp mode alone", async () => {
    const src = await Bun.file(join(FIXTURE_DIR, "pg-check.sh")).text();
    expect(src).toContain(`port=${PG_CHECK_PORT}`);
    expect(src).toContain("listen_addresses=127.0.0.1");
    expect(src).toContain('"$mode" = "tcp"');
    expect(src).toContain('"$mode" = "unixdir"');
    expect(src).toMatch(/-c unix_socket_directories="\n/); // the tcp mode: the empty value, no socket
    expect(src).toContain("-c unix_socket_directories=${TMPDIR:-/tmp}"); // unixdir: a writable dir, so seccomp is what refuses
    expect(src).not.toContain("unix_socket_directories=/tmp"); // never the read-only host /tmp on purpose
  });
});

describe("hydratePgSymlinks", () => {
  function fakePackage(): string {
    const dir = mkdtempSync(join(tmpdir(), "wissel-pg-symlinks-"));
    mkdirSync(join(dir, "native", "lib"), { recursive: true });
    writeFileSync(join(dir, "native", "lib", "libicuuc.so.60.2"), "");
    writeFileSync(join(dir, "native", "lib", "libpq.so.5.18"), "");
    writeFileSync(
      join(dir, "native", "pg-symlinks.json"),
      JSON.stringify([
        { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so.60" },
        { source: "native/lib/libicuuc.so.60.2", target: "native/lib/libicuuc.so" },
        { source: "native/lib/libpq.so.5.18", target: "native/lib/libpq.so.5" },
      ]),
    );
    return dir;
  }

  test("makes every link from the manifest, relative, then does nothing on a second call", () => {
    const dir = fakePackage();
    try {
      expect(hydratePgSymlinks(dir)).toBe(3);
      expect(readlinkSync(join(dir, "native", "lib", "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
      expect(readlinkSync(join(dir, "native", "lib", "libpq.so.5"))).toBe("libpq.so.5.18");
      expect(lstatSync(join(dir, "native", "lib", "libicuuc.so")).isSymbolicLink()).toBe(true);
      expect(hydratePgSymlinks(dir)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("leaves a target that already exists as a file alone", () => {
    const dir = fakePackage();
    try {
      writeFileSync(join(dir, "native", "lib", "libpq.so.5"), "real file");
      expect(hydratePgSymlinks(dir)).toBe(2);
      expect(lstatSync(join(dir, "native", "lib", "libpq.so.5")).isSymbolicLink()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
