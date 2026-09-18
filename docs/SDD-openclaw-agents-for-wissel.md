# SDD — bringing OpenClaw's agent model to wissel

Status: **§3b (handoff enforcement) and a `wissel team create` scaffolding
command are built.** §3a (advisory display) shipped as part of §3b's work
rather than separately, since it was free once the fleet view was already
being touched. §3c (structured auto-delegation), §4.2–§4.4 remain
reference-only — see §6 for what's still open.

**What shipped**, for whoever picks this up next:
- `TaskCard.parentTaskId?: string` (schema) — a follow-up task, distinct
  from `dependsOn`.
- `Registry.candidatesFor(labels, allowIds?)` and
  `Router.route(task, allowIds?)` — `allowIds` restricts candidates;
  `undefined` is unrestricted, `[]` is a real, explained "restricted to
  nothing" (see `AgentDef.handoffs`'s updated doc comment for the
  undefined-vs-`[]` distinction this rests on).
- `resolveHandoffAllowlist(board, registry, parentTaskId)` in
  `orchestrator.ts` — resolves a follow-up's restriction from its
  parent's routed agent; wired into `Orchestrator.process()` and
  `POST /route/preview`.
- New Task tab: a "Follow-up of" select, wired into the live preview and
  the create payload.
- Fleet view: agents/skills with a declared `handoffs` show "→ hands off
  to: ..." (or "to no one" for an explicit `[]`); undeclared shows
  nothing.
- `src/core/team-preset.ts` + `wissel team create <prefix>` — scaffolds
  a coordinator + 3 specialists (researcher/writer/reviewer) into
  `agents/manifest.yaml`, delegation pre-wired, by appending text to the
  file (never a parse-and-restringify round trip, which would silently
  drop the file's comments).

62 unit/integration tests + 10 e2e tests covering all of the above.

## 1. What was researched

Source: `https://docs.openclaw.ai/cli/agents` (OpenClaw CLI reference,
pasted into this session — not independently re-verified beyond that
page). Summarizing only what's structurally relevant to wissel; the full
page also covers CLI flag syntax, Trash/deletion semantics, and Gateway
plumbing that's specific to OpenClaw's runtime and isn't repeated here.

**What an "agent" is in OpenClaw**: a persistent, isolated, *stateful*
unit — a workspace directory, its own auth/credential profile (shared or
private OAuth/API-key), a visual identity (name/theme/emoji/avatar,
seedable from an `IDENTITY.md` in its workspace), a bound model, a set of
visible skills, and a set of inbound chat-channel bindings (Telegram,
Discord, etc.) that route messages to it. Agents are created (`agents
add`), listed with health status (`agents list`, including a "degraded"
state when e.g. two agents' databases collide), bound to channels
(`agents bind`/`unbind`/`bindings`), and deleted with careful
shared-resource handling (soft-delete to Trash, refusal to delete an
agent whose database or workspace another agent still depends on).

**Role templates**: bundled starter roles (`coordinator`, `researcher`,
`writer`, `reviewer`), each a manifest (`CLAW.md` + `SOUL.md`) plus an
operating program (`AGENTS.md`) that seeds a new agent's identity and
behavior in one command: `agents add research --role researcher`.

**Team preset + delegation**: `agents team create` instantiates a
4-agent hierarchy in one shot — a coordinator plus the three specialists
— and wires delegation automatically: the coordinator's
`subagents.allowAgents` lists the three specialist ids with
`delegationMode: "prefer"`; each specialist gets `allowAgents: []` and is
instructed to return results without delegating further. This is a real,
enforced one-level delegation hierarchy, not just documentation — a
coordinator can hand work to a named specialist, and a specialist
structurally cannot recurse.

**Routing bindings**: inbound traffic on a channel+account
(`telegram:ops`) is pinned to a specific agent, with explicit precedence
rules (account-scoped beats channel-wildcard beats default-only) and
an upgrade path (a channel-only binding silently upgrades to
account-scoped the first time a more specific bind is added).

**Per-agent model and skills scoping**: `--model` at creation time, plus
`agents.defaults.skills` / `agents.entries.*.skills` in config to control
which skills are visible per agent.

## 2. Fit against wissel's architecture

wissel is not OpenClaw and shouldn't try to become it. The router/
execution boundary this codebase already committed to
(`docs/HANDOVER-2026-09-17.md`) is the filter every OpenClaw concept
below has to pass through: **wissel decides and dispatches; it does not
hold state, credentials, or a persistent identity for anything it
routes to.** An `AgentDef` in `agents/manifest.yaml` is a routing-target
*descriptor* — stateless, credential-free, re-read from a static file on
every process start. An OpenClaw "agent" is a running, stateful,
credentialed *instance*. Those are different layers of the stack, and
most of OpenClaw's agent machinery (workspace ownership, auth profiles,
Trash-based deletion, channel bindings) belongs — if it belongs anywhere
in this project family — to whatever executes write-tier work (agetor),
never to wissel.

| OpenClaw capability | Wissel's nearest concept | Verdict |
|---|---|---|
| Workspace + auth + credentials per agent | *(none — deliberately out of scope, see HANDOVER-2026-09-17.md)* | **Not applicable.** This is execution-layer state; wissel doesn't execute. |
| Channel routing bindings (chat account → agent) | *(none — wissel has no inbound chat-channel concept)* | **Not applicable** unless wissel grows a chat-trigger surface. Noted, not designed here. |
| Identity: name/theme/emoji/avatar, `IDENTITY.md` | `AgentDef.name` only | **Low priority.** wissel is dev tooling, not a persona-facing product. Could be a cheap fleet-view cosmetic add later; not designed here. |
| Deletion with shared-resource/ownership safety | *(none — registry entries aren't stateful instances)* | **Not applicable.** Nothing in wissel's registry owns a database or workspace to protect. |
| Degraded health / `doctor` / repair guidance | *(none)* | **Adoptable.** wissel has no notion of "is this agent's configured model actually reachable right now" — see §4.3. |
| Per-agent model selection, actually enforced | `AgentDef.costProfile.model` — **defined but never read by the executor** (confirmed in this session: `ReadOnlyExecutor` never passes it as `--model`) | **Adoptable, and overdue.** Directly closes a gap already found in this codebase. See §4.2. |
| Per-agent skills visibility | *(none — the router considers the entire registry for every task)* | **Adoptable as an option**, not a requirement. See §4.4. |
| Role templates → instantiate a configured agent | *(none — manifest entries are hand-written, one at a time)* | **Adoptable.** See §4.1. |
| Team preset + enforced delegation (`allowAgents`, `delegationMode`) | `AgentDef.handoffs?: string[]` — **declared in every manifest entry already, never read.** `registry.ts` has a literal `// TODO: prune by declared handoff edges once graph routing lands.` | **The centerpiece.** This is the one OpenClaw capability wissel already half-built and shelved. See §3. |

## 3. Centerpiece: enforcing the handoff graph

This is the most direct, highest-value transfer, because wissel already
carries the exact data OpenClaw's delegation model needs
(`triager.handoffs: [planner]`, `planner.handoffs: [implementer,
reviewer]`, `implementer.handoffs: [reviewer]`) — it's just decorative
today. `registry.candidatesFor()` ignores it entirely and returns the
whole non-service fleet for every task.

wissel has no live conversational delegation to mirror OpenClaw's
"coordinator decides mid-conversation to hand off" — wissel's unit of
work is a discrete task card moving through a board, not a chat turn. So
"enforcing handoffs" has to be reinterpreted as a **task-graph**
concept: when a follow-up task exists *because* an earlier task finished
on some agent, that follow-up's candidate set should be restricted to
whatever the finishing agent declared as its `handoffs` — the direct
task-graph analogue of `subagents.allowAgents`.

Three enforcement depths, in increasing order of power and invasiveness:

### 3a. Advisory only (display, no behavior change)
Show the handoff graph somewhere a human can see it before acting on
it — e.g. the fleet view's agent rows already show tags/tier/cost-slot;
add "hands off to: planner" as another line, and/or draw it in `wissel
why <id>`'s output. Zero risk, zero new schema, purely a visibility
improvement. Good first step regardless of which deeper option follows.

### 3b. Router-level candidate pruning for declared follow-ups
When a new task is created as an explicit follow-up of a finished one,
restrict `Registry.candidatesFor()` to the finishing agent's `handoffs`
list instead of the whole registry.

**Open design question this forces**: `TaskCard.dependsOn` today means
only "blocked until," not "spawned by" — a task can depend on another
without being conceptually its child. Enforcing handoffs needs to
distinguish those. Two ways to resolve it:
- Add an explicit `TaskCard.parentTaskId?: string`, set only when a task
  is genuinely a follow-up (not just blocked), and have
  `candidatesFor()` take the parent's `routedTo` agent's `handoffs` as
  an allow-list when a `parentTaskId` is present.
- Or: treat *any* `dependsOn` entry the same way (looser, but conflates
  "blocked by" with "spawned by," which is a real semantic muddy patch —
  not recommended without the explicit field).

This is a genuine schema addition (`TaskCard` + the `POST /tasks`
payload + `board.ts`'s SQLite columns), not just a router change — scope
it accordingly.

**Shipped**: the first option — `TaskCard.parentTaskId?: string`, kept
fully distinct from `dependsOn`. `Registry.candidatesFor(labels,
allowIds?)` and `Router.route(task, allowIds?)` apply the restriction;
`resolveHandoffAllowlist()` in `orchestrator.ts` resolves it from the
parent task, and distinguishes "parent agent never declared
`handoffs`" (→ `undefined`, unrestricted) from "parent agent declared
`handoffs: []`" (→ `[]`, a real, explained zero-candidate outcome) —
see `AgentDef.handoffs`'s doc comment. Wired into both
`Orchestrator.process()` (the automatic path) and `POST /route/preview`
(so the New Task tab's live preview shows the restriction before a task
is even created).

### 3c. Full structured auto-delegation
The closest actual mirror of OpenClaw's live delegation: a finishing
agent's own output *names* the follow-up work, and wissel creates and
routes that follow-up automatically — no human re-typing what a
readonly agent already figured out (e.g., triager's structured task
card *becomes* the next task, handed straight to `planner`, with zero
manual re-entry).

This requires agents to return **structured** output instead of the
free-text `summary` string `TaskResult` carries today — which connects
directly to the prompt-effectiveness gap already identified this
session (§3 of the earlier prompt-changes discussion: no output-format
constraint exists at all right now). Concretely: extend the prompt
template to ask for a fenced JSON block with a `followUp` shape (`{title,
body, labels}`), parse it in `ReadOnlyExecutor` alongside the free-text
summary, and have the orchestrator create + route the follow-up task
when present, restricted to the finishing agent's `handoffs` per 3b.
Most powerful, most invasive — needs real prompt-engineering and output
parsing, and a decision about what happens when the agent's output
doesn't parse cleanly (fall back to no auto-follow-up, never guess).

**Recommendation**: build 3a now (cheap, safe), decide on 3b's schema
question when you're ready to invest in it, and treat 3c as a stretch
goal gated on the prompt-format work from the "reduce costs" discussion
landing first — it's the same prerequisite (agents need to return
structured output) serving two different features.

## 4. Other adoptable pieces

### 4.1 Role templates → a registry scaffolding command
OpenClaw's `agents add --role researcher` and `agents team create` are
really "write a pre-filled config entry from a named template." wissel's
equivalent would be a `wissel fleet add --template <name>` (or similar)
that appends a new, pre-filled entry to `agents/manifest.yaml` from a
small set of bundled templates (e.g., a "narrow readonly skill"
template, a "write-tier handoff agent" template), prompting for just the
handful of fields that actually vary (id, description, tags). Useful if
the fleet grows enough that hand-writing every manifest entry from
scratch becomes friction — not urgent at 12 entries (see the earlier
"should I split the manifest file" discussion; same "not yet, revisit
when it grows" answer applies here).

A `team create`-equivalent (scaffold a coordinator + N specialists with
`handoffs` pre-wired between them) is a natural extension once §3's
enforcement actually does something — currently it would just be
convenient YAML generation with no behavioral payoff.

**Shipped**: `wissel team create <prefix>` (`src/core/team-preset.ts`),
built alongside §3b so the preset actually delegates rather than just
generating YAML. Scaffolds `<prefix>-coordinator` (handoffs: the three
specialist ids) plus `<prefix>-researcher`/`-writer`/`-reviewer`
(handoffs: `[]` — a deliberate dead end, matching OpenClaw's
specialists). Appends to `agents/manifest.yaml` as raw text in the
file's existing per-entry style, never a parse-and-restringify round
trip — that would silently drop the file's header/section comments.
Reports conflicts and adds nothing if any id already exists, matching
OpenClaw's collision behavior. The general "scaffold one new agent/skill
from a template" idea (the rest of this section) is still open — only
the 4-role team preset was built.

### 4.2 Wire `costProfile.model` into the executor (already identified, restated for completeness)
`ReadOnlyExecutor.run()` builds its `claude -p` command but never reads
`agent.costProfile.model` — every readonly agent/skill runs on whatever
`claude`'s local default is, regardless of what the manifest claims.
Fix: pass `agent.costProfile.model` as `--model` in the executor.
Small, mechanical, directly closes a real gap. (Carried over from the
"prompt changes to reduce cost" discussion earlier in this session —
listed here because it's also exactly what OpenClaw's per-agent
`--model` does, enforced.)

### 4.3 Fleet health ("doctor") status
OpenClaw's `agents list` reports a `degraded` state with repair
guidance when an agent's underlying resources are broken. wissel's
analogue: a lightweight health check per readonly agent — is `claude`
on `PATH`, is the configured `costProfile.model` a real, authenticated
option right now — surfaced as a status dot on the fleet view, reusing
the exact same pulsing-dot visual language already built for "actively
working" (a static red/amber dot instead of the pulsing green one would
read as "can't run" without inventing new visual vocabulary). This
would need a new lightweight `GET /agents/health` (or similar) that
shells out to `claude --version`/`claude models list`-equivalent and
caches the result briefly — real but bounded scope.

### 4.4 Per-project/per-repo registry scoping (optional)
OpenClaw scopes skill visibility per agent (`agents.entries.*.skills`).
wissel's rough equivalent, if ever needed: scope which registry entries
are eligible *candidates* per repo or project (e.g., a repo that never
touches Python shouldn't have a Python-flavored agent show up as a
routing candidate). Not something to build speculatively — only worth
it once wissel manages enough repos/projects that an irrelevant
candidate has actually shown up in a routing decision. Flagged here so
the option exists on paper; no schema proposed.

## 5. Explicitly out of scope (and why)

- **Workspace/auth/credential management.** Execution-layer state;
  wissel doesn't execute, so it has nothing to hold credentials for.
  Belongs to agetor (or whatever runs write-tier work), never wissel.
- **Channel routing bindings.** wissel has no inbound chat-channel
  concept — tasks arrive via the board API / New Task tab, not a chat
  message. Would only become relevant if wissel grew a chat-trigger
  surface, which is a different, much bigger feature than "adopt
  OpenClaw's agent model."
- **Identity (avatar/theme/emoji) and `IDENTITY.md`.** Cosmetic, aimed
  at a persona-facing product. Cheap to add later to the fleet view if
  ever wanted; not worth designing now.
- **Deletion / Trash / shared-resource ownership safety.** wissel's
  registry entries are stateless descriptors, not instances that own a
  database or workspace — there's nothing here to protect.

## 6. Recommended phased path

None of §3's or §4's items are mutually exclusive alternatives — they're
depths you can stop at.

1. ~~**§4.2** — wire `costProfile.model` into the executor.~~ Still open
   — not part of this pass, unrelated to delegation. Independent,
   mechanical, no schema change.
2. ~~**§3a** — show the handoff graph in the fleet view / `wissel why`.~~
   **Shipped**, bundled into §3b's work (see status note at the top).
3. ~~**§3b** — enforce handoffs for explicit follow-ups.~~ **Shipped** —
   `parentTaskId`, `Registry.candidatesFor`/`Router.route`'s `allowIds`,
   `resolveHandoffAllowlist`, and the New Task tab's "Follow-up of"
   field.
4. **§4.3** — fleet health status. Still open. Independent of the above,
   worth doing whenever there's appetite for a new small endpoint.
5. **§3c** — full structured auto-delegation. Still open, still gated on
   the prompt-format work from the cost-reduction discussion landing
   first; don't build the parsing/follow-up-creation logic before agents
   actually emit something parseable.
6. ~~**§4.1** — a team-scaffolding command.~~ **Shipped early** —
   `wissel team create <prefix>` (`src/core/team-preset.ts`), built
   alongside §3b at the user's request rather than waiting for the
   fleet to outgrow one file, since §3b landing first gave it real
   behavioral payoff (coordinator/specialist delegation actually
   enforced, not just YAML). The more general "scaffold a single new
   agent/skill from a template" half of §4.1 remains open — only the
   4-role team preset was built, not a general template picker.
7. **§4.4** — per-project registry scoping. Still open, still not worth
   building against a hypothetical.

## 7. Open questions for whoever picks this up

- For §4.3, what should "degraded" actually check — `claude` binary
  presence, an authenticated model probe, or both? A real model probe
  costs a network round-trip on every health check; worth deciding the
  acceptable cache window before building it.
- Is a general `wissel fleet add --template <name>` command (the
  single-agent half of §4.1, not the team preset — that part shipped)
  worth building before or after the manifest genuinely outgrows one
  file? Recommend waiting.
- §3c (structured auto-delegation) still needs the prompt-format
  decision from the cost-reduction discussion settled first — nothing
  here changes that.
