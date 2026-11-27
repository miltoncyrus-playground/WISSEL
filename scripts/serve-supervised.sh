#!/bin/sh
# Runs `bun run serve` and starts it again each time it exits 75, the
# code Wissel exits with for restart when idle
# (docs/SDD-coordinator.md §4.12, src/services/restart-when-idle.ts).
# Any other exit code ends the loop with that code. Under systemd this is
# not needed: Restart=on-failure (or RestartForceExitStatus=75) does the
# same.
#
#   bun run serve:supervised
WISSEL_SUPERVISOR=script
export WISSEL_SUPERVISOR
while :; do
  bun run serve "$@"
  code=$?
  if [ "$code" -ne 75 ]; then
    exit "$code"
  fi
  echo "serve-supervised: Wissel asked to restart (exit 75); starting it again" >&2
  sleep 1
done
