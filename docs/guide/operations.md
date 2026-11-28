# Operations

Keeping a running board healthy: owner tasks, restarting without losing work, the host guard and spend reports. Starting it and the host setup are in [Getting started](getting-started.md).

## Owner tasks

An owner task is something only the owner can do, such as signing in
again or freeing a disk. `POST /owner-tasks {title, why, steps, check?,
blocks?}` raises one: a card labelled `owner` shows in Needs a human
with the why and the steps as tick-boxes, and each card in `blocks`
waits on it. `check` is a command as argv, run with no shell. Done
(`POST /owner-tasks/:id/done`) runs the check and closes the task only
if it exits 0. A failed check keeps the task open, with its output under
`lastCheck`. `POST /owner-tasks/:id/dismiss` closes the task without a
check. Closing releases the waiting cards. `GET /owner-tasks?status=open`
lists them (`src/services/owner-tasks.ts`, `docs/SDD-coordinator.md`
§3.4).

## Restarting when idle

To restart without interrupting cards, use `POST /admin/restart-when-idle`.
It stops new work from starting: the sweep, **Run** and pipeline runs all
answer 409 until the restart. Running cards are left to finish. Once none
is running, Wissel exits with code 75, and its supervisor starts it again
on the current code. `GET` on the same path shows whether a restart is
pending, and `DELETE` cancels it. The supervisor can be:
- systemd: `Restart=on-failure` restarts on 75, and adding
  `RestartForceExitStatus=75` makes that explicit;
- `bun run serve:supervised` (`scripts/serve-supervised.sh`), when Wissel
  is started by hand.

With neither, the route is refused, because exiting would leave the board
down. The start-up log says which applies (`docs/SDD-coordinator.md`
§4.12).

## The host guard

The host guard (`WISSEL_HOST_GUARD=1`) reads the host every 30 seconds:
load, available memory, free disk under `~/.wissel`, and free space in
each project's temp directory. While anything is under its threshold
(see the `WISSEL_HOST_GUARD_*` variables), new cards, **Run** and
pipeline runs wait, and running cards carry on. It raises one owner task
saying what is short, naming the largest entries in a full temp
directory and the running cards writing there. Done runs `bun run
host:check`, which passes only once the host has room. The hold lifts by
itself as soon as a reading is healthy. `GET /admin/host-guard` shows
whether it is holding (`src/services/host-guard.ts`).

## Where the spend goes

`bun run usage:report [--since 2026-10-10] [--agent implementer]` shows
where agent spend goes: per agent the runs, cost, turns, context per turn
and output, and what runs cut off by a session limit cost
(`docs/proposal-agent-run-efficiency.md`).

---

[Back to the README](../../README.md)
