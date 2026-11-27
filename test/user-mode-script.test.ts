import { describe, expect, test } from "bun:test";
import { buildUserModeScript } from "../src/api/server.ts";
import { USER_VOCABULARY } from "../src/core/user-vocabulary.ts";

describe("/user-mode.js", () => {
  test("bundles into one classic script that sets window.WisselUserMode", async () => {
    const js = await buildUserModeScript();
    expect(js).toContain("WisselUserMode");
    // A classic script: no module syntax left for the browser to reject.
    expect(js).not.toMatch(/^\s*(import|export)\s/m);
    // The table is bundled in, not fetched: one source of truth.
    expect(js).toContain(USER_VOCABULARY.worktree.user);
  });

  test("is built once per process", async () => {
    expect(await buildUserModeScript()).toBe(await buildUserModeScript());
  });
});
