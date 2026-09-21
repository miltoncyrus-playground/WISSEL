# SDD — Let wissel report which version/commit it's running

Status: **Built and verified.** Implementer wrote the code + tests under
a permission mode with no Bash access, so couldn't run them itself —
verified independently afterward: `bun run typecheck` clean, `bun test
test/` 209/209 pass (no regressions), `bun run src/cli.ts --version`
spot-checked for real output. Reviewer independently ran the same suite
against the worktree and reached the same result. `bun run test:e2e`
(the new version-badge assertion) still needs a real run before merge.

## 1. Why

There is zero version/build tracking anywhere in wissel: `package.json`
`"version": "0.0.0"` is a static placeholder never read from `src/`, no
git tags, no CHANGELOG, no CI, no Dockerfile or build step — wissel runs
straight from source via Bun. `/health` (`src/api/server.ts`) returns a
bare `"ok"`, `src/cli.ts` has no `--version`, and startup logging never
prints any code identity. When something looks wrong in production
there's no way to answer "which commit is this, actually" without SSHing
in and running `git log` by hand.

## 2. The one real design decision: snapshot at startup, not a live check

Because wissel runs straight from source with no build/copy step,
"version" could mean either (1) what's on disk right now, or (2) what
this running process actually loaded. These diverge the moment someone
`git pull`s without restarting — a live git check on every `/version`
call would report the new commit as running even though the old code is
still executing in memory.

**Decision: snapshot the git identity once, at process startup (first
call, memoized), and serve that cached value for the process's entire
lifetime.** Under `bun run --watch`, this is still correct: Bun's
watcher fully restarts the process (and every module, including the
memoized cache) on any file change, so the snapshot re-taken on restart
is never stale.

## 3. Version resolution — `src/core/version.ts`

```ts
export interface VersionInfo {
  commit: string;
  commitShort: string;
  branch: string;
  dirty: boolean;
  packageVersion: string;
  startedAt: string;
}

export function computeVersionInfo(repoRoot: string): VersionInfo
export function getVersionInfo(): VersionInfo
```

- `computeVersionInfo(repoRoot)` is the unmemoized, injectable-root
  worker — resolves git info via `Bun.spawnSync(["git", "rev-parse",
  "HEAD"])`, `["git", "rev-parse", "--abbrev-ref", "HEAD"]`, and `["git",
  "status", "--porcelain"]`, all with `cwd: repoRoot`. Exists as a
  separate export purely so tests can point it at a throwaway directory
  without fighting the module-level cache.
- `getVersionInfo()` is what every real call site uses: computes once
  (`findRepoRoot(import.meta.dir)`, walking up until a directory
  containing `package.json` is found — deliberately not
  `process.cwd()`, since wissel can be invoked from anywhere) and caches
  the result for the process's lifetime (§2).
- `packageVersion` is read via a static `import packageJson from
  "../../package.json"` (Bun supports JSON imports at runtime;
  `tsconfig.json` gained `resolveJsonModule: true` so `tsc --noEmit`
  accepts it too), not `readFile` — no async needed for a value that
  never changes at runtime.
- **Override hook**: if `WISSEL_COMMIT` is set, it's used verbatim for
  *both* `commit` and `commitShort` (matches the planner's spec exactly
  — useful for a CI/deploy pipeline that already knows the exact
  identifier it wants surfaced, short or long), skipping the git calls
  for those two fields entirely. `branch`/`dirty` are still
  git-resolved even when the override is set, since the override is
  about identifying *which commit*, not about suppressing the rest of
  the picture.
- **Never throws.** A missing `git` binary, or a `repoRoot` that isn't a
  git repo at all (e.g. some future packaged/tarball install), falls
  back to `"unknown"` for `commit`/`commitShort`/`branch` and `dirty:
  false`, plus exactly one `console.warn` — this is purely informational
  data, so a broken git lookup should never be able to take the process
  down with it.

## 4. `GET /version`

`src/api/server.ts`, right next to `/health`:

```ts
if (url.pathname === "/version") return json(getVersionInfo());
```

No auth — same as `/health`, and nothing in `VersionInfo` is sensitive
(it's the same information `git log`/`git status` on the checked-out
tree already exposes to anyone with filesystem access).

## 5. CLI: `wissel --version` / `-v`

`src/cli.ts` gains a case in the top-level `switch (command)`:

```
wissel --version
wissel -v
```

prints:

```
wissel <commitShort>[+dirty] (<branch>, pkg <packageVersion>)
```

e.g. `wissel a1b2c3d+dirty (main, pkg 0.0.0)`. Also wired into
`package.json` as `bun run version`, matching the existing
`agents`/`why`/`team` script convention, and added to the CLI's own
usage message so `wissel <anything-unrecognized>` advertises it.

## 6. Startup log line

`src/api/server.ts`, inside the `import.meta.main` block, right after
the existing `wissel board api on :${port}` line:

```
version: <commitShort>[+dirty] (<branch>)
```

This only runs at the real process entrypoint (`bun run dev` / `bun run
serve`), so it can't be covered by `test/api.test.ts`'s `createApp()`
harness — needs a manual check (start the server, confirm the line
appears) rather than automated coverage.

## 7. Board badge

`src/api/public/board.html`: a small `<p class="version-badge"
id="versionBadge">` in the header, right after the existing `.lede`
paragraph, styled subtly in muted monospace to match the
`.eyebrow`/`.lede` conventions rather than calling attention to itself.
Populated on page load via `fetch("/version")`:

- Visible text: `wissel <commitShort>` (+ ` (dirty)` when applicable) —
  short, glanceable.
- `title` attribute: the full commit, dirty state, branch, and package
  version — available on hover for whoever actually needs to
  double-check the exact identity, without cluttering the header for
  everyone else.

## 8. Docs

`README.md` gains a short paragraph (after the harness enable/disable
section) documenting `GET /version`, `wissel --version`/`-v`, the
startup log line, and the board badge, plus a `bun run version` line in
the top command block.

## 9. Testing plan

- **`test/version.test.ts`**: happy path against this real repo
  (`commit` is 40-char hex, `commitShort` is its first 7 chars,
  `packageVersion === "0.0.0"`); fallback path (a fresh `mkdtemp` dir
  with no `.git` → every field `"unknown"`/`dirty: false`, no throw);
  dirty path (a real temp git repo — one commit, then an uncommitted
  edit — `dirty` flips `false` → `true` across the two calls, same
  `commit` both times); `WISSEL_COMMIT` override wins over the
  git-resolved commit for both `commit` and `commitShort`; and
  `getVersionInfo()` called twice returns the exact same object
  reference (proof of memoization).
- **`test/api.test.ts`**: `GET /version` asserted on shape/types only
  (`typeof body.commit === "string"`, `typeof body.dirty === "boolean"`,
  `body.packageVersion === "0.0.0"`) — never the literal SHA, which
  would flake on every commit made after this one.
- **`test/cli.test.ts`** (new file): spawns the real CLI as a
  subprocess for both `--version` and `-v`, asserting the `wissel `
  prefix and `pkg 0.0.0` suffix loosely, plus that the no-args usage
  message mentions `--version` — avoids coupling to the exact SHA this
  repo happens to be on when the test runs.
- **`e2e/board.spec.ts`**: `#versionBadge` is visible on `/board`, its
  text contains `wissel `, and its `title` attribute contains `pkg
  0.0.0` — proves the real fetch-and-render wiring works against a live
  server, not just that the markup exists.

## 10. Known gaps

- **Startup log line (§6) has no automated coverage** — it only runs
  under `import.meta.main`, which `createApp()`'s test harness
  deliberately never exercises (same reason none of the other
  `import.meta.main`-guarded startup logging has tests either). Needs a
  manual check: run `bun run serve`, confirm the `version: ...` line
  appears.
- **No CI.** `bun test`/`bun run typecheck` are now independently
  confirmed green (twice — once by direct verification, once by
  reviewer's own run), but there's nothing enforcing that on future
  changes; still manual.
- **`bun run test:e2e`'s new version-badge assertion hasn't been run
  yet** — the two checks above cover the unit/type-level work; the
  Playwright suite still needs a real pass before merge.
- **`dirty` reflects the whole repo's working tree, not just files under
  `src/`** — a stray edit anywhere in the checkout (docs, `.env`, an
  unrelated scratch file) marks the running process `+dirty` even though
  the code that's actually loaded is byte-identical to `HEAD`. Accepted:
  matching `git status --porcelain`'s literal definition of "dirty" is
  more honest than trying to scope it to "files that would affect
  runtime behavior," which would need its own maintained list.
