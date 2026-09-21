# SDD — Manual enable/disable for execution harnesses

Status: **Built and verified live**, not just by unit test. A real
`node --check` pass on the extracted inline script, a real Playwright
run (open/close/render, no mutation — see §10) against a real Chromium
(this build environment's own `playwright.config.ts`-pinned binary
wasn't present in the sandbox this was built in — pointed at a
different locally-cached Chromium just for that one verification run,
then reverted the config back; a normal environment with the pinned
binary needs no such substitution), and — because this feature's whole
point is mutating a real file
correctly — a live round trip against the actual running dev server and
the actual `harnesses.yaml`: disabled `codex-personal` via the real
`POST /harnesses/:id/disable`, confirmed the file and live pool both
updated with every comment preserved, then re-enabled it through the
real `POST /harnesses/:id/enable` (which really re-ran `codex login
status` against the real installed binary), confirmed it succeeded and
the file came back byte-identical to before. Separately confirmed the
refusal path live too: attempting to enable `claude-personal` (genuinely
not authenticated on this machine) returned 409 and left the file
untouched. One real bug found and fixed before any of this shipped —
see §5's note on `seq.flow`.

## 1. Goal

Let a human turn a harness off (so wissel stops picking it for new
work) or back on, from the board — not just have `enabled` be something
only auto-discovery/`harnesses.yaml` computes at startup. Today
`Harness.enabled` is entirely derived: discovery sets it `true`,
`validateHarness` flips it `false` on an auth failure, and a
`harnesses.yaml` entry can pin it either way — but nothing lets a human
say "actually, don't use `claude-adevinta` for the next hour" without
hand-editing a YAML file and restarting the server.

## 2. This crosses a decision you made deliberately — resolved, not guessed

`51904ff` ("Hide disabled harnesses from the strip instead of
dimming them") is on record as *"Milton's call: the strip should only
show what's discovered and available, not every configured-but-unusable
entry."* A toggle needs disabled harnesses visible somewhere so they can
be turned back on — which cuts against that.

**Confirmed with you**: the glance strip stays exactly as it is today,
`51904ff` untouched. Enable/disable lives in a separate **"Manage
harnesses" panel** — every harness (enabled, manually disabled, or
auth-failed), each with a toggle. The strip keeps answering "what's
usable right now, at a glance"; the panel answers "what's configured,
and can I change that."

## 3. What I looked at

`src/core/types.ts` (`Harness`), `src/core/harness-pool.ts`
(`HarnessPool` — `all()`/`get()`/`acquire()`, all read-only against an
in-memory `Map` built once at startup), `src/core/harness-discovery.ts`
(`discoverHarnesses`, `discoverCodexHarnesses`, `discoverApiKeyHarnesses`,
`validateHarness` — the existing re-verify-don't-trust pattern this
reuses), `harnesses.yaml` itself (the existing "override layer" —
comments explaining a manual entry with a matching id already wins over
a discovered one), `src/api/server.ts` (`GET /harnesses`, already
returns every harness including disabled ones — only the UI filters;
the REST-verb-per-action convention `/tasks/:id/merge`,
`/tasks/:id/discard` already establishes), `src/api/public/board.html`'s
`renderHarnessStrip()` and the task drawer's slide-in overlay pattern
(`#drawerOverlay`/`#taskDrawer`, reused here rather than inventing a new
UI mechanism), `test/api.test.ts` (the `createApp` + real `Request`
testing convention this SDD's endpoint tests will follow), and `git show
51904ff` in full for the quoted rationale above.

**Verified live, not assumed**: the `yaml` package (already a dependency,
`^2.5.0`) can mutate a single field of a parsed document and
re-serialize it while preserving every comment and the rest of the
formatting untouched — confirmed with a real round-trip against a
`harnesses.yaml`-shaped fixture (header comment, an inline comment on
one `env` entry) before designing §5 around it. Also confirmed
appending a brand-new entry to the `harnesses:` sequence produces valid,
correctly-indented YAML. This is what makes "persist to
`harnesses.yaml` itself" a real option rather than a fragile one.

## 4. Data model: `Harness.disabledReason`

```ts
export interface Harness {
  id: string;
  tool: HarnessTool;
  label: string;
  enabled: boolean;
  env?: Record<string, string>;
  apiKeyEnv?: string;
  /** Why `enabled` is false, when it's false for a reason other than a
   *  human's own choice — e.g. "not authenticated" (set by
   *  validateHarness/discovery). Undefined when enabled is true, OR
   *  when a human explicitly disabled it themselves (see §6) — the
   *  "Manage harnesses" panel needs to tell "disabled because you
   *  turned it off" apart from "disabled because it can't work right
   *  now" without guessing from context. */
  disabledReason?: string;
}
```

`discoverHarnesses`/`discoverCodexHarnesses` never set this (they only
ever return already-authenticated candidates — nothing to explain).
`validateHarness` sets `disabledReason: "not authenticated"` on its
existing `{ ...harness, enabled: false }` returns (§6 — three call
sites, one line each). A human's manual disable (§6) leaves it
`undefined` — the panel's own copy for that state is just "disabled by
you," no field needed for something the human just did themselves.

## 5. Persistence: `harnesses.yaml` is still the source of truth

New file, `src/core/harness-manifest.ts`:

```ts
/** Reads harnesses.yaml as text (or starts from an empty `harnesses:
 *  []` doc if the file doesn't exist — same "no manifest is a valid
 *  starting point" contract HarnessPool.autoload() already has),
 *  finds-or-creates the entry for `harness.id`, sets its `enabled`
 *  (and clears `disabledReason` on enable — a human's own choice
 *  overrides whatever auto-diagnosis was there before), and writes
 *  the file back — preserving every comment and unrelated entry
 *  byte-for-byte (verified live, §3). A harness that only ever existed
 *  via auto-discovery gets promoted into an explicit entry the first
 *  time it's toggled (its id/tool/label/env copied in) — after that
 *  it's an override like any hand-written one, same precedent
 *  harnesses.yaml's own header comment already documents for
 *  claude-personal. */
export async function setHarnessEnabled(
  path: string,
  harness: Harness,
  enabled: boolean,
): Promise<void>
```

Implementation shape: `YAML.parseDocument(existingTextOrEmpty)`, find the
seq item whose `id` matches (`doc.getIn(["harnesses"]).items.find(...)`),
`.set("enabled", enabled)` / `.delete("disabledReason")` on it if found;
otherwise `seq.add(doc.createNode({...harness, enabled}))` to append a
new entry. `doc.toString()` back to the file. Every step here already
verified live against realistic fixtures (§3) — no live-CLI-style
uncertainty the way the `codex-cli` SDD had; this is deterministic
library behavior, confirmed once, not per-call.

**Real bug found building this, not just a theoretical edge case**: the
"promote a new entry into a missing/empty file" path initially produced
technically-valid but ugly flow-style YAML (`harnesses: [ { id: ... } ]`
on one line) instead of a normal block list — `yaml`'s freshly-created
empty seq defaults to flow style, and appending to it keeps that style.
Fixed by forcing `seq.flow = false` before appending whenever the seq
starts empty; every fixture in §10 (including the missing-file case) now
produces clean block-style output, confirmed both by test and by parsing
the result back to make sure it's not just pretty, it's correct.

## 6. Re-validation on enable, never on disable

Disabling is always safe — no re-check needed, just persist + update
memory (§7). **Enabling re-runs the same tool-specific auth check
`validateHarness` already does** before actually flipping the bit:

- `claude-cli` → `checkClaudeCliAuth` under the harness's own `env`.
- `codex-cli` → `checkCodexCliAuth` under the harness's own `env`.
- `anthropic-api` → the same "is `apiKeyEnv` actually set" presence
  check `discoverApiKeyHarnesses`/`validateHarness` already use.

A harness that's still not actually usable (logged out, key unset)
**refuses the enable** with a clear `409` (`"still not authenticated:
<detail>"`) instead of flipping `enabled: true` on something that would
just fail the moment a task tries to use it — same "never trust at face
value" discipline `validateHarness`'s own doc comment already states.
`disabledReason` is left as whatever it was (still explains why it's
still off) when an enable attempt fails this check.

`POST /harnesses/:id/enable` needs a `CommandRunner` for this — new
`CreateAppOptions.harnessRunner?: CommandRunner` (defaults `runViaBun`,
same injection point pattern every other service call in `server.ts`
already uses), so tests never spawn a real `claude`/`codex` process.

## 7. In-memory update: `HarnessPool.setEnabled`

```ts
/** Mutates the live pool's copy of a harness in place — the enable/
 *  disable endpoints' in-memory half, so a toggle is visible
 *  immediately, without a restart. Persistence to harnesses.yaml (§5)
 *  is the OTHER half — always done first, so a failed disk write never
 *  leaves memory and disk disagreeing about which one's the truth. */
setEnabled(id: string, enabled: boolean, disabledReason?: string): Harness | undefined
```

Ordering inside the endpoint handler: (1) for enable, re-validate (§6),
refuse on failure before touching anything; (2) `setHarnessEnabled()`
persists to disk; (3) `harnesses.setEnabled()` updates the live pool.
Disabling an already-acquired (in-flight) harness doesn't interrupt
whatever's currently running under it — `acquire()`/`release()` only
consult `enabled` for the *next* pick, exactly the same "disable means
don't route new work here, not kill what's running" behavior the pool
already has for an auth-failed harness today. Not a gap, the same
existing contract, just now human-triggerable.

## 8. Endpoints

- **`POST /harnesses/:id/enable`** — §6/§7's flow. `404` unknown id,
  `409` with a clear message if still not authenticated.
- **`POST /harnesses/:id/disable`** — persist + update memory, no
  re-validation. `404` unknown id.

Mirrors the existing `/tasks/:id/merge` / `/tasks/:id/discard` pairing
exactly — paired opposite actions, not a single generic
`PATCH {enabled}` body, for consistency with how every other mutating
action in this API is already named.

## 9. UI: a panel, not a strip change

A small "Manage" control next to the existing `.harness-strip` (the
strip's own markup and `renderHarnessStrip()` are untouched — §2).
Clicking it opens a slide-in panel reusing the task drawer's existing
overlay mechanism (`#drawerOverlay`-style transform/transition,
`requestAnimationFrame` open sequencing) rather than inventing a second
one — same visual language, same code shape, less new CSS.

Panel body: one row per harness from the existing `GET /harnesses`
response (already includes disabled ones — only the strip ever filtered
them, confirmed in §3), each showing `label`, `tool`, an enabled/disabled
state, `disabledReason` when present ("not authenticated" vs blank for
"disabled by you"), and a toggle button that calls
`POST /harnesses/:id/enable` or `/disable` and re-fetches the list.
Considered a third top-level tab (`data-view="harnesses"`, alongside
Board/New task) instead — rejected: harness management is an
infrequent, admin-shaped action, not something that earns permanent nav
real estate the way the two daily-use views do.

## 10. Testing plan

- `test/harness-manifest.test.ts` — pure string-in/string-out tests for
  the YAML transform (toggling an existing entry preserves comments and
  every other entry byte-for-byte; appending a new entry for a
  discovery-only harness produces valid, correctly-nested YAML; a
  missing file starts from an empty `harnesses: []` doc) plus a thin
  real-tmpfile test for the read/write wrapper itself, mirroring
  `harness-discovery.test.ts`'s `fakeHome()`-style real-tmpdir
  convention (a real file, not a mocked one — the whole point being
  verified round-trip behavior, same reasoning as §3's live check).
- `test/harness-pool.test.ts` — `setEnabled` mutates `all()`'s output
  and is visible to a subsequent `acquire()`, disabling excludes a
  harness from `acquire()` without disturbing an already-acquired one's
  `activeCount`.
- `test/api.test.ts` — `POST /harnesses/:id/enable`/`/disable` against
  an injected fake `harnessRunner`: success path (updates `GET
  /harnesses`'s response), 404 on unknown id, 409-with-message when
  enable's re-validation fails, and that `disabledReason` clears on a
  successful enable but survives a failed one.
- No real `claude`/`codex` process, and no real `harnesses.yaml`
  mutation, in any test except the one deliberate real-tmpfile
  round-trip test called out above.

## 11. Phased implementation plan

Small enough for one phase, unlike the harness-tool SDDs — no live-CLI
uncertainty to spike first, the one real fork was already resolved
(§2), and the YAML mechanism is already verified (§3/§5).

- `Harness.disabledReason` (`types.ts`); `validateHarness`'s three
  disable sites set it (`harness-discovery.ts`).
- `src/core/harness-manifest.ts` (`setHarnessEnabled`).
- `HarnessPool.setEnabled` (`harness-pool.ts`).
- `POST /harnesses/:id/enable` / `/disable` + `CreateAppOptions.harnessRunner`
  (`server.ts`).
- `board.html`: "Manage" control + slide-in panel (§9). No change to
  `renderHarnessStrip()` itself.
- Tests per §10, same commit, per house rule.

## 12. What I need from you

§2's fork is resolved. Nothing else here blocks starting — confirm
you're good with the shape above (§4–§9) and I'll build it.
