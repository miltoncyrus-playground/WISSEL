# SDD: The coordinator dock leaves the lanes visible

Status: ready to plan. Owner: Milton. Parent: `docs/SDD-coordinator.md` §4.14.
This spec is the first piece of work handed to the coordinator itself (a test
of the flow: spec in, cards planned and run, owner reviews).

## 1. Problem

The board's coordinator dock (`#coordDock` in `src/api/public/board.html`) is
a fixed 520 px panel on the right. `main` makes room by a right margin, but
the lanes keep their own widths, so at 1280 px the dock lies over the Next
step and Done lanes. The owner wants the dock open and those lanes readable
at the same time: watching a card move from Next step to Done while talking to
the coordinator is the point of the dock.

## 2. Goals and non-goals

Goals:

- With the dock open, every lane (Queued, Working, In review, Next step, Done)
  is fully visible and usable. Nothing in the lanes is covered by the dock.
- The owner can choose how much room the dock takes, and the choice sticks.
- The top menu stays visible and clickable (already true since `91595c5`;
  keep it true).

Non-goals:

- The window's own contents (`app/src/screens/CoordinatorWindowScreen.tsx`).
- The app's `/app#/window/...` screen and its right-hand Live rail.
- Any server, API or database change.
- The Tickets, CI, Pipelines and other pages: they are untouched.

## 3. Requirements

R1. **Lanes stay visible.** With the dock open at a viewport of 1280 x 800,
the left edge of the dock is at or to the right of the right edge of the
lanes area, and the header of each of the five lanes is inside the viewport.
The lanes area gives up width to the dock instead of being covered by it.

R2. **Lanes reflow.** The lanes area may narrow to a minimum lane width of
160 px per lane. Below that total width the lanes area scrolls horizontally
inside its own box; the page itself does not scroll sideways and the dock is
never above any part of the lanes area.

R3. **A narrower dock by default.** The default dock width is 380 px (it was
520 px), so five lanes fit beside it at 1280 px without scrolling. The
window inside still works at 380 px (its own layout is compact).

R4. **Resizable.** A drag handle on the dock's left edge changes its width
between 320 px and 560 px. The handle is reachable by keyboard (arrow keys
change the width by 16 px, `Home` and `End` jump to the limits) and has the
`separator` role with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`.
The chosen width is saved in `localStorage` (try/catch around every access)
and restored on the next open and after a reload.

R5. **Collapsible.** A button in the dock header collapses the dock to a
44 px rail showing a vertical "Coordinator" label and, when any, the count of
items that need the owner. Pressing the rail or the same button expands it
again. The lanes area uses the freed width. The collapsed state is also saved.

R6. **Narrow screens.** Below 720 px viewport width there is no room beside
the lanes. The dock becomes a bottom sheet covering the lower 60 % of the
screen with a close button; the lanes above it stay scrollable and the top
menu stays visible. This is a deliberate overlay: R1 and R2 apply at 720 px
and wider.

R7. **Aligned with the cards.** The dock's top stays at the top of the lanes
area, as now, and follows it on scroll. The top menu is never covered.

R8. **No regressions.** The existing specs that touch the board and the dock
keep passing: `e2e/coordinator-window.spec.ts`, `e2e/board.spec.ts` (except
two failures that already fail on `main`: the escalated-task timeline spec and
the nav-one-row spec),
`e2e/new-task.spec.ts`. Opening and closing the dock, the "+ New"
Coordinator tab and the workstream select behave as before.

## 4. Acceptance checks

Playwright, in `e2e/coordinator-window.spec.ts`, each failing on the current
code and passing after the change:

1. At 1280 x 800 with the dock open: for each of the five lane headers,
   `elementFromPoint` at its centre returns that header (or a descendant), and
   the dock's left edge is >= the lanes area's right edge.
2. At 1024 x 768 the same holds, with the lanes area scrolling horizontally
   if needed and `document.documentElement.scrollWidth <= window.innerWidth`.
3. Dragging the handle 100 px left widens the dock by 100 px (within limits);
   after a reload the width is the same. Arrow keys change it by 16 px.
4. Collapse shows a rail 44 px wide and gives the lanes area at least 300 px
   more than the default; expand restores the saved width.
5. At 390 x 800 the dock is a bottom sheet over at most 60 % of the height,
   the top menu is clickable, and closing it restores the page.
6. The top-menu test already in the spec still passes.

## 5. Constraints

- Change only `src/api/public/board.html` (markup, CSS, its inline script)
  and, if a pure helper is wanted, a new `src/api/public/board-dock.js` with a
  `test/` unit test. No other file except the specs.
- Keep the file's style (vanilla JS, no new dependencies, no build step).
- Respect `prefers-reduced-motion` for any transition.
- Every `localStorage` access is wrapped in try/catch; the page must work
  with storage blocked.
- Do not break `board.html`'s existing inline script: `node --check` on the
  extracted script must pass.

## 6. Suggested split for planning

All pieces edit the same file, so they run one after another:

- K1 (R1, R2, R3, R7): lanes area reflow and the narrower dock, with checks 1
  and 2.
- K2 (R4): resize handle and persistence, check 3. Waits for K1.
- K3 (R5): collapse rail, check 4. Waits for K2.
- K4 (R6): bottom sheet below 720 px, check 5. Waits for K3.

Each piece: at most 400 changed lines, `bun run typecheck`, `bun run test`
and the specs named in R8 green, nothing committed (the owner merges).
