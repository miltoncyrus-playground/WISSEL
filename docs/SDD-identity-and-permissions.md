# SDD: Identity, permissions and attribution

Who is acting, what they may do, and how every outward action traces back
to a person.

Status: draft, for review by the owner before any card starts. Companion
pages: `docs/SDD-coordinator.md` (the policy gate this spec gives a
principal to) and "Wissel Coordination Plane" (the learnings this came
from). To be built on a separate Wissel instance, not on one that
coordinates live work.

## 1. Why, and the outcome

Wissel has no authentication. `Bun.serve` is called with a port and no
`hostname` (`src/api/server.ts`), so the board listens on every interface
of whatever host it runs on; anyone who can reach port 8787 can create a
card, press **Run**, merge a worktree, grant extra tools, enable a
harness and approve an MCP call. Nothing records who did any of it: the
`tasks` table has no creator column, and no route checks anything.

That was a fair trade for one person on a laptop behind a firewall. Three
things have changed:

- a coordinator host is now a shared machine on a network, not a laptop;
- write-tier cards run with real credentials against real repositories;
- `docs/SDD-coordinator.md` gives Wissel the right to push branches, open
  pull requests, arm them and move tickets on its own.

The gate in that spec answers "is this action allowed". It cannot answer
"allowed *for whom*, and who said so". Until it can, Wissel cannot be a
team's coordinator of record: a team needs to know which person stands
behind a merge, and an auditor needs to see that no board entry or pull
request comment ever granted a permission.

**Outcome:** every action has a principal; every outward action has an
authorization chain ending at a named person; permissions are granted per
workstream and per project, never implied by network reach; and nothing
an agent reads can mint, widen or revive a permission.

**How we see it:**

1. A property test over the route table: every write route declares a
   permission, an anonymous request to each is refused, and a request
   with the wrong permission is refused. No route is reachable without a
   principal.
2. For every pull request Wissel opened, armed or merged, and every
   channel entry it posted, `GET /audit/trace/:ref` returns the full
   chain: principal, grant, policy revision, gate record, action, effect.
   No action is an orphan.
3. Adversarial fixtures in the gate suite: a channel entry, a pull
   request comment, a ticket field and a card body, each written to look
   like a grant or a role change. None changes any permission.

## 2. Scope

In:

- **A. Principals and sessions.** People, services, and agent runs; how a
  person signs in; API tokens for the CLI and scripts.
- **B. Permissions.** One permission per write action, granted per scope,
  checked in one place, denied by default.
- **C. Attribution.** An `authorizedBy` on every action and a traceable
  chain from an effect back to a person.
- **D. Approvals bound to content.** A human approval covers one action on
  one exact object, once, before it expires.
- **E. Machine identity.** What Wissel is on the code host, and what it
  never is.
- **F. Harness ownership.** Whose account an agent spends, and who may
  spend it.
- **G. Single-owner mode.** The current setup keeps working, unchanged,
  with attribution switched on.

Out:

- Secrets management. Wissel keeps naming environment variables, as
  `integrations.yaml` does; it never stores a credential.
- Provisioning (SCIM), group sync beyond an optional claim, and any user
  directory of its own.
- The policy gate itself (`docs/SDD-coordinator.md` §4.2). This spec hands
  it a principal and a grant; its rules are unchanged.
- Multi-tenant hosting. One instance belongs to one team.
- Encrypting the board database. Host-level concern.

## 3. Data model

New tables in the board database (`WISSEL_DB_PATH`). All times are ISO UTC
strings. Every table carrying a column added later needs the same
`ADD COLUMN` heal the `tasks` table uses.

### 3.1 Principal

```ts
interface Principal {
  id: string;
  kind: "person" | "service" | "agent";
  handle: string;              // short, unique, shown in the UI: "milton", "wissel-bot"
  display: string;
  subject?: string;            // IdP subject, for kind "person"
  codeHostLogin?: string;      // for attribution on the code host
  createdAt: string;
  disabledAt?: string;         // revokes sessions and tokens at once
}
```

An `agent` principal exists per card run and holds no grants, ever (§4.8).

### 3.2 Session and token

```ts
interface Session {
  id: string;                  // opaque; the cookie carries this and nothing else
  principalId: string;
  source: "oidc" | "proxy" | "token" | "owner-bootstrap";
  issuedAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

interface ApiToken {
  id: string;
  principalId: string;
  name: string;                // "mac-mini cli"
  hash: string;                // sha-256 of the secret; the secret is shown once
  permissions: Permission[];   // a subset of the principal's own, never a superset
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
}
```

### 3.3 Permission and grant

```ts
type Permission =
  | "board.read" | "audit.read"
  | "card.create" | "card.run" | "card.stop" | "card.merge" | "card.discard"
  | "card.grant-tools"            // extraAllowedTools, grant-and-retry
  | "project.settings" | "project.register"
  | "harness.manage" | "mcp.register" | "mcp.approve"
  | "policy.edit" | "role.change" | "duty.switch"
  | "branch.push" | "pr.open" | "pr.arm"
  | "ticket.write" | "channel.post"
  | "host.admin"                  // pause, resume, restart-when-idle
  | "member.manage";

interface Grant {
  id: string;
  principalId: string;
  scope:
    | { kind: "instance" }
    | { kind: "workstream"; id: string }
    | { kind: "project"; id: string };
  permissions: Permission[];
  grantedBy: string;              // principal id; never a board entry, never a card
  grantedAt: string;
  expiresAt?: string;
  revokedAt?: string;
}
```

A permission held at `instance` scope applies everywhere; at `workstream`
or `project` scope only there. Scopes do not subtract: there is no deny
grant, because the project `never` list and the hard limits already serve
that purpose and live in the gate.

### 3.4 Authorization record

One row per action attempted, written before the action runs, completed
after. Append-only, kept with the board database.

```ts
interface AuthorizationRecord {
  id: string;
  ts: string;                     // server's clock, never an agent's
  action: { kind: ActionKind; target: string };   // ActionKind from SDD-coordinator §4.3
  principalId: string;            // who stands behind it
  via: "direct" | "policy";       // a click, or the gate acting under a duty
  grantId?: string;
  policyRevision?: string;        // §4.4
  gateRecordId?: string;          // SDD-coordinator §4.2
  approvalId?: string;            // §4.5
  harnessId?: string;             // whose account paid, for a card run
  effect?: { pr?: string; sha?: string; entry?: string; taskId?: string };
  outcome: "allowed" | "denied" | "failed" | "queued";
  reason?: string;                // the deny rule that matched, or the error
}
```

### 3.5 Approval

Extends the existing two-phase pattern in `src/services/pending-actions.ts`
(single use, TTL, fails closed, the model cannot take one) with a
principal and a content binding.

```ts
interface Approval {
  id: string;
  principalId: string;            // who approved
  actionKind: ActionKind;
  targetRef: string;              // "org/repo#1158"
  contentHash: string;            // the reviewed head sha, or sha-256 of the brief or diff
  issuedAt: string;
  expiresAt: string;              // default 10 minutes, as PENDING_TTL_MS today
  usedAt?: string;
  resolution?: "confirmed" | "cancelled";
}
```

### 3.6 Additions to existing rows

- `tasks`: `createdByPrincipalId`, `authorizedByPrincipalId`.
- harness entries (`harnesses.yaml` and the status view):
  `ownerPrincipalId`, `shared: boolean`.
- telemetry run events: `principalId` and `harnessId`, so spend splits by
  both.

## 4. Design

### 4.1 The trust boundary

- `WISSEL_BIND` defaults to `127.0.0.1`. This is a behaviour change and
  the point of the first card: today the board answers on every
  interface.
- In single-owner mode (§4.10) a bind outside loopback refuses to start
  unless `WISSEL_ALLOW_OPEN_BIND=1` is set, which also prints a warning
  line on start and raises an owner task.
- In team mode, start refuses unless an authentication source is
  configured. There is no "team mode without auth".
- `WISSEL_PUBLIC_URL` is needed for the OIDC redirect and for links in
  digests.

### 4.2 Authentication

Two sources, both configured at start, never from the database:

- **OIDC** (`WISSEL_OIDC_ISSUER`, `WISSEL_OIDC_CLIENT_ID`, and the name of
  the environment variable holding the secret): authorization code with
  PKCE. On callback Wissel maps the subject to a `Principal`, creating one
  as `kind: "person"` with no grants if the subject is unknown. An
  unknown person can sign in and see nothing — that is the correct first
  experience, and it is how `member.manage` gets someone to grant.
- **Trusted proxy** (`WISSEL_TRUSTED_PROXY`): a reverse proxy terminating
  SSO sets a header naming the subject. Accepted only when the request
  arrives on the configured socket *and* carries the configured header;
  either alone is refused. Any request on another socket carrying that
  header is denied and recorded.

Bootstrap: on first start with no principals, Wissel prints a one-time URL
to the console (not to a log file) that creates the first person with an
instance-scoped grant of everything. The URL is single use and expires in
15 minutes.

Sessions are an opaque id in an `HttpOnly`, `SameSite=Lax` cookie, `Secure`
whenever `WISSEL_PUBLIC_URL` is https. Tokens arrive as
`Authorization: Bearer`, are matched by hash, and carry at most their
principal's own permissions.

### 4.3 One check, denied by default

```ts
function can(principal: Principal, permission: Permission, scope: Scope): boolean
```

Every write route declares its permission in the route table next to its
handler; one middleware reads that declaration and calls `can` before the
handler runs. A route with no declaration is not reachable — the route
table's type requires it, and a test enumerates the table to prove no
write route declares `undefined`. This mirrors the gate's own rule: a
kind with no rule falls through to refusal, never to allow.

Read routes require `board.read` at instance scope. `GET /version` and the
health endpoint stay open, because a supervisor needs them.

### 4.4 Attribution, and the chain

Every action writes an `AuthorizationRecord` before it runs.

- **Direct**: a person clicked. `via: "direct"`, `principalId` is theirs,
  `grantId` is the grant that allowed it.
- **Policy**: the gate allowed the coordinator to act under a duty.
  `via: "policy"`, `gateRecordId` points at the evaluation, and
  `policyRevision` names the rule set in force. The principal is the
  person who holds that duty for that project — not the instance, not a
  bot. A duty with no holder cannot act; the gate's rule 8 already sends
  it to `ask-owner`.

Policy is versioned: every change to a workstream, a role, a list, a duty
switch or the card rules bumps a revision and records who made it. Every
run records the revision it ran under, which is what makes "which rules
was that run under?" answerable — the question nobody could answer during
the pilot, when the rule file was reloaded by hand on three machines.

`GET /audit/trace/:ref` walks it the other way: from a pull request, a sha
or a channel entry id back through effect, action, gate record, grant and
principal.

### 4.5 Approvals cover one thing, once

An approval binds to `actionKind` + `targetRef` + `contentHash` and is
single use. Arming a pull request takes an approval whose `contentHash` is
the head sha that was reviewed; if the head moved, the approval does not
apply and the action is refused with that reason. The same shape covers a
grant of extra tools (hash of the tool list), a merge (hash of the diff)
and a brief that exceeds its template (hash of the brief).

Approvals are taken only by `POST /approvals/:id/confirm` with the
approving principal's own session. No agent, card, board entry or model
output can take one — the existing pending-action code already fails
closed on everything else, and this keeps that property.

### 4.6 Machine identity on the code host

Wissel acts as a **GitHub App installed per team**:

- installation tokens are short-lived, scoped to the repositories the
  installation names, and revocable without touching anyone's account;
- actions appear as the app, so a merge is attributable to Wissel rather
  than to whoever once ran `gh auth login` on that host;
- the app's permissions are the least-privilege ladder the coordinator
  spec already wants: read, then push and open, then merge for a project
  whose role is `decide`.

Never a person's personal access token, and never a person's `gh` login on
the host. That is the single change that makes the audit chain true rather
than approximately true.

Attribution without trailers: the project forbids AI attribution and
`Co-Authored-By` lines in commits. So the chain lives where it is allowed
to — the pull request body names the card id, the authorizing principal
and the policy revision, and the channel entry links the same ids.
Commits carry none of it.

### 4.7 Harness ownership and whose money it is

A harness is an account. During the pilot a spend limit on one
*individual* account stopped a whole host for two hours, and a credit
balance on another was reported in Slack because nothing in Wissel knew
whose balance it was.

- Each harness names an `ownerPrincipalId`.
- A harness not marked `shared` runs only cards authorized by its owner.
  A card that cannot find an allowed harness waits, exactly as it waits
  today when none is free.
- Each run records both the harness and the authorizing principal, so
  `usage:report` splits spend per person and per account, and a budget can
  be set per workstream rather than per process.
- A 429 spend limit, an expired SSO session or an exhausted balance
  becomes an event on the inbox naming the owning principal, not a line in
  a chat message.

### 4.8 An agent is a principal with nothing

Each card run gets an `agent` principal, which holds no grants and can
hold none: `member.manage` refuses to write a grant whose principal is of
kind `agent`, and a property test asserts it over random inputs.

Everything an agent may do comes from the card — its tier, its
`extraAllowedTools`, its MCP access, its worktree — and from nowhere
else. An agent's HTTP calls back into Wissel carry the card's token, whose
permissions are the card's, so the blast radius of a prompt injection is
one card, not one operator's session.

### 4.9 What people see

- The window header names who you are and what you may do in this
  workstream.
- **Needs you** already carries a reason; it gains a filter for items only
  *you* can act on, because you hold the permission or the duty. On a team
  that distinction is the difference between a queue and a noticeboard.
- A members page lists principals, their grants per scope, their tokens
  and their last activity. Changing a grant needs `member.manage` and a
  confirm step, and writes an authorization record like anything else.
- An audit view, filterable by principal, action kind, project and
  outcome, with the denied rows included. The denied rows are the
  interesting ones.

### 4.10 Single-owner mode keeps working

Default when no authentication source is configured and the bind is
loopback. One implicit owner principal, every action attributed to it,
every authorization record written. Nothing in the UI changes and nothing
asks anyone to sign in.

This matters for adoption: the instances running today are single-owner,
and they should gain the audit chain before they gain a login screen. Team
mode is then a configuration change with continuity — the history before
the switch is attributed to the owner, not lost.

## 5. API

- `GET /me` — principal, grants in the current scope, token name if the
  request came from one.
- `POST /auth/login`, `GET /auth/callback`, `POST /auth/logout`.
- `GET /members`, `POST /members`, `POST /members/:id/disable`.
- `POST /members/:id/grants`, `DELETE /grants/:id` — `member.manage`.
- `POST /tokens` (secret shown once), `DELETE /tokens/:id`.
- `GET /audit`, `GET /audit/trace/:ref` — `audit.read`.
- `POST /approvals/:id/confirm`, `POST /approvals/:id/cancel`.
- `GET /policy`, `POST /policy` — `policy.edit`; every write bumps the
  revision.
- Every existing write route gains a declared permission. No existing
  route changes its path or payload, so the board UI and the CLI keep
  working once they carry a session or a token.

## 6. Hard limits and security

- Credentials are never stored. Tokens are kept as hashes and shown once.
  Nothing in this spec reads an agent's environment.
- Wissel never acts as a person on the code host, the tracker or the
  channel. It acts as itself, and names the person who authorized it.
- No permission, grant, role or duty can be changed by anything read from
  a channel, a pull request, a ticket, a card body or a model's output.
  Grants come from `member.manage` by an authenticated person, full stop.
- `host.admin` and `member.manage` are never delegated to the
  coordinator's duty switches.
- An `agent` principal can never hold a grant.
- The authorization log is append-only, kept with the board database, and
  readable only with `audit.read`.
- Disabling a principal revokes every session and token in the same
  transaction, and stops their non-shared harnesses from taking new
  cards.
- Hard limits live in a file read at start, never in the database, so a
  write to the board can never lift one.

## 7. Adopting it

Four phases, each shippable on its own and each useful without the next.

1. **Close the door.** `WISSEL_BIND` defaults to loopback; an open bind
   needs an explicit flag and raises an owner task. No identity yet.
2. **Attribute everything.** Authorization records, policy revisions, the
   owner principal, harness ownership and per-principal spend. Still no
   login screen; single-owner instances see no change but gain the chain.
3. **Sign in.** OIDC or trusted proxy, sessions, tokens, members page.
   Everyone who signs in starts with an instance-scoped grant of
   everything, so nothing breaks on the day it is switched on.
4. **Narrow the grants.** Per-workstream and per-project grants, the
   agent principal, approvals bound to content, and the GitHub App
   replacing whatever pushes today. Narrowing is the last step because it
   is the only one that can stop someone working.

## 8. Tests and evals

Gate lane (`bun test`):

- **Route table.** Every write route declares a permission; anonymous
  requests to each are refused; a principal without the permission is
  refused; a token never exceeds its principal.
- **Approvals.** Reuse, expiry, a different principal, and a changed
  content hash are each refused with the right reason. An arm against a
  moved head is refused.
- **Agents.** A property test over random grant writes: no grant is ever
  written for a principal of kind `agent`.
- **Adversarial content.** Fixtures of a channel entry, a pull request
  comment, a ticket field and a card body, each claiming to grant a
  permission or change a role. None changes state; each is recorded as
  data.
- **Trace completeness.** A card created, run, reviewed, pushed, opened,
  armed and merged in a git fixture yields a chain with no missing link.
- **Disable.** A principal disabled mid-run loses sessions and tokens at
  once; their running card finishes and their non-shared harness takes
  nothing new.
- **Proxy spoofing.** The trusted-proxy header on a request from any other
  socket is denied and recorded.

## 9. Build plan (cards)

1. `WISSEL_BIND` default and the open-bind flag, with the start-up warning
   and owner task. (Phase 1, alone.)
2. Authorization record table, writer, and `GET /audit`; owner principal;
   `createdByPrincipalId` and `authorizedByPrincipalId` on `tasks`.
3. Policy revision: bump on every workstream, role, list, duty and card
   rule write; stamp it on every run.
4. Harness ownership, per-principal spend in `usage:report`, and the
   spend-limit event.
5. Principals, sessions, tokens, OIDC and trusted proxy, bootstrap URL.
6. The permission type, the route-table declaration, the middleware, and
   the route-table property test.
7. Members page, grants, disable, and the audit view in the board UI.
8. Agent principals and card-scoped tokens.
9. Approvals bound to content; migrate the existing pending actions onto
   it.
10. GitHub App installation, token minting, and the switch away from `gh`
    on the host.

Cards 1 to 4 need nothing from 5 onward. Card 10 is the one that needs a
decision from outside Wissel.

## 10. Where it breaks

- **Proxy misconfigured.** A trusted-proxy deployment where the header is
  accepted from anywhere makes everyone the owner. The socket check is the
  only thing standing between that and a silent full breach; it is tested
  and it refuses, loudly.
- **Loopback is not a boundary on a shared host.** Anyone with a shell or
  a port forward reaches a loopback bind. On a multi-user host, team mode
  is not optional.
- **`gh` outlives the app.** Until card 10 lands, something on the host is
  still authenticated as a person, and the audit chain ends at "the host"
  rather than at Wissel. Say so in the audit view rather than implying
  otherwise.
- **SSO expiry mid-run.** Seen in the pilot at eight hours. It becomes an
  event with an owner; it does not become a reason to cache a credential.
- **Audit growth.** One row per attempted action, denials included, on an
  instance running tens of thousands of cards. Partition by month and keep
  the retention rule explicit.
- **The leaver.** A person who leaves still holds grants and may still be
  the authorizing principal for running cards. Disable revokes, but their
  duties need a holder or the gate stops acting, which is the safe
  failure and should be visible rather than puzzling.
- **A permission added without a route.** Harmless. A route added without
  a permission is caught at test time, which is why the declaration is in
  the route table's type and not in a comment.

## 11. Open questions

1. Which identity provider, and is a groups claim available? If groups map
   to grants, the members page is a view; if not, it is the source.
2. One GitHub App per team or per instance, and who installs it? This also
   decides whether a review Wissel requests is attributable.
3. Is `member.manage` instance-wide only, or can a workstream owner grant
   within their own workstream? The second is more useful and harder to
   audit.
4. Retention for the authorization log, and whether denied rows live
   longer than allowed ones.
5. Does a card authorized by a person who later leaves keep running, stop,
   or need re-authorization by their successor?
6. Do agent principals need to appear in the members page at all, or only
   in the audit view?

## 12. Handover notes for the builder

- Build on a **separate Wissel instance**: own checkout, port, database,
  telemetry, memory path and worktrees, and its own test repositories.
  Never point it at an instance or a board that coordinates live work.
- Extend `src/services/pending-actions.ts` rather than replacing it. Its
  properties are already the ones this spec needs: single use, a TTL,
  scoped, and no path for a model to take one. Add the principal and the
  content hash; keep the refusal vocabulary.
- Facts to verify first, since the design rests on them: `Bun.serve` in
  `src/api/server.ts` takes no `hostname`; the `tasks` table has no
  creator column; no route performs any authorization check today.
- Every new column on an existing table needs the same `ADD COLUMN` heal
  the `tasks` table already does, or an on-disk database breaks the moment
  that column is written.
- Run Wissel's own gates on every card: `bun test`, `bun run typecheck`,
  the app tests, and `bun run test:e2e:affected`.
- Report progress per card; questions with a default and a lean, so the
  work never blocks on an answer.
