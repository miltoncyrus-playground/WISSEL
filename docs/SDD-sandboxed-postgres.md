# SDD: a real PostgreSQL inside the write-tier Bash sandbox

Status: spike, answered 2026-10-19. Proposes, changes no sandbox policy.
Companion to docs/SDD-write-tier-sandbox.md (the sandbox) and
docs/SDD-project-settings.md (per-project domains, setup, verification).

## 1. The question

acme-platform (~/code/mash/acme-sdd.html) is a Python service on one
PostgreSQL database. Its visibility model is in the database: the
application connects as a role that does not own the tables and has no
bypass right, every protected table has `FORCE ROW LEVEL SECURITY`, and
the policies read `desk.*` settings the request sets with `set_config(...,
true)` (transaction-local). Its tests are "unit, property and contract
tests with a real PostgreSQL" through testcontainers.

Can an implementer run those tests inside Wissel's write-tier Bash
sandbox? `docker` is a refused program there, and its socket was expected
to be unreachable from bubblewrap. If not docker, then what, and at what
sandbox cost?

**Answer: yes, with an embedded server, TCP-only, started by the test
run itself.** No sandbox change is needed. Evidence in §3, the
recommendation in §4, the follow-up cards in §5.

## 2. Setup of the spike

Everything below ran on this host (Ubuntu 24.04.5, kernel 6.8, bubblewrap
0.9.0, Claude Code 2.1.303, bun 1.3.14) inside Claude Code's Linux Bash
sandbox: the same bubblewrap and seccomp mechanism the write-tier runs
use, in a session whose network allowlist was `registry.npmjs.org` and
`github.com`, exactly `SANDBOX_ALLOWED_DOMAINS`. The commands and outputs
are verbatim. What the write-tier run adds (`denyRead` on credential
dirs, `denyWrite` on the main repo's `.git`, the git deny rules) touches
none of the paths below, and `scripts/live-check-sandbox-postgres.test.ts`
(§6) reruns the whole thing under WriteExecutor's exact `--settings`.

Spike probes lived in a scratch dir and were deleted; what survives is
the fixture set under `eval/fixtures/sandbox-postgres/` the live check
runs, which produced the same results (§3.6).

What the sandbox looks like from inside:

```
Uid: 1000  CapEff: 0000000000000000  Seccomp: 2 (1 filter)
/            ro   (bind of the host root)
/tmp         ro   (the host's /tmp; writes only under $TMPDIR=/tmp/claude-1000)
/dev/shm     rw   tmpfs, 7.8G, empty
/proc/net/dev: lo only, no other interface
/var/run/docker.sock: srw-rw---- nobody nogroup
pid 1 of the call: the bash wrapper itself (own pid namespace per call)
```

## 3. Evidence, in the order the card asked

### 3.1 testcontainers / docker from inside the sandbox: fails

```
$ docker ps
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
exit=1
```

Why, reproduced with the stdlib (what docker-py, and so testcontainers,
does: an AF_UNIX connect to the socket, then `GET /version`):

```
$ python3 -I probe-docker-api.py
socket: mode=srw-rw---- uid=65534 gid=65534 (we are uid 1000)
os.access(W_OK) = True
docker API FAILED: errno=1 'Operation not permitted'
```

Two layers refuse it. The user namespace maps the socket's owner to
`nobody` (so the CLI's own access check says "permission denied"), and
the seccomp filter returns `EPERM` for AF_UNIX `connect`/`bind` whatever
the file permissions say. Claude Code's own docs: "`docker` is
incompatible with the sandbox" (sandboxing, Troubleshooting). The only
documented ways through are `excludedCommands` (runs docker unsandboxed,
with the user's full access) or `allowAllUnixSockets` (§3.5). Both hand a
write-tier agent the host; neither is proposed.

testcontainers-python would surface this as
`DockerException: Error while fetching server API version: ('Connection
aborted.', PermissionError(1, 'Operation not permitted'))` before any
container starts. (Not run verbatim: PyPI is not reachable from this
spike's session, §3.4; the stdlib reproduction above is the exact call
docker-py makes.)

### 3.2 Loopback, unix sockets, shared memory

```
$ python3 -I probe-unix.py "$TMPDIR"
FAIL AF_UNIX bind(path in writable dir): errno=1 (EPERM) Operation not permitted
FAIL AF_UNIX bind(abstract): errno=1 (EPERM) Operation not permitted
FAIL AF_UNIX SOCK_DGRAM bind(path): errno=1 (EPERM) Operation not permitted
FAIL AF_UNIX connect(/var/run/docker.sock): errno=1 (EPERM) Operation not permitted
OK   socketpair(AF_UNIX): b'x'
OK   AF_INET bind(0.0.0.0): 0.0.0.0:42593
OK   AF_INET6 bind(::1): [::1]:45913

$ python3 -I probe-loopback.py "$PWD/.spike"
OK   tcp loopback ok: bound 127.0.0.1:40331, echoed b'ping'
FAIL unix PermissionError(1, 'Operation not permitted')
OK   anon shared mmap ok; /dev/shm file ok; sysv shmget ok id=0
```

- **Loopback works.** bubblewrap's `--unshare-net` leaves a fresh
  network namespace with `lo` up. A process can bind 127.0.0.1 or `::1`
  and connect to itself. `strictAllowlist` is a rule of the sandbox
  *proxy*; a direct loopback connection never goes near the proxy
  (Claude Code sets `NO_PROXY` for localhost), so the allowlist does not
  apply to it. The docs say the same for Linux: "a sandboxed command's
  `localhost` is private to that command. The command can listen on a
  port and reach servers it started itself."
- **Unix sockets are refused**, every flavour (path, abstract, datagram,
  bind and connect). This is the optional seccomp filter, installed here
  (`Seccomp: 2`). `socketpair` still works, so forking servers that
  talk to their children over inherited socket pairs are fine.
- **Shared memory works**: anonymous shared mmap (Postgres's main
  segment), a file in `/dev/shm` (`dynamic_shared_memory_type=posix`,
  parallel query), and one System V segment (the postmaster interlock).

### 3.3 An embedded Postgres inside the sandbox: works, TCP-only

**Binaries.** No Postgres on the host, PyPI unreachable from this
session (§3.4), bison/flex missing so no build from the GitHub mirror.
The npm registry *is* on every write-tier allowlist, and
`@embedded-postgres/linux-x64` (the binaries half of the
`embedded-postgres` npm package, zonky's build) is PostgreSQL 18.4,
60 MB unpacked, `initdb`, `pg_ctl`, `postgres` and their libs (no psql):

```
$ curl -sS https://registry.npmjs.org/@embedded-postgres%2flinux-x64 ...
18.4.0-beta.17 https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-18.4.0-beta.17.tgz
$ tar -xzf "$TMPDIR/pgspike/epg.tgz" -C "$TMPDIR/pgspike/epg"   # then the package's symlink manifest
$ postgres --version
postgres (PostgreSQL) 18.4
```

**Stock settings fail.** `initdb` succeeds (data dir under `$TMPDIR`).
`pg_ctl start` with only `-p 54329`:

```
LOG:  listening on IPv4 address "127.0.0.1", port 54329
FATAL:  could not create lock file "/tmp/.s.PGSQL.54329.lock": Read-only file system
pg_ctl: could not start server
```

The TCP socket is already up; the unix socket's lock file in `/tmp` is
the first thing that dies. With the socket dir moved to the writable
`$TMPDIR` the next layer shows:

```
LOG:  listening on IPv4 address "127.0.0.1", port 54329
LOG:  could not create Unix socket for address "/tmp/claude-1000/pgspike/.s.PGSQL.54329": Operation not permitted
WARNING:  could not create Unix-domain socket in directory "/tmp/claude-1000/pgspike"
FATAL:  could not create any Unix-domain sockets
```

That is the seccomp filter. Postgres treats "no unix socket at all" as
fatal unless told not to want one.

**TCP-only works.**
`-c listen_addresses=127.0.0.1 -c unix_socket_directories=`:

```
$ pg_ctl -D "$data" -l "$log" -w -t 30 -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" start
waiting for server to start.... done
server started
LOG:  database system is ready to accept connections
   0: 0100007F:D439 ...   (127.0.0.1:54329 in /proc/net/tcp, LISTEN)
   27  1 postgres -D ... -p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=
   28 27 postgres: io worker 0  ... checkpointer, background writer, walwriter, autovacuum launcher
```

**RLS, FORCE RLS, transaction-local set_config, over TCP from a driver**
(bun + node-postgres from the npm registry, standing in for psycopg;
the SQL is in `eval/fixtures/sandbox-postgres/rls-check.mjs`):

| Check | Means | Got |
|---|---|---|
| `force_rls` | `relforcerowsecurity` on the table | `true` |
| `app_it_rows` | NOINHERIT app role, `set_config('desk.principal_desk','it',true)`: rows seen | `2` |
| `app_it_titles` | which rows | `laptop,vpn` |
| `app_no_setting_rows` | same role, next transaction, setting gone | `0` |
| `owner_hr_rows` | the table owner, desk `hr`: FORCE applies to it too | `1` |
| `smuggle_error` | app role inserting a row for another desk | `42501` (insufficient_privilege) |
| `smuggled_rows` | that row afterwards | `0` |
| `superuser_rows` | bootstrap superuser, no policy | `3` |

```
RLS_CHECK_PASS
waiting for server to shut down.... done
server stopped
```

Server version seen: `180004`.

**A server lives exactly as long as the Bash call that started it.**
Each sandboxed command is its own pid namespace (pid 1 is the call's
bash wrapper) and its own network namespace:

```
# call 1
$ setsid nohup sleep 600 & echo $! > "$TMPDIR/pgspike/sleeper.pid"
sleeper pid (inside this call's pid namespace): 5 ... alive within the same Bash call
# call 2
$ ps -eo pid,ppid,cmd
  1  0 /bin/bash -c ... (this call's wrapper)
  2  1 /bin/bash -c ...
  4  2 ps -eo pid,ppid,cmd
# and after pg-check.sh had started and stopped a server in an earlier call:
$ bun run port-probe.mjs 54329
PORT_54329=closed (ECONNREFUSED)
```

So `pg_ctl start` in one Bash call and `pytest` in the next cannot
work. The server has to be started by the process that uses it: a
pytest session fixture, or one script that does start, test, stop.
That is also what testcontainers did for Acme, so the test shape does
not change, only what the fixture starts.

### 3.4 Side findings that bear on acme-platform

- **PyPI needs the project setting.** From a run with only the fixed
  two hosts:
  `uv pip install ... postgresql-wheel pgserver psycopg[binary]` gives
  `Failed to fetch: https://pypi.org/simple/postgresql-wheel/ ... tunnel
  error: unsuccessful` and the sandbox reports `deny network-outbound
  pypi.org:443 (host is not on the allow list)`. With
  `sandboxAllowedDomains: ["pypi.org", "files.pythonhosted.org"]` on the
  project (docs/SDD-write-tier-sandbox.md §11) the same mechanism that
  fetched the npm tarball applies. Not demonstrated in this session,
  whose allowlist could not be widened.
- **uv's cache is read-only inside the sandbox.** Before the network
  refusal: `error: Could not acquire lock ... Read-only file system (os
  error 30) at path "/home/user/.cache/uv/.tmpyY0OZA"`. Same class as
  the known `~/.bun/install/cache` side effect (§8 of the sandbox SDD).
  `uv --cache-dir "$TMPDIR/..."` works; so would `UV_CACHE_DIR` in the
  write-tier run's env. `uv run` in a worktree whose `.venv` the
  project's worktreeSetup already synced (outside the sandbox) needs
  `--no-sync`, or the cache dir, to not touch `~/.cache/uv`.
- **bun's install cache, same.** `bun add pg` inside the sandbox worked
  with `BUN_INSTALL_CACHE_DIR="$TMPDIR/..."` (one env var, 14 packages,
  581 ms).
- **`/tmp` is read-only; `$TMPDIR` is the writable scratch.** Any tool
  that hardcodes `/tmp` (Postgres's socket default did) fails with
  `Read-only file system`.
- **The AF_UNIX refusal shows up as different errnos in different
  tools.** Postgres and Python report `EPERM`; Bun's `node:net` reports
  only `Failed to listen at <path>` with no code. The live check reads
  the errno from Postgres's own log, not from the Bun probe.

### 3.5 If an embedded server had not worked: the minimum sandbox change

Not needed. Recorded because the card asked, and because the next
person will be tempted:

| Change | Effect | Security cost |
|---|---|---|
| `network.allowUnixSockets: ["/var/run/docker.sock"]` | **none on Linux**: the per-path allowlist is macOS-only ("Ignored (seccomp can't filter by path)", sandbox-runtime README) | n/a |
| `network.allowAllUnixSockets: true` | turns the seccomp socket filter off; and with no seccomp helper in the chain bubblewrap gets `--disable-userns` instead, so the nested-namespace guard goes too | the docker socket is root on the host: `docker run -v /:/host` from a write-tier agent. Claude Code's docs name exactly this: "allowing access to /var/run/docker.sock effectively grants access to the host system" |
| `excludedCommands: ["docker *"]` | docker runs outside the sandbox, through the permission flow | same reach as above, plus no filesystem or network bound for those calls; a compose file in the worktree is agent-written and then run unsandboxed |
| `excludedCommands: ["uv run pytest *"]` | the whole test run unsandboxed | the agent writes a conftest, then runs it with the user's full access; the sandbox is gone for the step that matters most |

None of these is proposed. `--settings` would be the only place they
could go (the sandbox is admin-required, docs/SDD-write-tier-sandbox.md
§2); `GIT_WRITE_DENY`-style text rules would not contain them.

### 3.6 The fixture set, rerun

`eval/fixtures/sandbox-postgres/` (pg-check.sh, rls-check.mjs,
unix-probe.mjs, port-probe.mjs), assembled into the live check's
`vendor/` layout and run under the same sandbox:

```
### unix-probe
UNIX_SOCKET_BIND=refused (Failed to listen at /tmp/claude-1000/wissel-unix-probe-12.sock)
### pg-check default
PG_START_FAILED mode=default
FATAL:  could not create lock file "/tmp/.s.PGSQL.54329.lock": Read-only file system
### pg-check unixdir
PG_START_FAILED mode=unixdir
LOG:  could not create Unix socket for address "/tmp/claude-1000/.s.PGSQL.54329": Operation not permitted
FATAL:  could not create any Unix-domain sockets
### pg-check tcp
PG_STARTED port=54329 mode=tcp
check:version=180004 ... check:superuser_rows=3 ok
RLS_CHECK_PASS
CLIENT_EXIT=0
### port-probe (next call)
PORT_54329=closed (ECONNREFUSED)
```

## 4. Recommendation

**Use an embedded PostgreSQL started by the test session, TCP-only on
127.0.0.1, binaries installed into the worktree's `.venv` by the
project's worktreeSetup.** Keep testcontainers for laptops and CI behind
a switch. Do not budget pushback rounds for "integration tests can't run
here": they can, and they run with the real engine, real roles and real
policies.

Concretely for acme-platform:

1. A pytest session fixture `pg_server` that runs `initdb` once (cached
   under the worktree, say `.pg-test-cluster/`, gitignored), then
   `pg_ctl start -o "-p <free port> -c listen_addresses=127.0.0.1 -c
   unix_socket_directories= -c fsync=off -c synchronous_commit=off"`,
   yields a DSN, and stops the server at session end. `pg_ctl -w` waits
   on TCP when there is no unix socket (it did here). Tests get a fresh
   database per module from `CREATE DATABASE ... TEMPLATE`.
2. Binaries from PyPI, pinned, with the project's
   `sandboxAllowedDomains` holding `pypi.org` and
   `files.pythonhosted.org`. Two candidates; the card that builds the
   fixture verifies which one can be told "no unix socket":
   - `postgresql-wheel`: ships `initdb`/`pg_ctl`/`postgres` and thin
     Python wrappers that pass arguments straight through. Full control
     over the flags above. First choice for that reason.
   - `pgserver`: a convenience server manager. It talks to its server
     over a unix socket by default; unless it exposes TCP-only (to be
     checked against the pinned version), it is the wrong tool inside
     this sandbox even though it is the nicer API.
   Both are MIT, both bundle PostgreSQL 16/17; either is fine for RLS
   (policies, FORCE RLS and `set_config(..., true)` are PostgreSQL 9.5+).
3. `ACME_TEST_DB=embedded|testcontainers|<DSN>` chooses the fixture.
   `embedded` is the default in a Wissel worktree (set by the project's
   verification command or `pytest.ini`); laptops may keep
   testcontainers; CI passes a DSN.
4. The verification command runs the server and the tests in one
   process tree: `.venv/bin/pytest` (or `uv run --no-sync pytest`), never
   a "start the database" step followed by a "run the tests" step.

What this costs: 60 MB of binaries per worktree `.venv` (shared through
uv's cache once `UV_CACHE_DIR` is set, §5), two to three seconds of
`initdb` per session, and a fixture of about forty lines. What it buys:
the same tests, the same engine, no sandbox exception.

Where it would break:

- A test that reaches for `docker` directly (a Redis container, say)
  fails the same way. Acme's SDD lists one database and no other
  container at test time; if that changes, that service needs its own
  embedded answer or a fake.
- A test that connects over a unix socket (`host=/var/run/postgresql`)
  fails with `Operation not permitted`. The DSN the fixture yields is
  TCP, and nothing in SQLAlchemy or psycopg needs the socket.
- `initdb` as root refuses to run. Not a sandbox concern (uid 1000
  here), but a CI image that runs as root needs a user.
- A fixed port collides when two write-tier runs of the same project
  share a host. The fixture takes a free port (bind 0, read it back),
  not 54329; the live check uses a fixed port only to probe it from
  the next call.
- `pg_ctl -w` reads `postmaster.pid` and pings the first listen
  address. With `listen_addresses=127.0.0.1` that is TCP and it works;
  with `listen_addresses=''` and no unix socket there is nothing to
  ping, and the start never reports ready.

## 5. Follow-up cards

acme-platform (the target repo; Wissel builds it, so these are cards
there):

1. **Embedded Postgres test fixture.** The `pg_server` fixture of §4,
   `postgresql-wheel` pinned, TCP-only, free port, `ACME_TEST_DB`
   switch, testcontainers kept behind it. Acceptance: `pytest` passes
   with `ACME_TEST_DB=embedded` on a machine with no docker daemon;
   an RLS test (app role, FORCE RLS table, `set_config` principal)
   is in the suite and fails when the policy is dropped.
2. **Verify the package's socket behaviour.** Part of card 1 or its
   spike: confirm `postgresql-wheel`'s `pg_ctl` wrapper passes `-o`
   through; if `pgserver` is preferred for its API, confirm it can run
   without a unix socket against the pinned version, else drop it.

wissel (this repo):

3. **Write-tier cache dirs for non-bun toolchains.** Set `UV_CACHE_DIR`
   and `BUN_INSTALL_CACHE_DIR` under the sandbox's writable temp dir
   for write-tier runs (settings `env` in `buildSandboxSettings`, after
   confirming the path Claude Code's sandbox makes writable), so `uv
   run`/`uv pip`/`bun add` inside the sandbox stop failing with
   `Read-only file system` on `~/.cache/uv` and `~/.bun/install/cache`.
   Gate test: the env block is present with the sandbox on, absent off;
   a project with no setting gets the same two vars (this is per-run,
   not per-project). Resolves the §8 "known side effect" of the sandbox
   SDD too.
4. **Steer the one-call rule.** Add one line to the write-tier
   `verificationContract` steering (agents/manifest.yaml) and to the
   per-project `verification` docs: a server a Bash call starts dies
   with that call; start it from the test process. Cheap, and it saves
   the first implementer the discovery.
5. **Register acme-platform with its settings** once the repo exists:
   `sandboxAllowedDomains` (`pypi.org`, `files.pythonhosted.org`,
   `registry.terraform.io`, `releases.hashicorp.com`), `worktreeSetup`
   (`uv sync --frozen`), `verification` (`.venv/bin/ruff check`,
   `.venv/bin/pyright`, `.venv/bin/pytest`), `protectedPaths`
   (`terraform/**` as decided). Existing settings, no code; one card to
   do it and run `live-check:sandbox` against that project.
6. **Keep `live-check:sandbox-postgres` in the ship checklist** next to
   `live-check:sandbox`: it is the proof that the sandbox still allows
   a loopback server, which a future Claude Code change (a stricter
   network namespace, a seccomp rule on `bind`) could remove silently.

## 6. The live check

`bun run live-check:sandbox-postgres`
(scripts/live-check-sandbox-postgres.test.ts). One real `claude -p`
write-tier run in a temp worktree, sandbox on, with WriteExecutor's
exact `--settings`; skips with the preflight's reasons when the sandbox
can't start. Setup outside the sandbox: the npm tarball (cached in the
OS temp dir by version), symlinks hydrated, `pg` installed next to the
client, all under `<repo>/vendor`, readable from the sandbox. The agent
runs six fixed commands, one Bash call each:

```
docker ps
bun run <vendor>/unix-probe.mjs "$TMPDIR"
bash <vendor>/pg-check.sh <vendor> default
bash <vendor>/pg-check.sh <vendor> unixdir
bash <vendor>/pg-check.sh <vendor> tcp
bun run <vendor>/port-probe.mjs 54329
```

Assertions are on the tool results, not the agent's words: docker ran
and could not reach the daemon; the unix bind was refused; the stock
start fails as `readonly-tmp` or `unix-socket-blocked`; the writable
socket dir fails as `unix-socket-blocked`; the TCP start reports
`PG_STARTED`, every row of the table in §3.3 matches and
`RLS_CHECK_PASS` is printed; the port is closed in the next call.

Deterministic pieces, gate-tested in test/sandbox-postgres-checks.test.ts
with the verbatim outputs of §3: `pgBinariesTarballUrl`,
`hydratePgSymlinks`, `postgresCheckCommands`, `classifyPgStart`,
`parseCheckLines`, `rlsVerdict` (eval/sandbox-postgres-checks.ts), plus
`bash -n` over pg-check.sh and the expected values being the ones
rls-check.mjs asserts.

Not run end to end in the spike's own session: that session's sandbox
hides the harness config dir, so `evalHarness()` finds no enabled
claude-cli harness there. The fixtures it drives ran under the same
sandbox mechanism and gave the outputs in §3.6; the first run from a
normal shell is the end-to-end proof.

Measurable outcome: the live check passes (every assertion above) on
this host; and when acme-platform's card 1 lands, its pytest run
finishes green inside a write-tier run with `denials <= 1`, read from
the telemetry `result` event, instead of a pushback round about
docker.
