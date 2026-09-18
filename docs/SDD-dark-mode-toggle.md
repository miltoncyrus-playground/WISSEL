# SDD — manual dark mode toggle for the board UI

Status: **design only, nothing implemented.** Reference doc for a future
session to execute against.

## 1. Current state

`src/api/public/board.html` already has dark styling — it just has no
manual control. Every color is a CSS custom property, defined once on
the bare `:root` (light) and redefined inside
`@media (prefers-color-scheme: dark) { :root { ... } }`. That media
query is **unguarded**: it wins purely on the OS/browser preference,
with no way for a person to override it from inside the page. There's
no `data-theme` attribute, no toggle control, no persisted preference,
and no JS theming logic at all today — this is a from-scratch addition,
not an extension of existing toggle code.

## 2. Design

### 2.1 State model — recommend three states, not two

| Option | Behavior | Tradeoff |
|---|---|---|
| **Two-state (light/dark)** | Toggle flips between the two; whichever was clicked last wins forever, OS preference is only the *initial* default. | Simpler UI (one control, one click). Loses "go back to following my OS" once touched — mildly annoying if someone's OS scheme changes later (e.g. a scheduled dark-mode-at-night) and wissel no longer follows it. |
| **Three-state (system/light/dark) — recommended** | A third "Auto" state that means "no override, follow the OS" — the page's current unguarded-media-query behavior, just made reachable again after someone has explicitly chosen light or dark. | One more state to build for, but it's the same amount of CSS either way (see 2.3) and matches how every mainstream app's theme toggle actually works (macOS, VS Code, GitHub) — nobody has to remember "did I lock this to light, or is my OS in light mode right now." |

Recommendation: three-state. It costs nothing extra in CSS (the dark
block gets written once regardless) and only a little extra in the
toggle control and persisted-value logic (see 2.4).

### 2.2 Control placement and shape

The `.toolbar` row already holds the Board/New-task `.segmented`
control on the left and the live task count on the right — the natural
slot for a theme control is the right side, next to the task count, so
it reads as a page-level setting rather than competing with the
Board/New-task navigation.

**Shape — reuse the existing `.segmented` component.** `board.html`
already has a proven 2-button segmented control (Board / New task)
with `aria-pressed` state and hover styling. A 3-option segmented
control — **Light · Dark · Auto** — for the theme picker is the same
component, zero new CSS beyond what's already in the file, and stays
visually consistent with the one navigation control already on the
page. (Alternative considered: a single icon button that cycles
system→light→dark→system on each click. Rejected as the primary
design — it hides the current state behind an icon someone has to
interpret, whereas a 3-way segmented control shows all three options
and the active one at a glance, which matters more for a control
someone might touch once and then ignore for weeks.)

### 2.3 CSS changes

Two changes to the existing token blocks, both required — this isn't
purely additive:

1. **Guard the existing media query.** Change
   `@media (prefers-color-scheme: dark) { :root { ... } }` to
   `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } }`.
   Without this, setting `data-theme="light"` while the OS is in dark
   mode would still lose to the media query — the guard is what makes
   "Light" an actual override rather than a no-op half the time.
2. **Add an explicit dark override block**: `:root[data-theme="dark"] { /* same tokens as the media query block, verbatim */ }`.
   This is what makes "Dark" win regardless of OS preference. It
   duplicates the dark token list rather than sharing it with the
   media query — CSS custom properties don't have a clean way to
   alias one block to another, and the two blocks should be edited
   together going forward (a comment noting that is worth adding at
   both sites).

No new tokens, no color values change — every existing `--stage-3`,
`--accent`, `--sig-done`, etc. stays exactly as defined; this is purely
about *which* block of already-correct values applies when.

### 2.4 JS: read-early, no flash, defensive storage

- **Persisted value**: `localStorage`, one key (e.g. `wissel-theme`),
  one of `"light"` / `"dark"` / absent (absent = Auto/system). Per-
  browser only — appropriate for a personal dev-tool preference, no
  server sync needed or wanted.
- **Apply-before-paint**: the restore logic has to run and set
  `document.documentElement.dataset.theme` *before* the page's first
  paint, or a person who chose "Dark" on a light-OS machine sees a
  flash of light styling on every load. Concretely: an inline
  `<script>` placed right after the closing `</style>` tag in `<head>`
  (before `<body>`), not inside the existing IIFE at the bottom of the
  file which runs after the DOM (and therefore after first paint) is
  already up.
- **Defensive storage access**: wrap every `localStorage` read/write in
  try/catch and no-op on failure (private browsing, blocked storage,
  etc. can throw) — the page must still render correctly with no
  persisted preference, just falling back to Auto silently.
- **The toggle control itself** lives in the existing bottom-of-file
  IIFE alongside the Board/New-task segmented-control wiring, since it
  needs the DOM to exist. Clicking an option: set
  `document.documentElement.dataset.theme` (or remove the attribute
  for Auto), persist to `localStorage`, update the three buttons'
  `aria-pressed` state — the same pattern the Board/New-task toggle
  already uses.

### 2.5 Accessibility

- Real labeled buttons with `aria-pressed`, not a bare icon with no
  text — same as the existing `.segmented` control, so this is
  inherited for free by reusing that component.
- No animation/transition beyond what CSS custom properties already
  give for free (an instant value swap); nothing here needs a
  `prefers-reduced-motion` guard since nothing animates.

## 3. Scope

**In scope**: `src/api/public/board.html` only — CSS guard + override
block, the inline early-restore script, the segmented toggle control
and its click wiring. No backend involvement; this is a static-HTML,
vanilla-JS page with no build step, and the toggle doesn't change that.

**Out of scope**: server-side/account-level theme preference (this is
a single local file's localStorage, not a setting that could sync
across browsers or devices — nothing in wissel's architecture has a
per-user account to hang that off of, and it wasn't asked for); any
new visual redesign of dark mode itself (the existing dark token values
are unchanged, just made manually reachable).

## 4. Implementation plan

1. Add the `:not([data-theme="light"])` guard to the existing
   `@media (prefers-color-scheme: dark)` block.
2. Add the `:root[data-theme="dark"] { ... }` block, same values as
   the media query block, with a comment cross-referencing the two.
3. Add the early-restore inline `<script>` in `<head>`.
4. Add the 3-option segmented toggle markup to `.toolbar` (reusing
   `.segmented`/`.segmented button` CSS as-is).
5. Wire click handlers + `localStorage` persistence in the existing
   bottom-of-file IIFE.
6. e2e coverage (Playwright, matching this repo's existing pattern —
   no bun:test involved, since this is frontend-only behavior with no
   backend logic to unit-test): clicking each option sets
   `data-theme` correctly; the actual computed background-color
   changes (proving the CSS wiring works, not just the JS state); the
   choice survives a page reload; Auto with no stored preference falls
   back to whatever the media query would apply.

## 5. Open questions for whoever picks this up

- Confirm the three-state model (§2.1) rather than two — this is the
  one real behavioral fork in this doc; everything else is close to
  a single obvious answer.
- `localStorage` key name (`wissel-theme` used above is a placeholder,
  not a commitment) — pick something that won't collide if wissel ever
  stores other per-browser preferences here later.
