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
    command:
      "cp e2e/fixtures/harnesses.yaml /tmp/wissel-e2e-harnesses.yaml && cp e2e/fixtures/models-cache.json /tmp/wissel-e2e-models-cache.json && cp e2e/fixtures/mcp-servers.yaml /tmp/wissel-e2e-mcp-servers.yaml && bun run src/api/server.ts",
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
    },
  },
});
