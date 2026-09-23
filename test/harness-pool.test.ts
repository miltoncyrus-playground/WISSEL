import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessOverrideError, HarnessPool } from "../src/core/harness-pool.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { Harness } from "../src/core/types.ts";

function harness(overrides: Partial<Harness> & Pick<Harness, "id">): Harness {
  return { tool: "claude-cli", label: overrides.id, enabled: true, ...overrides };
}

test("from() rejects a duplicate id, mirroring Registry", () => {
  expect(() => HarnessPool.from([harness({ id: "a" }), harness({ id: "a" })])).toThrow(/duplicate harness id: a/);
});

test("all()/get() round-trip what from() was built with", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  expect(pool.all().map((h) => h.id)).toEqual(["a", "b"]);
  expect(pool.get("a")?.id).toBe("a");
  expect(pool.get("missing")).toBeUndefined();
});

test("acquire() returns undefined when no enabled harness matches the tool", () => {
  const pool = HarnessPool.from([harness({ id: "a", enabled: false })]);
  expect(pool.acquire("claude-cli")).toBeUndefined();
});

test("acquire() ignores harnesses for a different tool", () => {
  const pool = HarnessPool.from([harness({ id: "a", tool: "claude-cli" })]);
  // @ts-expect-error — deliberately an unwired tool, to prove acquire() filters on it
  expect(pool.acquire("cursor-cli")).toBeUndefined();
});

test("acquire() picks the least-loaded enabled harness, balancing across repeated calls", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  const first = pool.acquire("claude-cli");
  const second = pool.acquire("claude-cli");
  expect(first?.id).not.toBe(second?.id);
  expect(pool.activeCount("a")).toBe(1);
  expect(pool.activeCount("b")).toBe(1);
});

test("release() drops activeCount back to 0, freeing the harness for the next pick", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  const first = pool.acquire("claude-cli")!;
  pool.acquire("claude-cli"); // both now at 1
  pool.release(first.id);
  expect(pool.activeCount(first.id)).toBe(0);
  // With `a` free again, the next acquire should land back on it.
  const third = pool.acquire("claude-cli");
  expect(third?.id).toBe(first.id);
});

test("a disabled harness is never picked even when it would otherwise be least-loaded", () => {
  const pool = HarnessPool.from([harness({ id: "a", enabled: false }), harness({ id: "b" })]);
  expect(pool.acquire("claude-cli")?.id).toBe("b");
  expect(pool.acquire("claude-cli")?.id).toBe("b");
});

test("setEnabled() mutates the live copy, visible to a subsequent acquire()", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  expect(pool.acquire("claude-cli")?.id).toBe("a");
  pool.release("a");

  const updated = pool.setEnabled("a", false);

  expect(updated?.enabled).toBe(false);
  expect(pool.get("a")?.enabled).toBe(false);
  expect(pool.acquire("claude-cli")).toBeUndefined();
});

test("setEnabled() returns undefined and changes nothing for an unknown id", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  expect(pool.setEnabled("missing", false)).toBeUndefined();
  expect(pool.get("a")?.enabled).toBe(true);
});

test("setEnabled() can set disabledReason (a failed re-validation attempt) without touching harnesses.yaml", () => {
  const pool = HarnessPool.from([harness({ id: "a", enabled: false, disabledReason: "not authenticated" })]);
  const updated = pool.setEnabled("a", false, "not authenticated");
  expect(updated?.disabledReason).toBe("not authenticated");
});

test("setEnabled() clears disabledReason when a human enables a harness — their choice supersedes the auto-diagnosis", () => {
  const pool = HarnessPool.from([harness({ id: "a", enabled: false, disabledReason: "not authenticated" })]);
  const updated = pool.setEnabled("a", true);
  expect(updated?.enabled).toBe(true);
  expect(updated?.disabledReason).toBeUndefined();
});

test("setModel() mutates the live copy, visible to a subsequent get()", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  const updated = pool.setModel("a", "claude-opus-5-5");
  expect(updated?.model).toBe("claude-opus-5-5");
  expect(pool.get("a")?.model).toBe("claude-opus-5-5");
});

test("setModel() returns undefined and changes nothing for an unknown id", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  expect(pool.setModel("missing", "claude-opus-5-5")).toBeUndefined();
  expect(pool.get("a")?.model).toBeUndefined();
});

test("setModel() with undefined clears a previously-set model", () => {
  const pool = HarnessPool.from([harness({ id: "a", model: "claude-opus-5-5" })]);
  const updated = pool.setModel("a", undefined);
  expect(updated?.model).toBeUndefined();
  expect(pool.get("a")?.model).toBeUndefined();
});

test("disabling an already-acquired harness doesn't interrupt what's already running under it", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  const acquired = pool.acquire("claude-cli")!;
  pool.setEnabled("a", false);

  // Still tracked as active — disable only affects the *next* pick, it
  // never forcibly releases in-flight work.
  expect(pool.activeCount(acquired.id)).toBe(1);
  pool.release(acquired.id);
  expect(pool.activeCount(acquired.id)).toBe(0);
});

test("acquire() with a harnessId forces that exact harness, bypassing least-loaded selection", () => {
  const pool = HarnessPool.from([harness({ id: "a" }), harness({ id: "b" })]);
  // "a" would lose to "b" under the normal balancing rule once loaded —
  // proves the forced pick really is forced, not just "happens to win."
  pool.acquire("claude-cli");
  const picked = pool.acquire("claude-cli", "a");
  expect(picked?.id).toBe("a");
  expect(pool.activeCount("a")).toBe(2);
});

test("acquire() with an unknown harnessId throws HarnessOverrideError, never falling back to the automatic pick", () => {
  const pool = HarnessPool.from([harness({ id: "a" })]);
  expect(() => pool.acquire("claude-cli", "missing")).toThrow(HarnessOverrideError);
  expect(() => pool.acquire("claude-cli", "missing")).toThrow(/unknown harness id "missing"/);
});

test("acquire() with a disabled harnessId throws HarnessOverrideError", () => {
  const pool = HarnessPool.from([harness({ id: "a", enabled: false })]);
  expect(() => pool.acquire("claude-cli", "a")).toThrow(HarnessOverrideError);
  expect(() => pool.acquire("claude-cli", "a")).toThrow(/harness "a" is disabled/);
});

test("acquire() with a harnessId belonging to a different tool throws HarnessOverrideError", () => {
  const pool = HarnessPool.from([harness({ id: "a", tool: "anthropic-api" })]);
  expect(() => pool.acquire("claude-cli", "a")).toThrow(HarnessOverrideError);
  expect(() => pool.acquire("claude-cli", "a")).toThrow(/harness "a" is a anthropic-api harness, not claude-cli/);
});

function loggedInRunner(email: string): CommandRunner {
  return async () => ({ stdout: JSON.stringify({ loggedIn: true, email }), stderr: "", exitCode: 0 });
}

test("autoload() lets a manual harnesses.yaml entry override a discovered account with the same id", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  const manifestPath = join(home, "harnesses.yaml");
  try {
    // Directory name .claude-personal derives to id "claude-personal" —
    // matching the manual entry below on purpose, to exercise the
    // override path (manual wins), the real-world scenario this
    // machine's own harnesses.yaml demonstrates.
    await mkdir(join(home, ".claude-personal"));
    await writeFile(
      manifestPath,
      'harnesses:\n  - id: claude-personal\n    tool: claude-cli\n    label: "Claude — personal"\n    enabled: true\n',
    );

    const pool = await HarnessPool.autoload(manifestPath, { runner: loggedInRunner("milton.cyrus@gmail.com"), homeDir: home, env: {} });

    // The manual label wins over what discovery would have generated
    // ("Claude — milton.cyrus@gmail.com") — proves precedence, not just
    // that the id survived.
    expect(pool.get("claude-personal")).toEqual({ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() keeps a discovered account that has no matching manual entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  try {
    await mkdir(join(home, ".claude-work"));
    const pool = await HarnessPool.autoload(join(home, "harnesses.yaml"), { runner: loggedInRunner("work@example.com"), homeDir: home, env: {} });
    expect(pool.get("claude-work")?.label).toBe("Claude — work@example.com");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() tolerates a missing harnesses.yaml — discovery alone is a valid result", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  try {
    await mkdir(join(home, ".claude-personal"));
    const pool = await HarnessPool.autoload(join(home, "does-not-exist.yaml"), { runner: loggedInRunner("x@example.com"), homeDir: home, env: {} });
    expect(pool.all().map((h) => h.id)).toEqual(["claude-personal"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// Reproduces the actual bug: harnesses.yaml is checked into git and can
// describe a config path from a completely different machine (a Mac
// path, here, checked out on Linux). Before validateHarness() existed,
// autoload() trusted this at face value and reported it enabled.
test("autoload() disables a manual entry whose declared env isn't actually authenticated here", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  const manifestPath = join(home, "harnesses.yaml");
  try {
    await writeFile(
      manifestPath,
      "harnesses:\n" +
        "  - id: claude-personal\n" +
        "    tool: claude-cli\n" +
        '    label: "Claude — personal"\n' +
        "    enabled: true\n" +
        "    env:\n" +
        '      CLAUDE_CONFIG_DIR: "/Users/milton.cyrus/.claude-personal"\n',
    );
    // Nothing under $HOME is logged in — the ambient discovery pass
    // finds zero accounts, and the runner reports "not logged in" for
    // any env it's asked to check, including the manual entry's.
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });

    const pool = await HarnessPool.autoload(manifestPath, { runner, homeDir: home, env: {} });

    const entry = pool.get("claude-personal");
    expect(entry?.enabled).toBe(false);
    // Everything else about the entry (label, env) survives — visible
    // and diagnosable, not silently dropped.
    expect(entry?.label).toBe("Claude — personal");
    expect(entry?.env).toEqual({ CLAUDE_CONFIG_DIR: "/Users/milton.cyrus/.claude-personal" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() layers in discovered codex-cli accounts alongside claude-cli ones", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  try {
    await mkdir(join(home, ".claude-personal"));
    await mkdir(join(home, ".codex-personal"));
    const runner: CommandRunner = async (cmd, opts) => {
      if (cmd[0] === "claude") return { stdout: JSON.stringify({ loggedIn: true, email: "milton@example.com" }), stderr: "", exitCode: 0 };
      // codex login status has no --json support (SDD §5) — one of the
      // four fixed plain-text lines instead.
      return opts.env?.CODEX_HOME?.endsWith(".codex-personal")
        ? { stdout: "Logged in using ChatGPT", stderr: "", exitCode: 0 }
        : { stdout: "Not logged in", stderr: "", exitCode: 0 };
    };

    const pool = await HarnessPool.autoload(join(home, "does-not-exist.yaml"), { runner, homeDir: home, env: {} });

    expect(pool.get("claude-personal")?.tool).toBe("claude-cli");
    expect(pool.get("codex-personal")).toEqual({
      id: "codex-personal",
      tool: "codex-cli",
      label: "Codex — ChatGPT",
      enabled: true,
      env: { CODEX_HOME: join(home, ".codex-personal") },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() layers in discovered ANTHROPIC_API_KEY* accounts alongside claude-cli ones", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  try {
    const pool = await HarnessPool.autoload(join(home, "does-not-exist.yaml"), {
      runner: async () => ({ stdout: "", stderr: "", exitCode: 1 }), // nothing under $HOME is logged in
      homeDir: home,
      env: { ANTHROPIC_API_KEY: "sk-ant-x", ANTHROPIC_API_KEY_WORK: "sk-ant-y" },
    });

    expect(pool.all().map((h) => h.id).sort()).toEqual(["anthropic-api", "anthropic-api-work"]);
    expect(pool.get("anthropic-api")?.tool).toBe("anthropic-api");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() disables a manual anthropic-api entry whose apiKeyEnv isn't set on this machine", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  const manifestPath = join(home, "harnesses.yaml");
  try {
    await writeFile(
      manifestPath,
      "harnesses:\n  - id: personal\n    tool: anthropic-api\n    label: Personal\n    enabled: true\n    apiKeyEnv: ANTHROPIC_API_KEY_PERSONAL\n",
    );

    const pool = await HarnessPool.autoload(manifestPath, { runner: async () => ({ stdout: "", stderr: "", exitCode: 1 }), homeDir: home, env: {} });

    expect(pool.get("personal")?.enabled).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() never probes a manual entry that's already disabled in the file", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  const manifestPath = join(home, "harnesses.yaml");
  try {
    await writeFile(manifestPath, "harnesses:\n  - id: off\n    tool: claude-cli\n    label: Off\n    enabled: false\n");
    let calls = 0;
    const runner: CommandRunner = async () => {
      calls++;
      return { stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 };
    };

    const pool = await HarnessPool.autoload(manifestPath, { runner, homeDir: home, env: {} });

    expect(pool.get("off")?.enabled).toBe(false);
    expect(calls).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
