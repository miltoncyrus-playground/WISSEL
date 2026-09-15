import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeService } from "../src/services/worktree.ts";

async function run(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim() };
}

async function makeOriginRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-origin-"));
  await run(["init", "-b", "main"], dir);
  await run(["config", "user.email", "test@wissel.dev"], dir);
  await run(["config", "user.name", "wissel test"], dir);
  await writeFile(join(dir, "README.md"), "hello\n");
  await run(["add", "."], dir);
  await run(["commit", "-m", "init"], dir);
  return dir;
}

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wissel-worktrees-"));
}

test("create makes a worktree on a fresh branch off the origin repo", async () => {
  const origin = await makeOriginRepo();
  const root = await makeRoot();
  const service = new WorktreeService(root);

  const handle = await service.create(origin, "task-1");

  expect(handle.id).toBe("task-1");
  expect(handle.path).toBe(join(root, "task-1"));
  expect(handle.branch).toBe("wissel/task-1");
  expect(existsSync(handle.path)).toBe(true);

  const branches = await run(["branch", "--list", "wissel/task-1"], origin);
  expect(branches.stdout).toContain("wissel/task-1");

  await rm(origin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("create throws when repo is not inside a git repo", async () => {
  const notARepo = await mkdtemp(join(tmpdir(), "wissel-not-a-repo-"));
  const root = await makeRoot();
  const service = new WorktreeService(root);

  await expect(service.create(notARepo, "task-x")).rejects.toThrow("not inside a git repo");

  await rm(notARepo, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("destroy removes the worktree dir and its branch", async () => {
  const origin = await makeOriginRepo();
  const root = await makeRoot();
  const service = new WorktreeService(root);
  const handle = await service.create(origin, "task-2");

  await service.destroy(handle);

  expect(existsSync(handle.path)).toBe(false);
  const branches = await run(["branch", "--list", "wissel/task-2"], origin);
  expect(branches.stdout).toBe("");

  await rm(origin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("gc removes a clean, merged worktree but keeps a dirty one and a live one", async () => {
  const origin = await makeOriginRepo();
  const root = await makeRoot();
  const service = new WorktreeService(root);

  // Merged: commit inside the worktree, then fast-forward origin's main to
  // include it — HEAD is now an ancestor of main, and there are no
  // uncommitted changes, so gc() should remove this one.
  const merged = await service.create(origin, "merged");
  await writeFile(join(merged.path, "new-file.txt"), "content\n");
  await run(["add", "."], merged.path);
  await run(["commit", "-m", "work"], merged.path);
  await run(["merge", merged.branch], origin);

  // Dirty: fresh worktree with an uncommitted change — must be kept even
  // though it also happens to start out merged (no divergence yet).
  const dirty = await service.create(origin, "dirty");
  await writeFile(join(dirty.path, "scratch.txt"), "uncommitted\n");

  // Live: fresh, clean, and trivially "merged" (no divergence from main
  // yet) — would otherwise qualify for removal, so this is the case that
  // proves the liveIds exclusion actually works.
  const live = await service.create(origin, "live");

  const removed = await service.gc(["live"]);

  expect(removed).toEqual(["merged"]);
  expect(existsSync(merged.path)).toBe(false);
  expect(existsSync(dirty.path)).toBe(true);
  expect(existsSync(live.path)).toBe(true);

  await rm(origin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

test("gc is a no-op on a root directory that doesn't exist yet", async () => {
  const service = new WorktreeService(join(tmpdir(), "wissel-worktrees-never-created"));
  expect(await service.gc()).toEqual([]);
});
