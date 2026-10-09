# SDD: Wissel retrospective podcast

Status: approved 2026-10-10 (Milton asked for it). Builds on
docs/SDD-ai-news-podcast.md: same script and audio steps, same drawer.

## 1. Why

Milton wants a podcast-style briefing on his own work in wissel: what he
did with it, the key learnings, what can be improved, and new features
to think about. The facts are already on this machine (the board, git,
telemetry, memory/lessons.md, the SDDs). Gathering them is deterministic
work, so it's code; only the judgment (what mattered, what to learn,
what to build next) is an LLM step.

## 2. Goal and measurable outcome

- A stored pipeline **"Wissel retrospective podcast"**: Collect activity
  → Analyse → Write podcast script → Make audio. Runs on demand with no
  repo. The run input optionally sets the period: `last 30 days`,
  `since 2026-10-01`; default is the last 7 days.
- The drawer shows Quick read (one line per item, linked to its commit)
  and Listen (MP3 plus script), exactly as for the news pipelines.
- **Outcomes, checked on a real run:**
  1. Every number in the analysis comes from the collect step (cards,
     costs, counts); every Quick read link is one the collect step
     produced (the existing `sources-from-gather` check).
  2. All four groups are present: `done`, `learnings`, `improve`,
     `ideas`.
  3. Learnings and improvements cite evidence: each has at least one
     source from the collect step.
  4. Run cost under $1.00 (no web search, one analysis call, one script
     call; collect and audio cost nothing).

## 3. Design

### 3.1 Collect activity (deterministic executor, no LLM)

New agent `wissel-digest` (`kind: skill`, `tier: readonly`,
`toolAccess: []`, `executor: digest`, unique tag, costProfile model
`none`, estUsdPerTask 0) run by a new `DigestExecutor`
(src/executors/digest.ts, no `harnessTool`, like TtsExecutor). The
building logic lives in a pure module (src/services/wissel-digest.ts)
that takes its inputs as arguments (board, telemetry path, lessons path,
docs dir, git runner, now) so it is unit-testable.

Period: parse the run input deterministically (`last N days`,
`since YYYY-MM-DD`, else 7 days), counted back from `now`.

Inputs and what is taken from each:

- **Board** (`Board.list()`, `getResult`): cards created or finished in
  the period, grouped by lineage (`reviewLineageId ?? id`; reviewer,
  pushback and integrator cards fold into their root). Per lineage:
  title, final status, number of review passes and pushbacks,
  escalations, failures with their reason (first line), total cost.
  Pipeline runs grouped by pipeline name with run count and cost. A
  card whose `repo` is a task worktree (`~/.wissel/worktrees/...`) is
  attributed to its lineage root's repo.
- **Git**: for every repo on the board that is a git checkout, merge
  commits in the period (`Merge wissel/<id>: <title>` links a commit to
  its card). Run through the existing CommandRunner, read-only commands
  only (`git -C <repo> log`, `git -C <repo> remote get-url origin`).
  A GitHub origin (https or ssh form) becomes
  `https://github.com/<owner>/<repo>/commit/<sha>` links; any other
  origin gives no link.
- **Telemetry**: spend in the period, by agent, harness and model;
  count of 429 retries.
- **memory/lessons.md**: the current text (capped at 6 KB).
- **docs/SDD-*.md**: files added or changed in the period (from git),
  with their first heading.

Output (pipeline-handoff `data`), kept small enough for one prompt
(cap: 40 items, facts ≤ 400 chars each, whole payload ≤ 40 KB, with a
`truncated` count when capped):

```json
{
  "period": {"from": "2026-10-03", "to": "2026-10-10", "days": 7},
  "stats": {"cards": 0, "done": 0, "failed": 0, "escalated": 0,
            "reviewPasses": 0, "pushbacks": 0, "spendUsd": 0,
            "byAgent": {}, "byHarness": {}, "byModel": {}, "retries429": 0,
            "pipelineRuns": {}},
  "stories": [{"title": "...", "date": "YYYY-MM-DD",
               "sources": ["https://github.com/.../commit/<sha>"],
               "facts": "merged after 2 review passes, $3.10, 1 pushback"}],
  "lessons": "...",
  "docs": [{"file": "docs/SDD-x.md", "title": "..."}],
  "truncated": 0
}
```

`stories` uses the news shape on purpose: the drawer's gather-source
check (board-news.js `gatherUrlSet`) and `sources-from-gather` work
unchanged. A story with no link has `sources: []`.

### 3.2 Analyse (LLM, no tools)

New agent `wissel-retro-analyst` (readonly, `toolAccess: []`, sonnet,
unique tag, `outputContractFormat: pipeline-handoff`). Input: the
digest. Output: the explained-story shape the scriptwriter already
takes, plus a `group`:

- `done` (3 to 5): what Milton built or achieved, biggest first.
- `learnings` (2 to 4): grounded in lessons.md, failures, pushbacks and
  escalations.
- `improve` (2 to 3): grounded in the stats (failure or pushback rates,
  cost, retries, stuck cards).
- `ideas` (2 to 3): new features worth considering, each tied to
  evidence in the digest.

Each item: `group`, `title`, `date` (period end for learnings, improve
and ideas), `sources` (copied unchanged from the digest items it rests
on; at least one for learnings and improve), `explanation`,
`whyItMatters`, `unknowns`. Hard rules: no number, card, date or URL
that is not in the digest; second person ("you"), plain words; no
flattery.

### 3.3 Script and audio (shared)

`podcast-scriptwriter` today groups stories by `region`. Generalise the
rule to "`region` or `group`" with a spoken lead-in per group
("what you built", "what you learned", "what to improve", "ideas to
think about"), keeping input order. No other change; the AI and world
pipelines are unaffected (their stories have no `group`). Audio is the
existing `podcast-audio` step.

### 3.4 Template, seed, checks

- `wisselRetroPodcastDraft()` in pipeline-editor/src/templates.ts and
  in `builtInTemplates()`; `bun run seed:ai-news` seeds it too
  (rename nothing; one seed command for all podcast pipelines).
- `checkRetroRun` in eval/ai-news-checks.ts: gather-shape (stories may
  be few, min 1), final-shape, sources-from-gather, `groups` (all four
  present), `evidence` (every learnings/improve item has a source in
  the digest), word-count, cost under $1.00. No `dates-recent`,
  `sources-per-story` or `source-spread` (several ideas may rest on the
  same commit). `bun run eval:wissel-retro`.

## 4. Tests (gate lane)

- wissel-digest: period parsing (default, `last N days`, `since`,
  garbage falls back to 7); lineage folding (reviewer, pushback and
  integrator cards counted under the root, worktree repo mapped to the
  root's repo); merge-commit to card linking; GitHub URL from https and
  ssh origins, none for a non-GitHub origin; telemetry sums in and out
  of the window; caps and `truncated`; read-only git commands only
  (assert the commands the runner received). Use an in-memory board, a
  temp git repo, and a telemetry fixture.
- DigestExecutor: returns a pipeline-handoff with that data; no harness.
- Manifest: both new agents load with unique tags; `digest` handled
  only by DigestExecutor; every other agent's executor resolution and
  command line unchanged.
- Scriptwriter contract mentions `group`; AI and world templates
  unchanged.
- Template, seed (all three pipelines coexist, reseed is a no-op),
  `checkRetroRun` (good run passes; missing group fails; an improve
  item with no source fails; a link not in the digest fails).
- e2e: the editor template test already loops over `builtInTemplates()`.

## 5. Non-goals

- Reading Claude Code session transcripts outside wissel.
- Scheduling (on demand only, like the others).
- Charts in the drawer; the Quick read and script are the output.
