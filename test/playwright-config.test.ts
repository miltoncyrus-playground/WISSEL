import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_PATH = join(import.meta.dir, "..", "playwright.config.ts");

// Real root cause found investigating e2e/board.spec.ts's non-
// deterministic failures: Playwright's webServer.env merges on top of
// process.env rather than replacing it, so any of these six off-by-
// default background-automation flags (gated in src/api/server.ts
// around line 1281-1324) exported in the ambient shell leaks straight
// into the e2e server. Reported by review (reproduced via a
// controlled A/B there, not independently re-run here — this
// environment's sandbox blocks the subprocess/Chromium spawns e2e
// needs): with WISSEL_ORCHESTRATOR leaked in, the real
// Orchestrator.sweep() loop actually routes and dispatches e2e
// fixture tasks mid-run, racing test assertions and producing a
// different failing subset on every identical run — not a fixture
// leak, a live background process. Checked as a substring of
// the webServer block itself so this can't pass by coincidentally
// matching unrelated text elsewhere in the file.
test("playwright.config.ts pins every background-automation flag off in webServer.env", async () => {
  const config = await readFile(CONFIG_PATH, "utf8");
  const start = config.indexOf("webServer: {");
  expect(start).toBeGreaterThan(-1);
  const body = config.slice(start);

  for (const flag of [
    "WISSEL_ORCHESTRATOR",
    "WISSEL_EXECUTE_WRITE_TIER",
    "WISSEL_MEMORY_CURATION",
    "WISSEL_AUTO_ARCHIVE",
    "WISSEL_MODEL_REFRESH",
    "WISSEL_MERGE_HEALTH",
    "WISSEL_MEMORY_INJECTION",
  ]) {
    expect(body).toMatch(new RegExp(`${flag}: "0",?`));
  }
});
