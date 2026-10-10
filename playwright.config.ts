import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 8790;

/** The hardcoded `/opt/pw-browsers/chromium` path this config used to
 *  point at has never actually existed on this machine (confirmed live —
 *  `/opt` is root-owned, so no session, sandboxed or not, could have
 *  provisioned it without sudo) — every e2e run was failing with
 *  "executable doesn't exist at /opt/pw-browsers/chromium" regardless of
 *  sandbox, not because of a sandbox restriction. Real Chromium installs
 *  already exist at the normal Playwright cache location instead.
 *
 *  Picking the *newest* cached revision isn't enough, confirmed live the
 *  hard way: the newest one present here (1243, matching what the
 *  installed `@playwright/test` nominally wants) launches `--version`
 *  fine but fails every real headless launch with "FATAL:
 *  gin/v8_initializer.cc: Error loading V8 startup snapshot file" — its
 *  `v8_context_snapshot.bin` is missing entirely (an install left
 *  incomplete, almost certainly by one of this session's own power
 *  outages interrupting a `playwright install` download mid-write). The
 *  older 1234 revision has that file and launches real tests cleanly.
 *  So this checks for `v8_context_snapshot.bin` alongside `chrome` as the
 *  "actually complete, not just present" signal, newest-complete-first —
 *  not just file existence, which 1243's own broken install still
 *  passes. Falls back to Playwright's own default resolution
 *  (`undefined`) if no complete cached revision is found at all, rather
 *  than hardcoding a path that might not exist either. This will need
 *  revisiting again whenever a *genuinely* complete newer revision lands
 *  (e.g. a successful `playwright install` finishes without another
 *  outage interrupting it) — same fragility named here, not hidden. */
function resolveChromiumExecutable(): string | undefined {
  const cacheRoot = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cacheRoot)) return undefined;
  const revisions = readdirSync(cacheRoot)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .reverse();
  for (const revision of revisions) {
    const dir = join(cacheRoot, revision, "chrome-linux64");
    const candidate = join(dir, "chrome");
    if (existsSync(candidate) && existsSync(join(dir, "v8_context_snapshot.bin"))) return candidate;
  }
  return undefined;
}

/**
 * Smoke-test only — wissel has no broader e2e suite. Boots a real
 * server against an in-memory board so tests never touch a developer's
 * ~/.wissel data, and drives the real manifest (agents/manifest.yaml)
 * rather than a fixture, so a test failure means the real UI broke.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  // Points straight at whatever real Chromium is actually cached on disk
  // instead of letting Playwright demand an exact-revision download that's
  // blocked anyway — see resolveChromiumExecutable's own doc comment.
  // `undefined` falls through to Playwright's own default resolution.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: resolveChromiumExecutable() } },
    },
  ],
  webServer: {
    // Seeds the two disposable tmp fixtures the model-selection tests in
    // e2e/board.spec.ts mutate for real (WISSEL_HARNESSES_PATH,
    // WISSEL_MODELS_CACHE_PATH below) *before* the server boots — both
    // are read once at startup (HarnessPool.autoload/readModelsCache),
    // so they have to exist on disk before `bun run src/api/server.ts`
    // starts, not just before the tests that use them run. Copied fresh
    // from e2e/fixtures/ on every run rather than pointed at the fixture
    // files directly, so a mutating test never touches the checked-in
    // originals — same "never touch the real file" discipline
    // WISSEL_MEMORY_PATH below already established.
    //
    // WISSEL_MEMORY_PATH and WISSEL_TELEMETRY_PATH have no checked-in
    // fixture to copy from (by design — see their own comments below), so
    // instead of copying a template they're deleted here before boot.
    // Without this, both files persist and accumulate across every
    // separate `playwright test` invocation ever run on this machine,
    // since nothing else ever clears them — confirmed live: the
    // telemetry file alone had 538 stale lines from prior runs, which
    // broke exact-count assertions in e2e/board.spec.ts (e.g. "Memory tab
    // shows the empty state" and "a curation run shows exactly 1 history
    // entry"). readMemoryLessons/readResultEvents already treat a missing
    // file as empty/no-events, so deleting (not recreating) is correct.
    //
    // /tmp/wissel-e2e-repo is the fake repo path every e2e test fills
    // into a `repo` field, but almost none of them actually spawn an
    // agent into it — they only ever create inert TaskCards for
    // UI-rendering assertions, so a nonexistent cwd never got exercised.
    // e2e/pipeline-editor.spec.ts is the one real exception: it drives a
    // genuine POST /pipelines/:id/run, which dispatches triager's
    // ReadOnlyExecutor (src/executors/readonly.ts) straight into
    // `Bun.spawn(cmd, { cwd: task.repo })` (src/executors/claude-cli.ts).
    // A nonexistent cwd makes that spawn throw ENOENT immediately,
    // caught and returned as `ok: false` ("failed to spawn claude: ...")
    // — which fails both of that test's entry steps and, by
    // handlePipelineStepResult's own design (src/core/pipeline-runner.ts:
    // a failed predecessor never activates a join), the join step never
    // even gets created. `mkdir -p` once here, same as the fixture
    // copies above, so the directory exists before any test (not just
    // this one) ever spawns into it.
    // `bun run build:editor` first: pipeline-editor/dist/ is gitignored
    // and the server serves it as is, so a template change (2026-10-10:
    // the explain step's rename) otherwise runs the e2e suite against
    // the previous bundle and fails for no reason in the code under test.
    command:
      "bun run build:editor && mkdir -p /tmp/wissel-e2e-repo && rm -f /tmp/wissel-e2e-memory-lessons.md /tmp/wissel-e2e-telemetry.jsonl && cp e2e/fixtures/harnesses.yaml /tmp/wissel-e2e-harnesses.yaml && cp e2e/fixtures/models-cache.json /tmp/wissel-e2e-models-cache.json && cp e2e/fixtures/mcp-servers.yaml /tmp/wissel-e2e-mcp-servers.yaml && bun run src/api/server.ts",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    env: {
      WISSEL_PORT: String(PORT),
      WISSEL_DB_PATH: ":memory:",
      WISSEL_TELEMETRY_PATH: "/tmp/wissel-e2e-telemetry.jsonl",
      // Isolated from the real project file — confirmed live the hard
      // way, twice: an e2e run without this overwrote the real,
      // git-committed memory/lessons.md with test fixture content.
      WISSEL_MEMORY_PATH: "/tmp/wissel-e2e-memory-lessons.md",
      // The first harness-*mutating* endpoint (POST
      // /harnesses/:id/model) the e2e suite exercises for real, unlike
      // the enable/disable test's deliberate abstention — see
      // e2e/fixtures/harnesses.yaml/models-cache.json's own comments for
      // why "e2e-fixture-harness" is deterministic across every machine.
      WISSEL_HARNESSES_PATH: "/tmp/wissel-e2e-harnesses.yaml",
      WISSEL_MODELS_CACHE_PATH: "/tmp/wissel-e2e-models-cache.json",
      // Same "disposable tmp copy, never the checked-in original"
      // discipline as WISSEL_HARNESSES_PATH above — see
      // e2e/fixtures/mcp-servers.yaml's own comment for why
      // "e2e-fixture-mcp" is deterministically reachable across every
      // machine.
      WISSEL_MCP_SERVERS_PATH: "/tmp/wissel-e2e-mcp-servers.yaml",
      // Pinned off regardless of whatever's ambient in the shell this
      // config runs under — Playwright's webServer.env merges on top of
      // process.env rather than replacing it, so a developer machine
      // with any of these six exported for their own real work (all are
      // off-by-default background-automation loops gated by
      // src/api/server.ts:1281-1324) leaks straight into the e2e server
      // and makes it a live participant instead of a hermetic fixture.
      // Reproduced via a controlled A/B (reviewer pass, this card's own
      // history): with WISSEL_ORCHESTRATOR leaked in, the real
      // Orchestrator.sweep() loop (src/core/orchestrator.ts) actually
      // routes and dispatches e2e fixture tasks mid-run — real
      // wissel-e2e-repo-* agent sessions spawning against junk fixture
      // titles, a "memory-scheduler: tick failed" log line, and a
      // different subset of tests failing on every run because the
      // sweep loop races test assertions non-deterministically; this
      // environment's sandbox blocks the subprocess/Chromium spawns
      // needed to re-run that A/B independently. An explicit falsy
      // override here beats merely "not setting" these,
      // since not setting a key still lets an ambient exported value of
      // the same name pass through untouched.
      WISSEL_ORCHESTRATOR: "0",
      WISSEL_EXECUTE_WRITE_TIER: "0",
      WISSEL_MEMORY_CURATION: "0",
      WISSEL_AUTO_ARCHIVE: "0",
      WISSEL_MODEL_REFRESH: "0",
      WISSEL_MERGE_HEALTH: "0",
      // Not a background loop like the six above — it only gates
      // whether a run's prompt includes memory/lessons.md — but pinned
      // off for the same hermetic-fixture reason: an ambient
      // WISSEL_MEMORY_INJECTION=1 in a developer's shell would otherwise
      // leak in and flip the Memory tab's injected-state wording e2e
      // checks assert against (see docs/SDD-memory-injection-toggle.md).
      WISSEL_MEMORY_INJECTION: "0",
      // The "Make audio" pipeline step (docs/SDD-ai-news-podcast.md §3.7):
      // pinned so an e2e server never writes into ~/.wissel/audio and
      // never reaches the real Kokoro on :8880. Port 9 (discard) refuses
      // connections, so a step that did run would fail fast and loud.
      WISSEL_AUDIO_DIR: "/tmp/wissel-e2e-audio",
      WISSEL_TTS_URL: "http://127.0.0.1:9",
      WISSEL_TTS_VOICE: "af_heart",
    },
  },
});
