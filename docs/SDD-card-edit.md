# SDD — Edit a card that hasn't started, and list only live cards

Status: **Built.** `PATCH /tasks/:id` (`editTask`, `editRefusal` in
`src/services/board-actions.ts`), `Board.updateFields` and the
`task.updated` event, and `GET /tasks?live=1`. `test/card-edit.test.ts`.

## 1. The problem

A card's title, body, labels, repo and settings could not be changed
after creation. A card made with the wrong label (so no agent matched it),
no repo, or a missing branch target had to be archived and made again.
Four rounds of that in one session left a trail of archived copies, and
every list of cards had to be filtered by hand to hide them.

## 2. `PATCH /tasks/:id`

Changes any of `title`, `body`, `labels`, `repo`, `model`,
`harnessOverride`, `mergeTarget`, `extraAllowedTools`, `extraAllowedDirs`.
Only the keys in the body change. A key set to `null` clears it (a title
can't be empty). Any other key is a 400 that names it. An empty body, a
non-object, or the wrong type for a field is a 400.

**When.** Only before anything has happened to the card: `inbox` or
`ready`, not routed to an agent, not archived, not replaced by a later
attempt (`supersededBy`). Otherwise 409 with the reason. Once a card has
run it is a record, and a change would rewrite history the reviewer and
the audit trail already read.

**Same checks as creation.** The edited card is built (the stored fields
plus the edit) and run through `validateNewTask`, the function
`POST /tasks` and a schedule's template use. So an edit can't produce a
card creation would have refused: an unknown harness, a bad `mergeTarget`,
a bad tool grant, labels that now route to a write-tier agent with no
repo. A refused edit changes nothing. `notBefore` is left out of the
check: it isn't editable here, and a start time that has since passed
would otherwise fail a check it already met.

`Board.updateFields` writes the named columns in one `UPDATE` and emits
`task.updated`. An unknown id is 404.

## 3. `GET /tasks?live=1`

Returns only cards that still count: not archived and not replaced by a
later attempt. Without the parameter the list is unchanged. Wissel's
own views already hide these cards; this lets an API client or a script
get the same list without reimplementing the rule.

## 4. Not here

- Replacing an attempt is still `supersededBy`, set by a review pushback;
  nothing new marks a card superseded by hand.
- No edit of a routed or running card, and no edit of `dependsOn`
  (`POST /tasks/:id/depends-on` exists for that).
- The board UI does not yet have an Edit button; this is the API.
