# SDD: Per-project execution settings

Status: storage and API shipped (this card). Consumers: the next four
cards (sandbox domains, verification contract, worktree setup,
protected paths). Worktree setup is built: `worktreeSetup` runs once in
each new worktree, see docs/SDD-worktree-isolation.md §8.

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
