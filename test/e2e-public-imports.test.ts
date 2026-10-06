import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Browser modules in src/api/public/*.js export only through a
// `if (typeof module !== "undefined") module.exports = ...` guard so the
// board can load them as plain <script>s. bun test accepts named imports
// from them; Playwright doesn't: package.json's "type": "module" makes Node
// load them as ESM, where `module` is undefined and nothing is exported.
// On 2026-10-06 e2e/board.spec.ts imported describeAgentHarnesses this way
// and all 41 board specs failed to load, while typecheck and bun test both
// passed. In e2e, call these from the page instead (page.evaluate on the
// globals the board's own <script> tags define).

test("no e2e spec imports a src/api/public module that has no ESM exports", async () => {
  const offenders: string[] = [];
  for (const file of (await readdir("e2e")).filter((f) => f.endsWith(".ts"))) {
    const source = await readFile(join("e2e", file), "utf8");
    for (const m of source.matchAll(/from\s+["'](\.\.\/src\/api\/public\/[^"']+\.js)["']/g)) {
      const target = await readFile(join("e2e", m[1]!), "utf8");
      if (!/^\s*export\s/m.test(target)) offenders.push(`${file} imports ${m[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});
