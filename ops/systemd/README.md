# systemd user units

`wissel-morning-podcasts.timer` runs the "AI news podcast" and "World
news podcast" pipelines at 06:00 Europe/Madrid (same as Amsterdam)
every day, through `scripts/run-pipelines.ts` against the live server.

Install (user units, no sudo; lingering must be on so they run while
you're logged out: `loginctl enable-linger $USER`):

```bash
mkdir -p ~/.config/systemd/user
ln -sf "$PWD/ops/systemd/wissel-morning-podcasts.service" ~/.config/systemd/user/
ln -sf "$PWD/ops/systemd/wissel-morning-podcasts.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wissel-morning-podcasts.timer
```

Check: `systemctl --user list-timers wissel-*`, logs:
`journalctl --user -u wissel-morning-podcasts.service`. Run now:
`systemctl --user start wissel-morning-podcasts.service`.

The wissel server itself must be running; the script waits up to 10
minutes for it after a boot, then fails (logged) if it isn't up.
