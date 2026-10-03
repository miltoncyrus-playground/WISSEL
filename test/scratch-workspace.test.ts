import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScratchWorkspace } from "../src/services/scratch-workspace.ts";

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-scratch-test-"));
}

test("resolveScratchWorkspace creates and returns ~/.wissel/scratch/<taskId>", async () => {
  const home = await fakeHome();
  try {
    const path = await resolveScratchWorkspace("t1", home);
    expect(path).toBe(join(home, ".wissel", "scratch", "t1"));
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).isDirectory()).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveScratchWorkspace is idempotent — a second call for the same task reuses the directory instead of erroring", async () => {
  const home = await fakeHome();
  try {
    const first = await resolveScratchWorkspace("t1", home);
    const second = await resolveScratchWorkspace("t1", home);
    expect(second).toBe(first);
    expect(existsSync(second)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("resolveScratchWorkspace scopes different tasks to different directories", async () => {
  const home = await fakeHome();
  try {
    const a = await resolveScratchWorkspace("task-a", home);
    const b = await resolveScratchWorkspace("task-b", home);
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
