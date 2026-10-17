# SDD: write-tier Bash sandbox

Status: built 2026-10-17. Chosen by Milton on 2026-10-17 over a wider
`--allowedTools` prefix list.

## 1. Problem

Write-tier runs (implementer, fixer, integrator, lint-fixer) run
`claude -p --permission-mode acceptEdits` in a worktree. The only Bash
gate was `--allowedTools`: `Bash(bun test:*)`, `Bash(bun run
typecheck:*)` and per-card grants. Every command outside it was refused,
and a refusal costs a turn and often a whole review round.

Card 494f87d6 (2026-10-17) had 16 refused Bash calls:

| Kind | Examples | Should it run? |
|---|---|---|
| read-only shell not on the list | `grep -rn`, `sed -n`, `cat`, `ls`, `git --version`, `bun --version` | yes |
| allowed commands in a compound | `bun test ... 2>&1 \| grep ...`, `time bun run typecheck`, `bun test > /tmp/x.log` | yes (every segment must match a rule) |
| shell edits | `sed -i ...` | no, use Edit |
| arbitrary code | `bun -e '...'` | no |

Baseline as the card stated it (38 implementer results, finishedAt >=
2026-10-03): 34 had denials, median 8.5 denial keys per run, mean 24.1,
max 126. Those are key counts from the buggy counter in §4, so they
overstate.

Re-measured with `bun run denials:baseline` (39 implementer results
since 2026-10-03, measured by the reviewer of card 7821db37 on
2026-10-17):

| Count | Median | Mean | Max |
|---|---|---|---|
| raw `permission_denials` per run | **5** | 7.1 | 19 |
| distinct keys, old quote-blind split | 9 | 25.5 | 126 |
| distinct keys, first quote-aware split (newline = separator, no heredocs) | n/a | 32.5 | 154 |
| distinct keys, current split (heredocs, keywords, case patterns) | 4.5 | 5.3 | 19 |

The last row comes from a re-run of `bun run denials:baseline` by the
reviewer on 2026-10-17. It covered 40 implementer runs (37 with
denials), one more than the 39 behind the rows above. On those 40 runs
the other counts were raw 5 / 7 / 19 and old split 9 / 24.9 / 126, so
the comparison holds.

The raw median of **5** is the before-number. The first quote-aware
split was worse than the old one because heredoc bodies became one key
per line (§4); the current split skips them. Result: the current split's
key mean is 5.3, against 24.9 for the old split on the same 40 runs. The
inflation is gone, and the max (19) now equals the raw max, so no run
yields more keys than it had denials.

Measurable outcome: median raw denials per implementer run <= 1 with
the sandbox on (down from 5), read from the telemetry `result` event (§5).

## 2. Design

Claude Code ships an OS-enforced Bash sandbox (bubblewrap on Linux,
Seatbelt on macOS; https://code.claude.com/docs/en/sandboxing). With
`autoAllowBashIfSandboxed`, a command that runs inside it is approved
without a prompt, because the OS bounds what it can write, read and
reach. That turns the allowlist from the gate into a fallback, without
widening what an agent can touch.

`WriteExecutor` (src/executors/write.ts) passes the settings with
`--settings '<json>'`. That is the CLI settings scope, and
`allowUnsandboxedCommands: false` there makes the sandbox
"admin-required": a repository's `.claude/settings.json` can't loosen it
(no `excludedCommands`, `allowWrite`, `allowedDomains` from the repo).

The settings (`buildSandboxSettings`, src/executors/sandbox.ts):

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.config/gh", "~/.claude", "~/.claude.json",
                   "~/.claude-adevinta", "~/.codex", "~/.wissel/board.sqlite*",
                   "<every harness CLAUDE_CONFIG_DIR / CODEX_HOME>", "<WISSEL_DB_PATH>*"],
      "denyWrite": ["<task.repo>/.git"]
    },
    "network": { "allowedDomains": ["registry.npmjs.org", "github.com"], "strictAllowlist": true }
  },
  "permissions": { "deny": ["Bash(git add *)", "Bash(git commit *)", "Bash(git push *)", "..."] }
}
```

Why each part:

- **failIfUnavailable: true**: if the sandbox can't start, claude exits
  instead of running Bash unsandboxed. Combined with the allowlist still
  being passed, broad Bash never runs unsandboxed.
- **allowUnsandboxedCommands: false**: Claude Code ignores
  `dangerouslyDisableSandbox`, so a failing command can't be retried
  outside the sandbox.
- **Writes**: not widened. Claude Code's default is the cwd (the
  worktree), the per-user temp dir Claude Code's sandbox provides, and
  `--add-dir` (TaskCard.extraAllowedDirs). No `allowWrite`.
- **denyRead**: credentials (keys, cloud, gh), every Claude and Codex
  profile (they hold OAuth tokens), and the board database. The worktree
  lives under `~/.wissel/worktrees`, so `~/.wissel` as a whole can't be
  denied. The main checkout's `node_modules`, symlinked into each
  worktree, is not under any denied path and stays readable.
- **denyWrite on the main repo's `.git`**: the docs say a linked
  worktree's sandbox may write the shared `.git` (so `git commit`
  works). Write-tier agents must not commit (the merge path does that),
  and refs there are the main repo's own. This is the real boundary: no
  `git -C`, wrapper script or `sh -c` gets past an OS read-only mount.
  Read-only git (`status`, `diff`, `log`) still works.
- **permissions.deny for git writes** (`GIT_WRITE_DENY`): a clear,
  early refusal instead of a confusing `Read-only file system` error.
  Deny rules still apply in auto-allow mode. Text rules are bypassable;
  the denyWrite above is what holds.
- **Network**: strict allowlist, refused rather than prompted
  (`strictAllowlist`, honoured from `--settings`). Only the npm registry
  (bun and npm install from it) and github.com. Add a host only when a
  test proves it is needed.

Never used: `dangerouslyDisableSandbox`, `excludedCommands`,
`enableWeakerNestedSandbox`, `allowAllUnixSockets`, `allowLocalBinding`,
`filesystem.disabled`. A gate test asserts none appears.

Scope: write tier only. `ReadOnlyExecutor` is unchanged (plan mode, no
`--settings`). Codex write runs are unchanged.

## 3. Availability and fallback

`probeSandbox` runs once at server startup:

1. `WISSEL_WRITE_SANDBOX=off` (or `0`/`false`): state `off`.
2. macOS: `on`. Other non-Linux platforms: `unavailable`.
3. Linux: `bwrap` and `socat` on PATH, then a real
   `bwrap --ro-bind / / --unshare-user --unshare-net true`. If that
   fails and `kernel.apparmor_restrict_unprivileged_userns` is 1, the
   problem names the AppArmor profile. A real run is the only reliable
   check: a profile file that exists but isn't loaded passes every
   static test and still fails.

`unavailable` is logged loudly at startup (`!!! write-tier sandbox:
UNAVAILABLE ...`, one line per problem with its fix) and shown on
`GET /version` as `writeSandbox: { state, problems }`. Write-tier runs
then use today's allowlist mode: no `--settings`, the same allowlist.
More denials, same boundary.

What can still go wrong:

- The preflight passes but claude's own check fails (for example a
  missing optional seccomp helper treated as required in a future
  version): with `failIfUnavailable` the run fails with claude's error,
  visibly, and never runs unsandboxed. Fix the host or set
  `WISSEL_WRITE_SANDBOX=off`.
- The host changes after startup (package removed): same as above until
  the next restart re-probes.
- `~/.claude` is read-denied for sandboxed commands. If Claude Code
  sourced its per-command shell snapshot from there inside the sandbox,
  every Bash call would fail; the docs' own `denyRead: ["~/"]` example
  implies it handles this, and `live-check:sandbox` (a) fails loudly if
  not. The fix would be an `allowRead` for `<config dir>/shell-snapshots`.
- A gate test that writes under `$HOME` fails inside the sandbox. None
  in test/ does today (no `homedir()` use); defaults like the task
  output dir log and continue on a write failure.

## 4. Denial counting

`commandKeys` (src/core/permission-denials.ts) split shell lines on
`|`, `&&`, `;` without respecting quotes, so `grep -rn "a(\|b(" src`
became junk keys like `Bash: mergedSha\`. That inflated every key count
and broke the "same refusal twice in a row" escalation (two wordings of
one grep looked like different needs).

`splitShell` is now quote-aware: single quotes literal, double quotes
keep `\` except before `"` `\` `$` and backtick, backslash escapes
outside quotes, `$(...)` and backticks stay in their word, redirections
and their targets are dropped, `(`/`)` split subshells. `bun -e` /
`node -e` key as `bun -e` whatever the code says.

Multi-line commands (card 7821db37, attempt 1): treating a newline as a
plain separator turned heredoc bodies into one key per line
(`cat > f <<'EOF'` with TypeScript inside gave `Bash: const m`,
`Bash: } return`, `Bash: //`) and shell keywords into programs
(`Bash: for`, `Bash: do sed`, `Bash: if`). Now:

- heredoc bodies (`<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, several per
  line) are skipped up to the line that is exactly the delimiter;
  `<<<` here-strings are redirects, not heredocs;
- `if then else elif fi while until do done esac { } ! [[ ]]` at the
  start of a command are dropped and the command after them is keyed
  (`do sed -n 1p` is `sed`); `for`/`select`/`case` header segments are
  skipped;
- case patterns (`a|b)`, `;; *)`) are dropped, `|` included;
- a "program" that isn't a name (`$CMD`, `*.ts`, `//`) gives no key.

Why not shell-quote: it returns operators as objects (`2>&1` becomes
`"2", {op: ">&"}, "1"`), expands `$VAR` against an env, and still needs
the same post-processing to drop redirects. The tokenizer is that
post-processing, about 100 lines, gate-tested
(test/permission-denials.test.ts) with the 16 commands of card 494f87d6.
Those fixtures were rebuilt from the card's evidence because the
implementing run couldn't read `~/.wissel/task-output/`;
`bun run denials:baseline --fixtures 494f87d6-cd76-4348-ad22-8785c066c49c`
prints the verbatim commands with old and new keys to check them.

## 5. Trace

The telemetry `result` event of every claude-cli run now carries
`denials` (the raw `permission_denials` count, not deduplicated) and
`sandbox: "on" | "off" | "unavailable"` (TaskResult.denials/.sandbox,
set in runClaude's `runFacts`). Readonly runs report `off`.

- Before: `bun run denials:baseline` (board + task output, since
  2026-10-03): raw, old-key and new-key medians.
- After: `bun run denials:baseline --telemetry --since 2026-10-17`:
  median raw denials per implementer run by sandbox state.

## 6. Steering

The four write-tier agents' `verificationContract` in
agents/manifest.yaml now ends with: read and search with Read, Grep and
Glob; edit with Edit and Write, never `sed -i` or redirects; run
`bun test` / `bun run typecheck` plain (no pipes, `time`, redirects);
never `bun -e` / `node -e`. With the sandbox on, pipes would run anyway;
the steering is what keeps the allowlist fallback low too, and keeps
edits in the tools acceptEdits approves.

## 7. Project allow rules in worktrees

`claude -p` in a worktree prints "Ignoring 4 permissions.allow entries
from .claude/settings.json: this workspace has not been trusted" and
drops them. Decision: `readProjectAllowRules` (src/core/allowed-tools.ts)
reads `task.repo`'s `.claude/settings.json` `permissions.allow`, keeps
the rules that pass the same check as a per-card grant (`grantError`),
and WriteExecutor appends them to `--allowedTools`. Refused rules are
logged per run.

Not chosen: writing trust flags into `~/.claude/.claude.json` for every
worktree. That trusts everything the file holds (hooks, MCP servers,
any allow rule, unchecked), touches a file other sessions share, and
leaves state behind for every worktree.

Read from `task.repo` (the human-controlled main checkout), not the
worktree, so an agent editing the worktree's copy can't grant its own
next attempt anything.

## 8. What is still denied, and why

| Denied | By | Why |
|---|---|---|
| writes outside the worktree, `$TMPDIR` and extraAllowedDirs | sandbox (OS) | the worktree is the unit of review |
| writes to the main repo's `.git` (commit, stash, refs) | sandbox denyWrite + deny rules | landing is the merge path's job |
| reads of credentials, Claude/Codex profiles, the board db | sandbox denyRead | nothing a code task needs |
| network except registry.npmjs.org, github.com | sandbox strict allowlist | exfiltration |
| unsandboxed retries | `allowUnsandboxedCommands: false` | the sandbox is the boundary |
| `bun -e`, `node -e` in fallback mode | allowlist | arbitrary code, steered away |
| a leading `VAR=value`, `eval` | Claude Code sends these to the permission flow even in auto-allow | not on the allowlist |

Known side effect: `bun install` (only ever run through a per-card
grant) writes its package cache to `~/.bun/install/cache`, outside the
writable paths, so with the sandbox on it fails with a read-only error.
Fix when the first card needs it: set `BUN_INSTALL_CACHE_DIR` to the
sandbox's temp dir for write-tier runs (settings `env`), after checking
the temp path Claude Code's sandbox actually makes writable; not
`allowWrite: ["~/.bun"]`, which would let any run poison the shared
cache.

Not covered (unchanged from before): Claude's own Read/Edit/Write tools
follow permission rules, not `denyRead`. Readonly runs and codex runs
are not sandboxed.

## 9. Tests and evals

- Gate: test/write-sandbox.test.ts (settings, argv on/unavailable/off,
  readonly untouched, project rules, preflight probes mocked, manifest
  steering, telemetry), test/permission-denials.test.ts (tokenizer, the
  16 fixtures of card 494f87d6, the multi-line fixtures of card 7821db37), test/denials-baseline.test.ts, test/sandbox-checks.test.ts.
- Live: `bun run live-check:sandbox`, one real run asserting on what
  happened (tool results, filesystem, git), not on what the agent says.
- Eval: `bun run eval:sandbox-denials`, two real implementer tasks,
  pass bar `denials <= 1` per run.

## 10. Host setup (one time, needs sudo)

See README "One-time host setup". On this host (Ubuntu 24.04,
`kernel.apparmor_restrict_unprivileged_userns=1`): install socat (bwrap
is already there), add `/etc/apparmor.d/bwrap`, reload AppArmor,
restart the server.
