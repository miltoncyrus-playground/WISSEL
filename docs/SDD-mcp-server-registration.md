# SDD — MCP servers: add-a-server UI + API

Status: **Built, this card.** Written per Milton's ask: he wants to add an
MCP server through the board UI's "Manage MCP servers" panel, and can't —
there's no way to today. Single-card scope: design and build in one pass.

## 1. Goal

A human can register a brand-new MCP server (stdio or sse/http) entirely
through the board UI — no hand-editing `mcp-servers.yaml`, no restart —
the same way Projects already lets someone register a new repo live. The
new server shows up immediately in the existing "Manage MCP servers"
panel (enable/disable, per-tool trust toggle — both unchanged, both
already work) and survives a process restart because it's been written
to `mcp-servers.yaml` for real.

Explicitly **not** a goal (see §5): a delete/remove endpoint, any change
to the existing enable/disable/trust-toggle behavior, or a real MCP
protocol handshake at registration time (§3.2 explains why).

## 2. What I looked at

- `mcp-servers.yaml` (repo root): `mcp-servers: []` today — zero real
  entries, just a commented-out schema example. Confirmed by reading the
  file directly.
- `src/core/mcp-server-pool.ts`: `McpServerPool` has `load`/`from` (bulk,
  read-only-at-startup), `all`/`get`/`activeCount`, `acquire`/`release`
  (concurrency bookkeeping), and `setEnabled`/`setToolTrust` (mutate an
  *existing* entry's in-memory copy). No method to insert a brand-new
  entry. Also here: `checkMcpServerReachable` — confirmed its exact
  current scope by reading it: for `stdio`, it only checks the named
  command exists on PATH (absolute path: `access(..., X_OK)`; bare
  command: walks `PATH` dirs) — it never spawns the process. For
  `sse`/`http`, it's a HEAD request with a timeout — any non-5xx status
  (even 404/405) counts as reachable; only a thrown network error or a
  5xx counts as not reachable. It does **not** perform a real MCP
  handshake (`initialize`/`tools/list`) anywhere.
- `src/core/mcp-manifest.ts`: `setMcpServerEnabled` and
  `setMcpServerToolTrust` — both read-patch-write-back an *existing*
  entry (or promote a pool-only entry that was never on disk). Both use
  the `yaml` package's `parseDocument`/Document-API round-trip
  specifically so hand-written comments/formatting in the file survive
  edits, not a parse+stringify rewrite. No "insert a new entry" function
  exists.
- `src/api/server.ts`: `GET /mcp-servers` (~line 512, list + live
  `activeCount`), `POST /mcp-servers/:id/{enable,disable}` (~line 516),
  `POST /mcp-servers/:id/tools/:tool/trust` (~line 548). No `POST
  /mcp-servers` (create).
- `src/api/public/board.html`: the "Manage MCP servers" panel (`#mcpPanel`,
  line 790) — `renderMcpPanel` (line 1836) lists registered servers with
  enable/disable + per-tool trust toggles. No "add a server" form
  anywhere in this panel.
- `docs/SDD-mcp-orchestration.md` §4's own revision callout (confirmed by
  reading it directly, lines 280-291): subtask 1 found "mirrors
  `/harnesses`'s own shape" and "`GET/POST/DELETE /mcp-servers`" were in
  tension — `/harnesses` itself has no create/delete endpoint, only `GET
  /harnesses` + `POST /harnesses/:id/{enable,disable,model}` — and
  followed the mirror literally, shipping GET+enable/disable only. A
  harness is addable only by hand-editing `harnesses.yaml` and
  restarting; this was a deliberate choice documented at the time, not an
  oversight this card is "fixing."
- `src/services/projects.ts` / `SqliteProjectStore`: the one config
  object in this codebase that **is** addable live, through the UI.
  `addLocalProject(path, opts, runner)` validates a real directory
  (`existsSync`/`statSync`) and a real git repo (`git rev-parse
  --is-inside-work-tree`, or `git init` if `initGit` is set) before
  inserting a row. `addGithubProject(url, opts, runner)` runs a real `git
  clone` and only inserts on success, deduping by normalized `sourceUrl`
  (a repeat call returns the existing row with `alreadyExists: true`
  instead of cloning twice). Both are backed by `POST /projects/local` /
  `POST /projects/clone`, with a real form in the Projects tab
  (`#projLocalForm`/`#projCloneForm`, board.html line 670/690,
  inline-error-rendering via a `.field-error` span next to the submit
  button).
- `test/projects.test.ts` / `test/api.test.ts` (the `/mcp-servers` tests,
  lines 300-450): confirmed the exact test shape both existing suites
  hold themselves to — real tmp fixtures, persistence round-trips
  checked by re-reading the YAML/re-querying the store, not just
  asserting on the in-memory return value.
- `e2e/projects.spec.ts` (lines 39-75): confirmed the e2e discipline this
  project holds itself to — `page.waitForResponse(...).request().postDataJSON()`
  asserted against the exact expected body, not just "the button is
  clickable."

## 3. Design decisions, stated plainly

**3.1 — Live UI/API-driven registration, mirroring Projects, not
harnesses.** The card names the real tension directly: harnesses are
addable only by hand-editing `harnesses.yaml` plus a restart, and MCP
orchestration subtask 1 deliberately followed that same precedent for
`/mcp-servers`'s *read* surface. But a harness and an MCP server are not
the same kind of thing to register. A harness just points at an
already-authenticated CLI account — "add a harness" is really "tell
wissel an account that already exists elsewhere is now available," and
there's no real validation to perform beyond a restart picking up the
new YAML block; the value of a UI form here would be close to zero (you'd
just be retyping YAML into text boxes). An MCP server is different: it's
a genuinely new, user-provided config object (a command to spawn, or a
URL to call) with no external "already exists, just needs enabling"
precondition — the exact same shape of object a Project is (`addLocalProject`/
`addGithubProject` both register a brand-new object the user is
describing for the first time, validating what can be validated before
persisting). That makes Projects the correct analog, not harnesses, and
it's also what Milton actually asked for: a way to add a server through
the panel, not a tutorial on which file to hand-edit. Decision: build the
live-add flow, modeled directly on `ProjectStore.addLocalProject`'s shape
(validate → persist → return the created row), not the "stays
YAML-and-restart" alternative.

**3.2 — Validation depth at registration time: reuse
`checkMcpServerReachable`'s existing scope, not a real MCP handshake.**
This is the genuinely hard part the card calls out, and it's a real
tradeoff, not a formality:

- **The handshake option** (open the transport for real — spawn the
  stdio process, or connect the sse/http endpoint, and perform a real
  `initialize`/`tools/list` round-trip) is the more honest check: it
  would catch a binary that's on PATH but doesn't speak MCP at all, or a
  URL that responds to HTTP but isn't a working MCP endpoint. But it adds
  real complexity directly in the request path of a *registration*
  endpoint: a synchronous process spawn (with its own timeout/cleanup
  discipline — a hung stdio server now hangs a `POST` instead of just a
  "not reachable yet" flag), a new MCP-client dependency this codebase
  doesn't otherwise have (`eval/fixtures/mcp-echo-server.ts` is a
  from-scratch, in-memory, eval-only fixture — see its own header comment
  for exactly why it's deliberately never a shared production dependency
  here), and a new failure mode to handle cleanly (a process that spawns
  but never responds to `initialize`).
- **The reachability-reuse option** (what this card ships):
  `checkMcpServerReachable` already exists, is already the exact check
  `POST /mcp-servers/:id/enable` re-runs before flipping a server back on
  (§2 above), and is deliberately conservative/cheap by design (command-
  on-PATH or a HEAD probe, no protocol speech). Reusing it at creation
  time means `POST /mcp-servers` holds the *same* invariant `/enable`
  already holds — "a server that is currently `enabled: true` has been
  confirmed reachable, at least once, by this exact check" — rather than
  a stronger, different invariant that only the create path would honor.
  One consistent contract for both endpoints, not two different ones.

Decision: **reuse `checkMcpServerReachable`'s current scope.** The
honest cost, stated plainly and not left implied: a `stdio` server whose
`command` is on PATH but isn't actually an MCP server (e.g. a typo'd
binary, or a real tool that just isn't an MCP implementation) will be
accepted at registration and only discovered broken the first time a real
task actually tries to call it. This is the identical limitation
`/enable` already carries today for the exact same check — not a new gap
this card introduces, just one it now also applies to creation. A real
handshake-at-registration is named explicitly in §5 as future work if
this limitation turns out to bite in practice.

**3.3 — A failed reachability check refuses creation entirely (no
"create it anyway, disabled" path).** Considered and rejected: silently
persisting an unreachable server as `enabled: false` would mean
`mcp-servers.yaml` could accumulate dead entries from typos with no
signal at submission time beyond a form field most people won't
double-check later. Projects' own precedent agrees: `addLocalProject`
and `addGithubProject` both refuse to insert a row at all when their own
validation fails (not-a-directory, failed clone) — there's no "add it
anyway, disabled" path there either. `POST /mcp-servers` matches that:
the reachability check runs before anything is persisted, a failure
returns `400` with the check's own reason text and writes nothing, and
the human sees the error inline on the form (same `.field-error`
rendering convention `#projLocalForm` already uses) and can fix the typo
immediately instead of discovering a silently-broken entry later.

**3.4 — Duplicate `id` is a 400, not a silent merge or an `alreadyExists`
200.** Unlike a Project (where `addGithubProject` dedupes by
`sourceUrl` — the same remote cloned twice is genuinely the same
project), an MCP server's `id` is a human-chosen label with no derivable
natural key to dedupe against. A second `POST /mcp-servers` reusing an
existing `id` is far more likely a mistake (fat-fingered copy-paste, or
genuinely trying to reconfigure an existing server) than an intentional
idempotent re-registration, so it 400s with a clear "already registered"
message rather than quietly overwriting or returning the old entry. If
reconfiguring an existing server via this endpoint turns out to be
wanted, that's new scope for a follow-up (an explicit `PATCH` or
re-register flow), not something this card should guess at silently.

## 4. Implementation shape

**`src/core/mcp-server-pool.ts`**:
- `McpServerPool.add(server: McpServer): McpServer` — in-memory insert,
  mirrors `from`'s own duplicate-id guard (throws on a collision; the
  caller, the `POST /mcp-servers` handler, already checked `get(id)` and
  400'd before ever reaching this, so a throw here is a caller bug, not a
  reachable runtime case — same contract `acquire`'s own "unknown id is a
  caller bug" doc comment already states for a different method).
- `parseMcpServerCreateInput(body): { server: Omit<McpServer,
  "disabledReason"> } | { error: string }` — pure, synchronous, no I/O.
  Validates `id`/`label` (non-empty strings), `transport` (tagged union:
  `kind: "stdio"` requires a non-empty `command` string and an optional
  `args: string[]`; `kind: "sse" | "http"` requires a non-empty `url`
  string), `tools` (optional array of `{name: string, trust?: "auto" |
  "approval-required"}`, defaulting an omitted `trust` to
  `"approval-required"` — the safer tier, requiring an explicit opt-in to
  `"auto"`), and `env` (optional record of string values — env var
  *names*, never secret values, same convention `Harness.env`/`apiKeyEnv`
  already hold). Returns a clear, field-specific `{ error }` for the
  first thing wrong, matching `POST /projects/local`'s "a bad body 400s
  with a clear message" discipline.

**`src/core/mcp-manifest.ts`**:
- `addMcpServer(path, server): Promise<void>` — same Document-API
  round-trip contract `setMcpServerEnabled`/`setMcpServerToolTrust`
  already hold (comments/formatting survive, empty-flow-seq guard,
  missing-file-reads-as-empty). Appends one brand-new entry. Guards
  against a same-`id` entry already present *on disk* (not just in the
  in-memory pool the endpoint already checked) — a defensive check for
  the narrow race where `mcp-servers.yaml` was hand-edited after the pool
  was last loaded — throwing loudly rather than writing a second,
  duplicate-`id` YAML entry that would make the *next* `McpServerPool.load()`
  throw at startup (`from`'s own duplicate-id guard).

**`src/api/server.ts`**: `POST /mcp-servers` (new, alongside the existing
`GET /mcp-servers` at line 512):
1. Parse the body through `parseMcpServerCreateInput`; a malformed shape
   400s immediately, nothing persisted.
2. `mcpServers.get(parsed.server.id)` already present → 400 ("already
   registered"), nothing persisted (§3.4).
3. `checkMcpServerReachable(parsed.server, mcpServerReachabilityOpts)` —
   same options plumbing `/enable` already uses. Not reachable → 400 with
   the check's own reason text, nothing persisted (§3.2/§3.3).
4. Reachable → `addMcpServer(mcpServersPath, parsed.server)` (disk),
   then `mcpServers.add(parsed.server)` (in-memory) — same "disk first,
   then the live pool" ordering `setEnabled`'s own handler already uses.
   Returns the created `McpServer` at `201`.

**`src/api/public/board.html`**: a new "Add MCP server" form inside
`#mcpPanel`, above the existing `#mcpList` (same subsection-above-list
layout `#projectsPanel` uses: add-forms first, registered-list below).
Mirrors `#projLocalForm`/`#projCloneForm`'s exact structure (a `<form>`
with `.field` groups, a `.form-actions` row holding a status span, a
`.field-error` span, and a submit button) rather than inventing new
markup conventions:
- Server id (text, required)
- Label (text, required)
- Transport kind: a `<select>` of `stdio` / `sse` / `http`, toggling
  which fields show next (mirrors how transport-kind-dependent fields
  need to render/hide — a small, local `change` handler, no new pattern
  needed beyond plain DOM show/hide already used elsewhere in this file)
  - `stdio`: command (text, required), args (text, comma-separated,
    optional — split/trim/filter-empty into `string[]` client-side)
  - `sse`/`http`: url (text, required)
- Tools: a repeatable small list — a name field + a trust `<select>`
  (`auto` / `approval-required`) per row, with an "Add tool" button
  appending another row and a per-row remove button; empty rows are
  filtered out client-side before building the submit body, so a user
  who adds zero tools (valid — `tools: []` is allowed) doesn't need to
  explicitly remove a blank placeholder row.
- Submits `POST /mcp-servers` with `{ id, label, transport, tools }`.
  **Revision callout:** this form does not expose `env` at all, even
  though `parseMcpServerCreateInput` accepts it (§4 above) — the card's
  acceptance criteria never required `env` in the UI, so it was left out
  of this form rather than built speculatively. A user who needs to
  register a server with env vars today has no UI path to set them; see
  §5's new bullet. Same success/error handling shape `projLocalForm`'s
  submit handler already uses: disable the submit
  button, show a "registering…" status span, on success clear the form
  and re-trigger the panel's existing `renderMcpPanel()`/refetch path, on
  failure render the endpoint's `{error}` text inline in the
  `.field-error` span.

## 5. What this deliberately does not do

- **No real MCP protocol handshake at registration time.** §3.2's
  explicit tradeoff: `POST /mcp-servers` only re-runs
  `checkMcpServerReachable`'s existing, deliberately cheap scope
  (command-on-PATH for stdio, an HTTP HEAD probe for sse/http) — never a
  real `initialize`/`tools/list` round-trip. A `stdio` command that's on
  PATH but isn't actually an MCP-speaking binary will be accepted here
  and only discovered broken the first time a real task tries to call
  it — the identical limitation `/enable` already carries for the same
  check, not a new one this card introduces. If this proves to be a real
  problem in practice, a handshake-based check is the natural follow-up,
  scoped as its own card (it needs a real MCP client dependency this
  codebase doesn't have yet — see §3.2's own reasoning for why that's
  more than this card's size).
- **No delete/remove endpoint.** Not asked for; not a byproduct of this
  design either (register-only, same as Projects' own `addLocalProject`/
  `addGithubProject` don't imply a delete path just because `delete`
  happens to already exist on `ProjectStore` for an unrelated reason).
- **No change to `GET /mcp-servers`, `POST /mcp-servers/:id/{enable,disable}`,
  or `POST /mcp-servers/:id/tools/:tool/trust`.** All three already work;
  none are touched by this card.
- **No reconfigure/update path for an already-registered server's
  transport or env.** A duplicate `id` is rejected (§3.4), not merged or
  overwritten. If "edit an existing server's command/url" is wanted
  later, that's new, separate scope.
- **No tool-name deduplication within a single registration.** Two tools
  named the same thing in one `POST /mcp-servers` body are both accepted
  as given — the existing `setToolTrust`/`McpServer.tools[].trust` model
  already assumes tool names are meaningful identifiers the *server*
  defines, not something this endpoint polices.
- **No `env` input in the "Add MCP server" form.** `parseMcpServerCreateInput`
  (§4) validates and accepts an optional `env` record end to end through
  the store layer, but the board.html form never collects it and the
  submit handler never sends it — the card's acceptance criteria didn't
  require exposing `env` through the UI, so it wasn't built. A server
  that needs env vars set can still be registered by hand-editing
  `mcp-servers.yaml` after this form creates the base entry, same as any
  other field this endpoint accepts but the form doesn't surface. Adding
  an env-rows UI (mirroring the existing tools-rows pattern) is the
  natural follow-up if this turns out to matter in practice.

## 6. Subtasks

Single-card scope — built as one unit, not decomposed further.

### 1. Store layer: `McpServerPool.add` + `parseMcpServerCreateInput` + `addMcpServer`
**Acceptance criteria**
- `parseMcpServerCreateInput` accepts a well-formed `stdio` entry and a
  well-formed `sse`/`http` entry, producing the expected `McpServer`
  shape (including the `trust` default for an omitted tool entry).
- `parseMcpServerCreateInput` rejects (clear `{error}`, not a throw): a
  missing `id`/`label`, a missing `transport`, a `stdio` transport
  missing `command`, an `sse`/`http` transport missing `url`, an unknown
  `transport.kind`, a non-array `tools`, and a tool with an invalid
  `trust` value.
- `McpServerPool.add` inserts a new entry visible via `.get`/`.all`
  afterward, and throws on a duplicate id.
- `addMcpServer` persists a new entry to a real tmp `mcp-servers.yaml`,
  verified by re-reading the file with `parse()` (not just trusting the
  in-memory return) — both for an empty starting file and a file that
  already has other entries (confirming the append doesn't clobber
  them).

### 2. API: `POST /mcp-servers`
**Acceptance criteria**
- A well-formed `stdio` body (command confirmed on PATH, e.g. `/bin/true`)
  returns `201` with the created server; a follow-up `GET /mcp-servers`
  includes it; `mcp-servers.yaml` round-trips the new entry through a
  fresh `McpServerPool.load()` of the same path.
- A well-formed `sse`/`http` body (mocked `fetchImpl` returning a 200)
  returns `201` the same way.
- A malformed body (missing `transport`, missing `command` for `stdio`,
  missing `url` for `sse`) 400s with the specific field-level error;
  `mcp-servers.yaml` is untouched (byte-identical before/after).
- A body naming an already-registered `id` 400s; `mcp-servers.yaml` is
  untouched.
- A body whose `stdio` command is not on PATH (or whose `sse`/`http` URL
  the mocked `fetchImpl` reports unreachable) 400s with the
  reachability check's own reason text; `mcp-servers.yaml` is untouched —
  this is the test proving §3.2/§3.3's decision for real, not just
  documenting it.

### 3. UI: "Add MCP server" form in `#mcpPanel`
**Acceptance criteria**
- Filling the form (a `stdio` entry with one tool row) and submitting
  asserts the real outgoing `POST /mcp-servers` request body via
  `postDataJSON()` — not just that the button is clickable (the
  established discipline, see `e2e/projects.spec.ts`'s own local-folder
  test) — and asserts the new server then appears in `#mcpList` by label.
- Filling the form with a transport kind whose required field is left
  blank shows a client-side inline error and sends no request at all
  (mirrors `#projLocalForm`'s own empty-path short-circuit).
- Submitting a body the server rejects (e.g. a duplicate id) renders the
  endpoint's `{error}` text inline in the form's own `.field-error` span,
  same as `#projCloneForm`'s own unreachable-URL error test.

## 7. Verification

Gate tests (`test/mcp-server-pool.test.ts` for subtask 1's pure/in-memory
pieces, `test/api.test.ts` additions for subtask 2, alongside the
existing `/mcp-servers` tests already there), an e2e spec addition
(`e2e/projects.spec.ts` or a new `e2e/mcp-servers.spec.ts` — implementer's
call on which reads cleaner, named in the summary either way) for subtask
3. `bun run typecheck` and `bun test test/` both green before this is
called done, same bar every prior SDD in this project has been held to.
