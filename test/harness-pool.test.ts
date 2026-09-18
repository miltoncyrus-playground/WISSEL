import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessPool } from "../src/core/harness-pool.ts";
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

    const pool = await HarnessPool.autoload(manifestPath, { runner: loggedInRunner("milton.cyrus@gmail.com"), homeDir: home });

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
    const pool = await HarnessPool.autoload(join(home, "harnesses.yaml"), { runner: loggedInRunner("work@example.com"), homeDir: home });
    expect(pool.get("claude-work")?.label).toBe("Claude — work@example.com");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("autoload() tolerates a missing harnesses.yaml — discovery alone is a valid result", async () => {
  const home = await mkdtemp(join(tmpdir(), "wissel-autoload-"));
  try {
    await mkdir(join(home, ".claude-personal"));
    const pool = await HarnessPool.autoload(join(home, "does-not-exist.yaml"), { runner: loggedInRunner("x@example.com"), homeDir: home });
    expect(pool.all().map((h) => h.id)).toEqual(["claude-personal"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
