import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// pipeline-editor/dist/ and app/dist/ are gitignored and served as is
// (src/api/server.ts DEFAULT_PIPELINE_EDITOR_DIST, src/api/serve-app.ts
// DEFAULT_APP_DIST). On 2026-10-10 a merged template change (the
// explain step's rename) left the live server and the e2e suite on the
// previous bundle until a manual rebuild. Both entry points now build
// both bundles first.

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

test("build:editor builds the pipeline editor bundle", () => {
  expect(pkg.scripts["build:editor"]).toBe("cd pipeline-editor && npm run build");
});

test("build:app builds the wissel app bundle (docs/SDD-wissel-app.md §3.1)", () => {
  expect(pkg.scripts["build:app"]).toBe("cd app && npm run build");
});

test("serve builds the editor and the app before starting the server, and stops if a build fails", () => {
  expect(pkg.scripts.serve).toMatch(/^bun run build:editor && bun run build:app && bun run src\/api\/server\.ts$/);
});

test("the e2e web server builds the editor and the app before starting", async () => {
  const config = await readFile(join(root, "playwright.config.ts"), "utf8");
  expect(config).toMatch(/command:\s*\n\s*"bun run build:editor && bun run build:app && /);
});
