# SDD: AI news podcast pipeline

Status: approved 2026-10-07. Milton's decisions: read-out is browser
speech, runs are on demand, cheaper model where it makes sense (§3.2).
First non-development pipeline in wissel.

## 1. Why

Milton wants a short, plain-language briefing on what happened in AI,
gathered from the web, rewritten so a non-expert gets it, shaped as a
podcast script, and shown to him either to listen to (read aloud) or to
skim (quick read). Every pipeline so far is a development loop
(implementer, reviewer). This one has no repo, no diff and no worktree.

## 2. Goal and measurable outcome

- A stored pipeline **"AI news podcast"** with three steps:
  gather news, explain it simply (ELI5), write the podcast script. It
  runs from the Pipelines page with one click and no repo.
- The finished run shows, in its run drawer, a **Quick read** (one line
  per story plus its source link) and the **podcast script**, with a
  **Read aloud** button (play, pause, stop) that reads the script in the
  browser.
- **Outcomes, checked on a real run:**
  1. Every story in the output carries a source URL that the gather
     step actually fetched or found (no invented links). The final
     step's output is checked deterministically against the gather
     step's handoff data (§5).
  2. Stories are recent: each has a date within the last 7 days of the
     run (the gather step must return the date; items without one are
     dropped).
  3. Each story cites its own page, preferably the primary source: no
     URL is shared by two stories, and no site is the first source of
     more than 3 stories (revision 2026-10-07: the first live run cited
     one roundup page for 5 stories and its site for 7 of 8).
  4. One run costs under $1.50 (telemetry `result` events for the run's
     three step tasks).
  5. Read aloud works on the LAN board (plain HTTP) in Chrome on
     desktop and on Milton's phone.

## 3. Design

### 3.1 Web access for a readonly agent (the one engine change)

Readonly agents run `claude -p --permission-mode plan` with no tool
grants (`src/executors/readonly.ts:91`). Checked live 2026-10-07: in
that mode `WebSearch` is denied (`permission_denials` lists it); with
`--allowedTools WebSearch WebFetch` added, the same call searched and
returned real results.

Add `web` to the `toolAccess` values in `agents/manifest.yaml`. When a
readonly agent's `toolAccess` includes `web`, `ReadOnlyExecutor` passes
`allowedTools: ["WebSearch", "WebFetch"]` to `runClaude`. Nothing else
changes: no write, no bash, still plan mode. Agents without `web` get
exactly today's command line (loop over every real manifest entry and
assert the built command is unchanged, per memory/lessons.md "Tests:
use the real dispatch path").

### 3.2 Three new agents (agents/manifest.yaml)

All `tier: readonly`, `executor: readonly`, each with one unique tag
(so they never collide with existing routing, see the pipeline-reviewer
comment in the manifest) and `outputContractFormat: pipeline-handoff`,
so each step's structured output is handed to the next as fenced data
(`buildNextStepBody`, `src/core/pipeline-runner.ts:303`).
Model: `claude-sonnet-5-5` for all three. Revision 2026-10-07, Milton:
use a cheaper model where it makes sense. Sonnet is half opus's price;
haiku was not chosen because gathering needs source judgment and the
script must read well aloud. Change any of them in the model table.

1. **ai-news-gatherer** (`toolAccess: [web]`). Finds the most important
   AI news of the last 7 days (default 6 to 8 stories, mix of research,
   products, policy, industry). Prefers primary sources (lab blogs,
   papers, official announcements) over aggregators. Handoff `data`:
   `{ "generatedAt", "stories": [{ "title", "date", "sources": [url...],
   "facts": "what happened, 2-4 sentences, only what the sources say" }] }`.
   A story with no date or no source URL is dropped, not guessed.
2. **eli5-explainer** (no tools). For each story: a plain-language
   explanation a curious 12-year-old could follow, why it matters, and
   one honest "what we don't know yet" line. Keeps every story's
   `sources` untouched. No new facts beyond the handed-off `facts`.
3. **podcast-scriptwriter** (no tools). Turns the explained stories into
   a single-host spoken script of about 5 minutes (roughly 700 to 900
   words): short intro, one segment per story with spoken transitions,
   a short outro. Written for the ear: short sentences, no markdown
   tables, no URLs read out. Also produces the quick read. Final handoff
   `data`: `{ "quickRead": [{ "headline", "oneLine", "source" }],
   "script": "plain text with paragraph breaks", "wordCount" }`.

### 3.3 The pipeline definition

Stored through the existing `POST /pipelines` (not hard-coded in the
engine): three steps in a line, `transition: "all"` on the first two,
seeded by a small idempotent script (`scripts/seed-ai-news-pipeline.ts`,
`bun run seed:ai-news`) so it can be recreated. Also added as a
template in `pipeline-editor/src/templates.ts` so it shows under "New
pipeline". The run input is optional free text ("focus on open models",
"last 3 days"), passed to the gather step.

### 3.4 Runs without a repo

`startPipelineRun` takes a required `repo` (`src/core/pipeline-runner.ts:58`).
For a pipeline whose steps are all readonly agents with no
`write`/`bash` access, `repo` becomes optional: the run's tasks get
the per-task scratch workspace readonly agents already use
(`resolveScratchWorkspace`, `~/.wissel/scratch/<taskId>`). A pipeline
with any write-tier step still requires a repo and fails loud without
one. The Run dialog hides the repo field for a repo-less pipeline.

### 3.5 Presenting the result

In the run drawer (B1), when the run's last step output has
`quickRead` and `script`:

- **Quick read** tab (default): the headlines, one line each, each
  linking to its source (`target="_blank" rel="noopener"`).
- **Listen** tab: the script as text, with **Read aloud**, **Pause**
  and **Stop** buttons using the browser's Web Speech API
  (`speechSynthesis`, `SpeechSynthesisUtterance`). It isn't restricted
  to secure contexts, so it works over plain HTTP on the LAN; check the
  MDN note anyway, per memory/lessons.md. Speak paragraph by paragraph
  (one utterance each), since long single utterances are cut off in
  Chrome. Prefer an English voice; a voice picker is optional. If
  `speechSynthesis` is missing, hide the buttons and say so.
- A **Copy script** button is not included: `navigator.clipboard` needs
  a secure context. Selecting the text works.

The parsing and shaping (handoff data to quick-read rows and script
paragraphs) lives in a small public module
(`src/api/public/board-news.js`, CJS guard like its siblings) so it is
unit-tested without a browser.

### 3.6 Guarding against invented content

The gather step's prompt forbids inventing stories, dates or URLs. A
deterministic check in `board-news.js` (and in the eval) compares every
`source` in the final `quickRead` against the URLs in the gather step's
handoff; a source that isn't in that set is flagged in the drawer
("source not from the gather step") instead of being shown as normal.

## 4. Tests (gate lane, every card)

- `web` grant: a readonly agent with `toolAccess: [web]` gets
  `--allowedTools WebSearch WebFetch` in its command; every existing
  manifest agent's command is unchanged; a write-tier agent with `web`
  is rejected at registry load (web grant is for readonly only).
- Manifest: the three agents load, have unique tags, declare
  `pipeline-handoff`, and the gatherer is the only one with `web`.
- Repo-less runs: an all-readonly pipeline starts with no repo and its
  step tasks get scratch workspaces; a pipeline with a write-tier step
  and no repo fails with a clear error (API test).
- Seed script: idempotent (running twice leaves one pipeline).
- `board-news.js`: shaping from a recorded final handoff; missing or
  malformed data shows the raw output instead of breaking the drawer;
  a source not in the gather set is flagged.
- e2e (`e2e/pipelines.spec.ts`): a finished run with a fixture final
  handoff shows Quick read with links and Listen with the buttons;
  `speechSynthesis.speak` is stubbed in `addInitScript` and asserted to
  receive one utterance per paragraph; with `speechSynthesis` removed
  the buttons are hidden.

## 5. Eval (periodic lane, paid)

`eval/ai-news-podcast.eval.ts` (`bun run eval:ai-news`): runs the real
pipeline once and asserts, deterministically on the outputs:
every final source URL is in the gather step's set; every story has a
date within 7 days; script word count 600 to 1000; 5 to 8 stories;
run cost under $1.50 from telemetry. Pass threshold: all checks, 2 of
3 runs (web results vary). Not run on every commit.

## 6. Non-goals

- Audio files (MP3) or server-side text to speech. That would need a
  hosted TTS service, which CLAUDE.md rules out without Milton's say-so.
  Browser read-aloud covers "read-out" for now; an audio file is a
  follow-up if he wants one.
- A daily schedule. Runs are on demand. A schedule (like the memory
  curator's) is an easy follow-up once the output is good.
- Delivery to email or phone notifications.

## 7. Build plan (wissel cards)

1. **Engine + agents + pipeline:** §3.1 to §3.4, the seed script and
   template, tests from §4 for those parts, and the eval (§5).
   Labels: `code`.
2. **Presentation:** §3.5 and §3.6 in the run drawer, `board-news.js`,
   unit and e2e tests. Depends on card 1. Labels: `code`.
