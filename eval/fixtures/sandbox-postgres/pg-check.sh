#!/usr/bin/env bash
# Starts the vendored PostgreSQL inside the write-tier sandbox, runs the
# row-level-security checks over TCP, stops it. One process tree on
# purpose: every sandboxed Bash call is its own pid and network
# namespace, so a server started in one call is gone in the next
# (docs/SDD-sandboxed-postgres.md).
#
#   bash pg-check.sh <vendor-dir> default   stock settings: unix socket in /tmp
#   bash pg-check.sh <vendor-dir> unixdir   unix socket in $TMPDIR (writable): the seccomp refusal
#   bash pg-check.sh <vendor-dir> tcp       unix_socket_directories='' and 127.0.0.1 only
#
# <vendor-dir> is what scripts/live-check-sandbox-postgres.ts assembled:
# pg/package/native/bin/{initdb,pg_ctl,postgres} and client/rls-check.mjs
# with `pg` installed next to it. Prints marker lines the live check
# parses (eval/sandbox-postgres-checks.ts): PG_VERSION=, PG_STARTED,
# PG_START_FAILED, CLIENT_EXIT=, and the server log on failure.
set -u
vendor="${1:?vendor dir}"
mode="${2:-tcp}"
bin="$vendor/pg/package/native/bin"
port=54329
data="${TMPDIR:-/tmp}/wissel-pg-check-$mode-$$"
log="$data.log"

rm -rf "$data" "$log" "$data.initdb.log"
echo "PG_VERSION=$("$bin/postgres" --version)"

if ! "$bin/initdb" -D "$data" -U postgres --auth=trust --no-sync > "$data.initdb.log" 2>&1; then
  echo "INITDB_FAILED"
  cat "$data.initdb.log"
  exit 1
fi

opts="-p $port -c listen_addresses=127.0.0.1"
if [ "$mode" = "tcp" ]; then
  opts="$opts -c unix_socket_directories="
elif [ "$mode" = "unixdir" ]; then
  opts="$opts -c unix_socket_directories=${TMPDIR:-/tmp}"
fi

if "$bin/pg_ctl" -D "$data" -l "$log" -w -t 30 -o "$opts" start > /dev/null; then
  echo "PG_STARTED port=$port mode=$mode"
else
  echo "PG_START_FAILED mode=$mode"
  cat "$log"
  exit 1
fi

bun run "$vendor/client/rls-check.mjs" "$port"
client=$?

"$bin/pg_ctl" -D "$data" -m fast stop > /dev/null
echo "CLIENT_EXIT=$client"
exit "$client"
