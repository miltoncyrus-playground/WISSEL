import { defineConfig, devices } from "@playwright/test";

const PORT = 8790;

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
  // This environment ships a pinned Chromium build that doesn't always
  // match whatever revision the installed @playwright/test version
  // wants to download (it's blocked from downloading anyway) — point
  // straight at the pre-installed binary instead of letting Playwright
  // resolve its own.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { executablePath: "/opt/pw-browsers/chromium" } },
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
    command: "cp e2e/fixtures/harnesses.yaml /tmp/wissel-e2e-harnesses.yaml && cp e2e/fixtures/models-cache.json /tmp/wissel-e2e-models-cache.json && bun run src/api/server.ts",
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
    },
  },
});
