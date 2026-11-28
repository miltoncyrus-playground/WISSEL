# Sign-in and permissions

Off by default: in single-owner mode the owner stands behind every
request, and every write is recorded as theirs (`GET /audit`).
`WISSEL_AUTH=tokens` turns sign-in on, with tokens only: there is no
identity provider (`docs/SDD-identity-and-permissions.md` §4.2, card 5).
- **The owner's first sign-in** is a one-time link Wissel prints on
  start while the owner has no live session or token:
  `sign-in: open …/auth/bootstrap/<secret> within 15 minutes`. It works
  once and signs in as the existing owner, so the history stays theirs.
- **Adding people:** the owner adds a person with `POST /members {handle,
  display}`. The answer includes their first token, shown once. They
  paste it into `/auth/login`, which gives their browser a session (an
  HttpOnly, SameSite=Lax cookie, kept 30 days).
- **Tokens:** anyone signed in mints their own with `POST /tokens
  {name, expiresAt?}` (the secret shown once), lists them with `GET
  /tokens`, and revokes one with `DELETE /tokens/:id`. A script sends a
  token as `Authorization: Bearer`; the CLI reads it from `WISSEL_TOKEN`.
- **Removing people:** `POST /members/:id/disable` revokes all of that
  person's sessions and tokens at once. `GET /members` lists everyone
  with their tokens. `POST /auth/logout` ends a session.
- **Storage:** only hashes of sessions, tokens and links are stored,
  never a secret.

**Permissions** (§3.3, §4.3, card 6): one check in front of every route,
denied by default.
- **The owner** holds everything. Everyone else holds what their
  grants say. A new member holds nothing, so they can sign in and see
  nothing until granted.
- **What a route needs:** each write route declares its permissions in
  `WRITE_ROUTES` (`src/services/permissions.ts`), and where it lands: a
  card's project and workstream, a project, a workstream, or the
  instance. A write route the table doesn't declare is the owner's
  alone. Reads need `board.read`, and `GET /audit` needs `audit.read`.
  A refusal is a 403 naming the missing permissions, recorded in the
  audit as denied.
- **Grants:** `POST /members/:id/grants {scope, permissions,
  expiresAt?}`, where `scope` is `{"kind": "instance"}`, `{"kind":
  "workstream", "id"}` or `{"kind": "project", "id"}`. A workstream grant
  covers that workstream's cards and projects. `DELETE /grants/:id`
  revokes one, and `GET /members` lists each member's grants.
- **Who grants:** a grant needs `member.manage` at its scope, so a
  workstream owner grants within their workstream. A granter can hand
  out only what they hold there. `host.admin` and `member.manage` at
  instance scope come only from the owner, and an agent principal can
  never hold a grant.
- **The coordinator switches:** the owner-only ones (roles, duties,
  Shadow, flips, imports, lessons) honour a granted `role.change`,
  `duty.switch` or `policy.edit`.

**On the board** (card 7):
- **Setup > Members** lists everyone with their grants per scope (each
  with Revoke) and their live tokens. From it you can:
  - add a member (their first token is shown once);
  - grant (scope plus permission boxes);
  - mint a token;
  - disable a member, after a confirm.
- **Setup > Audit** lists the authorization records, newest first,
  filterable by member, outcome and action (`GET /audit?principal=
  &outcome=&kind=`). Denied rows are marked.

**Agents** (§4.8, card 8): with sign-in on, each card run is its own
`agent` principal, with no grants and never any.
- **Its token:** its process gets a token in `WISSEL_TOKEN`, with
  `WISSEL_CARD_ID` and `WISSEL_API_URL`. The token reaches only that
  card, to read: `GET /tasks/<its card>` and below, and `/me`.
- **Everything else** is a 403, recorded under that run's principal.
  The blast radius of a prompt injection is one card, not anyone's
  session.
- **Lifetime:** the token is revoked when the run ends, however it
  ends, and lasts at most a day.
- **Storage:** only its hash is stored.

Without sign-in no token is issued, since nothing checks one.

**Approvals** (§4.5, card 9): an approval covers one thing, once, for
one person, while the thing it covers is unchanged.
- **Arming a PR:** `POST /tasks/:id/arm` (`pr.arm`) issues you an
  approval bound to the reviewed head. It's refused until the PR watcher
  has seen the PR ready. `POST /approvals/:id/confirm` then arms
  auto-merge with `gh pr merge --auto --merge --match-head-commit
  <reviewed head>`, so the code host refuses too if the head moved in
  between.
- **When a confirm is refused:** reuse, expiry, a confirm by anyone
  other than the person it was issued to, and a moved head are each
  refused with their reason. `GET /approvals` lists your open ones, and
  `POST /approvals/:id/cancel` drops one.
- **Ask's Confirm and Undo** follow the same rules. Each records who
  asked and a hash of the actions with the cards they touch. Only that
  person can confirm, and a card that changed since (moved, edited,
  superseded) refuses the Confirm: ask again.

**Leavers stop and ask:** disabling a member revokes their sessions and
tokens at once. Every card they authorized that hasn't started is held,
and an owner task lists those cards and the ones still running, which
finish.
- **Keep a card:** `POST /tasks/:id/reauthorize` (`card.run`) makes it
  run on your authority from then on and releases it. Who made the card
  is kept, and the audit records who moved it.
- **Drop a card:** Discard or Archive it.

With sign-in on, a non-loopback `WISSEL_BIND` no longer needs
`WISSEL_ALLOW_OPEN_BIND`.

---

[Back to the README](../../README.md)
