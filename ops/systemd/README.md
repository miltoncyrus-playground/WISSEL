# systemd user units

`wissel-morning-podcasts.timer` runs the "AI news podcast" and "World
news podcast" pipelines at 06:00 Europe/Madrid (same as Amsterdam)
every day, through `scripts/run-pipelines.ts` against the live server.

These units are being replaced by wissel's own schedules
(`docs/SDD-schedules.md` §7).

**Status 2026-10-18:** steps 1-3 below are done. The timer is disabled
(its `~/.config/systemd/user` link is gone) and both wissel schedules
are enabled, first fire 2026-10-19 06:00 Europe/Madrid. The podcasts
now run only from wissel. Step 4 waits on the acceptance check.

## Switch-over to wissel schedules

Do these in order. Enabling the schedules before step 2 runs each
podcast twice every morning (once from the timer, once from wissel).
Agents never run `systemctl`; steps 2 and 3 are Milton's.

1. `bun run seed:schedules` creates two **disabled** schedules, "AI
   news podcast" and "World news podcast" (`0 6 * * *`, `Europe/Madrid`,
   `catchUpHours: 12`), pointing at the stored pipelines of the same
   names. It never enables a schedule and never makes a duplicate:
   re-running it leaves existing ones alone and says so. A missing
   pipeline is reported and skipped with a non-zero exit (run
   `bun run seed:ai-news` first).
2. Milton turns the timer off:

   ```bash
   systemctl --user disable --now wissel-morning-podcasts.timer
   ```

3. Milton enables both schedules from the board's Schedules panel, the
   app, or Ask (or `PATCH /schedules/:id` with `{"enabled": true}`). Each gets its
   `nextRunAt` at the next 06:00 Europe/Madrid.
4. After the first clean morning, a follow-up commit removes the two
   unit files and rewrites this README to point at
   `docs/SDD-schedules.md`.

Acceptance check: `GET /schedules` shows both podcasts with `lastRunAt`
within 60 s of 06:00 Europe/Madrid on three mornings in a row,
including 2026-10-25 (the DST change, 05:00Z that day instead of
04:00Z), with `lastOutcome: "started"`.

To go back: disable both schedules first, then
`systemctl --user enable --now wissel-morning-podcasts.timer`.

`scripts/run-pipelines.ts` stays as a manual CLI after the switch-over:
`bun run scripts/run-pipelines.ts "AI news podcast" "World news podcast"`.

## Install (the timer, until the switch-over)

User units, no sudo; lingering must be on so they run while you're
logged out: `loginctl enable-linger $USER`.

```bash
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/ops/systemd/wissel-morning-podcasts.service" ~/.config/systemd/user/
ln -sf "$PWD/ops/systemd/wissel-morning-podcasts.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wissel-morning-podcasts.timer
```

Check: `systemctl --user list-timers wissel-*`, logs:
`journalctl --user -u wissel-morning-podcasts.service`. Run now:
`systemctl --user start wissel-morning-podcasts.service`. Check what
the runs produced against the eval checks, free:
`bun run check:news-run`.

The wissel server itself must be running; the script waits up to 10
minutes for it after a boot, then fails (logged) if it isn't up.
