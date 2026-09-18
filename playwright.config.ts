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
    command: "bun run src/api/server.ts",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: false,
    env: {
      WISSEL_PORT: String(PORT),
      WISSEL_DB_PATH: ":memory:",
      WISSEL_TELEMETRY_PATH: "/tmp/wissel-e2e-telemetry.jsonl",
    },
  },
});
