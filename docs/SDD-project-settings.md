# SDD: Per-project execution settings

Status: storage and API shipped. `verification` is consumed by the
write tier (§7, shipped 2026-10-19). Remaining consumers: sandbox
domains, worktree setup, protected paths (one card each).

## 1. Why

Wissel assumes its target repo is Bun/TypeScript:

- the sandbox network allowlist is fixed to `registry.npmjs.org` and
  `github.com` (`SANDBOX_ALLOWED_DOMAINS`, `src/executors/sandbox.ts`);
- the implementer's verification contract and `BASE_ALLOWED_TOOLS` are
  `bun test` / `bun run typecheck` (`agents/manifest.yaml`,
  `src/executors/write.ts`);
- a new worktree only gets `node_modules` symlinked
  (`linkNodeModules`, `src/services/worktree.ts`).

finn-platform (uv, FastAPI, SQLAlchemy, pytest, ruff, pyright, plus
Terraform; `~/code/mash/finn-sdd.html`) needs PyPI and HashiCorp hosts,
`uv run pytest` style checks, a `uv sync` per worktree, and paths agents
must not touch. This card gives those one home on `Project`. It changes
no run behaviour.

## 2. Model

Optional fields on `Project` (`src/core/types.ts`):

| Field | Type | Meaning (for the consuming card) |
| --- | --- | --- |
| `sandboxAllowedDomains` | `string[]` | Added to `SANDBOX_ALLOWED_DOMAINS` |
| `verification` | `{ commands: string[][]; allowedTools: string[] }` | Argv the implementer must run, and the command-scoped Bash grants that let it |
| `worktreeSetup` | `string[][]` | Argv run once in a new worktree |
| `protectedPaths` | `string[]` | Repo-relative globs agents may not modify |

Absent means today's behaviour. A project with none set serialises
exactly as before (no keys, not `null`s).

## 3. Storage

Four nullable `TEXT` columns on `projects`, same names, JSON-encoded.
Added by `SqliteProjectStore`'s constructor with the same
`ALTER TABLE ... ADD COLUMN` try/catch the `mergeGate` migration uses. No
seed: an existing project opens with none set. An empty list, or a
`verification` with no commands and no tools, is stored as `NULL`, so
"set to nothing" and "never set" read back identically.

`ProjectStore.setSettings(id, patch)` writes only the keys in the patch;
`null` clears. Throws on an unknown id.

## 4. API

`POST /projects/:id/settings`, partial JSON body. Validated by
`validateProjectSettings` (`src/services/project-settings.ts`); the first
problem is a 400 `{ error }` naming the field, and nothing is written.
404 on an unknown project. Returns the updated project. `GET /projects`
returns the fields.

Rules:

- Unknown top-level keys, and unknown `verification` fields, are refused
  (a typo must not silently do nothing).
- `sandboxAllowedDomains`: at most 20, each a bare lowercase hostname
  with at least two labels (`pypi.org`), optionally `*.`-prefixed with
  at least two labels after (`*.pythonhosted.org`). Refused: `*`, `*.*`,
  `*.org` (wildcard-all), schemes, ports, paths, single labels
  (`localhost`), uppercase.
- `verification.commands`, `worktreeSetup`: lists of non-empty argv
  arrays of non-empty strings, at most 20 commands.
- `verification.allowedTools`: at most 12 (`MAX_EXTRA_ALLOWED_TOOLS`),
  each passing `grantError` (`src/core/allowed-tools.ts`), the same
  check a per-card `extraAllowedTools` grant gets. Both `commands` and
  `allowedTools` are required when `verification` is set.
- `protectedPaths`: at most 50, non-empty, relative (no leading `/`,
  `~`, or drive letter), forward slashes only, no `..` segment.
- Duplicates are dropped, order kept.

Example (finn-platform):

```json
{
  "sandboxAllowedDomains": ["pypi.org", "files.pythonhosted.org", "*.hashicorp.com"],
  "verification": {
    "commands": [["uv", "run", "pytest"], ["uv", "run", "ruff", "check"], ["terraform", "validate"]],
    "allowedTools": ["Bash(uv run pytest:*)", "Bash(uv run ruff:*)", "Bash(terraform validate)"]
  },
  "worktreeSetup": [["uv", "sync"]],
  "protectedPaths": ["infra/prod/**", ".github/workflows/*.yml"]
}
```

## 5. Where it breaks

- The settings are read from the board DB, which a human controls;
  agents have no route to them. A consuming card must read them from
  `ProjectStore`, never from a file in the worktree.
- Validation is syntactic. `pypi.org` passing doesn't mean the host is
  safe to allow; `allowedTools` passing `grantError` is the same bar a
  per-card grant meets, no higher.
- Globs in `protectedPaths` aren't compiled here; a malformed glob is
  only caught when the protected-paths card uses it.

## 6. Tests

`test/project-settings.test.ts` (gate, no network): validation accept
and refuse cases, store/read/patch/clear, migration of a DB without the
columns, serialisation of a project with none set, and the route
(set, 400s, clear, 404, `GET /projects`).

No eval: this card is deterministic storage and validation with no LLM
step.

## 7. Write tier: verification contract and allowed tools

The write-tier executors read `verification` per run and use it in two
places that must agree: what the prompt tells the agent to run, and
what `--allowedTools` lets it run.

### 7.1 Lookup

`ProjectStore.settingsFor(repo)` (`src/services/projects.ts`) returns
the set settings of the project registered at `repo`, by resolved path
like `mergeGateFor`: `{}` for a project with none set, undefined for an
unregistered path. `WriteExecutor` and `CodexWriteExecutor` take it as
`settingsFor` (wired by `createApp`, `src/api/server.ts`) and call it
with `task.repo`, the human-controlled checkout, never the worktree, so
an agent cannot grant its own next attempt anything by editing a file.
Looked up per run, so an edit takes effect without a restart.

### 7.2 Prompt

The write-tier contracts in `agents/manifest.yaml` carry two tokens,
rendered by `renderVerificationContract` (`src/core/verification.ts`)
inside `buildAgentPrompt`:

| Token | Where | Renders to |
| --- | --- | --- |
| `{{verification.run}}` | implementer | "Before reporting done, run each of these as a plain command (no pipes, no redirects):" then one command per line, then: fix and re-run all until every one is green, say so if a failure is pre-existing. |
| `{{verification.commands}}` | implementer, fixer, integrator, lint-fixer | The commands as an inline list, `` `uv run pytest`, `uv run ruff check` and `uv run pyright` ``, inside the manifest's own "Run ... as plain commands: no pipes, no `time`, no redirects." |

The git rule (never `git add`/`commit`/`push`) and the tool steering
stay in the manifest, unchanged, around the tokens. A contract with no
token (every readonly agent) is untouched whatever the project says.

**No setting means today's bytes.** With no `verification`, each token
renders to the literal text the manifest carried before the tokens
existed (`DEFAULT_RUN_BLOCK`, `DEFAULT_COMMANDS_INLINE`), including the
line wrap between "and" and `` `bun run typecheck` ``. The literal is
pinned in `test/prompt.test.ts` against the real manifest. An explicit
setting equal to the bun pair renders the generated wording, not the
literal; only "unset" is byte-identical.

An argv word with whitespace or shell characters is single-quoted
(`pytest -k 'not slow'`). A `verification` with grants but no commands
(allowed by §4) renders "This project has no verification commands
configured. ..." and "the project's verification commands", never an
empty list.

Any other `{{...}}` in a `verificationContract` fails `Registry.from`
at load, so a typo never reaches a paid prompt as literal braces.

### 7.3 Allowed tools

`BASE_ALLOWED_TOOLS` (`src/executors/write.ts`) is now
`DEFAULT_VERIFICATION.allowedTools`, the bun pair. When the project has
`verification`, its `allowedTools` are the base instead; the pair is not
added. Card grants (`extraAllowedTools`) and the repo's own
`.claude/settings.json` allow rules follow as before. Codex has no
`--allowedTools`, so `CodexWriteExecutor` uses only the `commands` half.

Example, finn-platform:

```
--allowedTools "Bash(uv run pytest:*)" "Bash(uv run ruff check:*)" "Bash(uv run pyright:*)"
```

and the implementer's prompt ends with the uv commands, the git rule,
and "Run `uv run pytest`, `uv run ruff check` and `uv run pyright` as
plain commands: no pipes, no `time`, no redirects."

### 7.4 Where it breaks

- `commands` and `allowedTools` are validated separately (§4). A command
  the grants don't cover (`["uv","run","pytest"]` with only
  `Bash(uv run ruff:*)`) is accepted and the agent is refused at run
  time, exactly as a missing card grant is today: it shows up as a
  denial, the reviewer can propose a grant. Nothing cross-checks the
  two.
- The default's byte-identity is pinned to the manifest text; editing
  the implementer's git paragraph or the steering sentence is a
  deliberate prompt change and updates the pinned literal in
  `test/prompt.test.ts`.
- The lookup is by registered project path. A card whose `repo` is a
  path nobody registered as a project gets the bun defaults.

### 7.5 Tests

Gate, no network: `test/verification.test.ts` (rendering, formatting,
unknown-token load failure, the real manifest's token placement),
`test/prompt.test.ts` (byte-identity of the default for all four
write-tier agents, rendering with a setting, readonly agents untouched,
zero commands), `test/write-executor.test.ts` and
`test/codex-write.test.ts` (`settingsFor` reaches `--allowedTools` and
the prompt; no setting is identical argv; lookup by `task.repo`),
`test/project-settings.test.ts` (`settingsFor` round trip; a
uv/ruff/pyright/pytest setting passes the same checks as a per-card
grant, `uv run pytest` accepted, `python` refused).

No new eval: the periodic sandbox eval (`bun run eval:sandbox-denials`)
runs the real implementer contract on a Bun fixture repo and so covers
the default path; a Python fixture repo for the custom path is the
natural follow-up once finn-platform exists to copy from.
