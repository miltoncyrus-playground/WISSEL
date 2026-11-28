# The board

`src/api/public/board.html`, vanilla JS, no build step
(`docs/SDD-ui-cleanup.md`).

- **Sidebar.** Work: Board, Tickets, Pipelines, Archive. Setup: Agents &
  skills, Harnesses, MCP servers, Projects, Memory, Settings.
- **Top bar.** Project switcher, **+ New**, the account line (one chip per
  enabled harness with what's running on it and which model,
  `GET /status/accounts`), and a version badge (`GET /version`).
- **Needs a human.** Only cards that need a decision (the server's
  `needsYou.lane: "human"`, `src/services/needs-you.ts`): an MCP approval,
  a grant, an escalation, a failed or unmatched card, a review report that
  FAILed, or changes nobody reviewed. Each one says why in full and lists
  the steps as tick-boxes (kept per browser), with its one button.
- **Lanes.** Queued, Working, In review, Next step, Done (last 24h by
  default). Next step holds finished work waiting on one mechanical step:
  an approved merge, a passed review report (Close,
  `POST /tasks/:id/close`), a merge that waits on another. A review in
  flight shows once, in In review, tagged "Review in progress"; the
  reviewer's own card isn't drawn in Working. A
  second view, **By feature**, shows one swimlane per root card with its
  subtasks and follow-ups.
- **Pipeline runs** show as one card with step progress. Clicking opens
  the run drawer; "View on canvas" shows the graph with live step status.
- **Archive.** Archived cards and their subtrees. Auto-archive of `done`
  cards after 24h is behind `WISSEL_AUTO_ARCHIVE`.
- **Tickets.** Every ticket and the work on it across your projects; see
  [Git and tickets](git-and-tickets.md). Cards also carry a ticket chip.

---

[Back to the README](../../README.md)
