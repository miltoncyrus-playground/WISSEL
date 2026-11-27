# Coordinator phase 0: spike results

`docs/SDD-coordinator.md` §9 phase 0, run on 2026-11-27 against throwaway
test targets only:
- a new private test board;
- a new private test doc;
- transient systemd user units;
- read-only calls against the repository.

No live board was used and no live Wissel was touched. All of it was
read-only toward existing state except the two test targets created for
it.

## S1: who can write the channel

The question (HANDOVER-PACK.md §6 q1) was whether a server can write an
Artifact-backed decisions board, or whether every post needs a
short-lived session that has the artifact tools.

What was tried:
- A private test board was created: "Wissel S1 Test Board", with `db`
  holding the `log`, `ready` and `topics` collections.
- Each writer below was asked to post one `log` entry.
- Claude Code was version 2.1.332.

| Writer | Artifact database write | Claude Docs write |
|---|---|---|
| An interactive Claude Code session | **works** (`log/s1-session-write-1`, version 1) | works |
| A headless `claude -p` card run | **no tool**: neither `ArtifactData` nor `Artifact` is in the session | **works**: a scribe created a doc in 2 turns for $0.07 |
| The same, with the Remote Control bridge Wissel already opens for card runs | **no tool**: the bridge connected, and the tools were still absent | not tried; same connectors as above |
| A server with no Claude session | no documented API. The only way would be to hold a person's claude.ai token, which the house rules forbid (never read or cache a credential) | same |

**Result.** The lean assumed a scribe card could post to an Artifact
board. That is wrong today: a card run (`claude -p`) gets no artifact
tools at all. It does get the claude.ai connectors, and the Claude Docs
connector can create and edit a doc. A doc is itself an Artifact, so it
can be read and commented on from a phone.

**New lean, recorded in HANDOVER-PACK.md §6 q1:**

1. Wissel stays authoritative, and the channel mirrors it (§6 q4's lean).
   Every message is first a row in Wissel, in the outbox. The adapter only
   copies it out.
2. The adapter interface is `post(entry) → entryId` and
   `read(since) → entries`. It is batched per interval, and posts carry
   the full head sha where §4.9 asks for it. A direct server write, if one
   ever appears, becomes one more implementation of the same interface.
3. **The first adapter is a Claude Docs doc, written by a scribe card.**
   - It is one short `claude -p` run per batch.
   - Its only tools are `ToolSearch` and the Claude Docs tools it needs.
   - It works no repository.
   - It returns the ids of the blocks it wrote.
   - Cost is about $0.07 per run. At one batch every 15 minutes that is at
     most about $7 a day, and less when nothing is queued: an empty
     outbox starts no run.
4. The Artifact database board becomes optional: a mirror filled only
   while an interactive session is open. For example, an operator runs
   one command that drains the outbox with `ArtifactData`. Nothing in the
   loop may depend on it.
5. Add a start-up probe. On each Claude Code upgrade, check whether `claude
   -p` lists the artifact tools, and log the answer once. If it starts to,
   the Artifact board can become a scribe target again without a design
   change.

Left behind for inspection, both private to the owner:
- the test board, holding the one session-written entry;
- the test doc the scribe created.

Delete them when done.

## S2: code-host token scopes

Measured, read-only:
- The `gh` login used for this work carries a classic OAuth token with
  `gist`, `read:org`, `repo` and `workflow`. That is far more than the
  coordinator needs, and it is a person's login: every push and comment
  is attributed to them. This is exactly what identity phases 1 and 2
  warn about.
- On `miltoncyrus-playground/WISSEL`:
  - `allow_auto_merge` is false, so auto-merge cannot be turned on for any
    PR until a repository admin enables it.
  - `main` has no branch protection. Without a required check or review,
    a PR is immediately mergeable. GitHub then refuses to enable auto-merge
    ("clean status"), so auto-merge only means something once `main`
    requires the host gates.
  - Merge commits are allowed, which fits the house rule of updating by
    merging.

The minimum permissions below come from GitHub's permission model and
were not verified with a reduced token. Doing that needs the owner to
create a token or an App in a browser. They are per repository, for a
fine-grained token or a GitHub App installation:

| What Wissel does | Permission |
|---|---|
| Push a card's branch | Contents: read and write |
| Open, update and comment on a PR; read reviews | Pull requests: read and write |
| Turn on auto-merge (GraphQL `enablePullRequestAutoMerge`) | Contents and Pull requests, both read and write, plus the repository setting and a protection rule as above |
| Read check runs for the PR watcher | Checks: read; Commit statuses: read |
| Only if a card may change `.github/workflows/` | Workflows: read and write. Leave it off by default |
| Always | Metadata: read (implicit) |

There are two ways to give Wissel its own identity: a machine user or a
GitHub App.
- A machine user is a full account and takes a seat in an organisation.
- A GitHub App is installed per repository. It issues one-hour
  installation tokens, and commits and comments show as `<app>[bot]`.

Lean, as in §6 q3: one App per instance. Creating it is an owner action
in the browser, so it is not done here.

## S3: restart on exit code 75

The target is §4.12, restart when idle: the server exits 75 to ask its
supervisor for a restart.

The probe was a script that exits 75 on its first run and 0 on its
second. It was run under three transient `systemd-run --user` units and
under `bun run`.

| Setup | Runs | Restarted on 75? |
|---|---|---|
| `Restart=on-failure` (what `wissel.service` has today) | 2 | yes |
| `Restart=no` plus `RestartForceExitStatus=75` | 2 | yes |
| `Restart=on-failure` plus `SuccessExitStatus=75` | 1 | no |
| `bun run <script>` | n/a | the exit code passes through: `$?` is 75 |

The `serve` script is `build:editor && build:app && server`, so the
server's own exit code is what systemd sees.

**Result.** Under systemd it already works with today's unit. Two changes
for phase 1 card 5:
- Add `RestartForceExitStatus=75` to the unit. The restart then survives
  someone changing `Restart=`.
- Never list 75 in `SuccessExitStatus`.

Started by hand, `bun run serve` has no supervisor. Card 5 needs a small
wrapper that re-runs the server while it exits 75 and stops on any other
code. Without it, a hand-started board that asks for a restart simply
stops.

## Before phase 1

The three commits the coordinator spec builds on landed on `main` in #18:
- `97f3dca`: drop sandbox stubs before staging;
- `e32ebad`: review guard;
- `0ad0693`: the Needs a human and Next step lanes.

Phase 1 can start from `main`.
