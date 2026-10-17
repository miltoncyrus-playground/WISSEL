// The merge path's smaller parts: the per-repo lock, the gate runner,
// a project's gate (store, seed, route), and Board.recordMerge.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { isRepoLocked, withRepoLock } from "../src/services/repo-lock.ts";
import { DEFAULT_GATE_TIMEOUT_MS, runGateCommand, runMergeGate, tailLines, validateMergeGate, WISSEL_MERGE_GATE, type GateCommandRunner } from "../src/services/merge-gate.ts";
import { seedMergeGateFor, SqliteProjectStore } from "../src/services/projects.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { createApp } from "../src/api/server.ts";
import { runViaBun } from "../src/executors/claude-cli.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wissel-merge-gate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---------- repo lock ----------

test("withRepoLock runs one holder at a time per repo, in arrival order, and reports the wait", async () => {
  const order: string[] = [];
  const hold = (name: string, ms: number) =>
    withRepoLock("/r", async ({ waitMs }) => {
      order.push(`${name} start`);
      await Bun.sleep(ms);
      order.push(`${name} end`);
      return waitMs;
    });

  const [a, b, c] = await Promise.all([hold("a", 60), hold("b", 10), hold("c", 10)]);

  expect(order).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  expect(a).toBeLessThan(30);
  expect(b).toBeGreaterThanOrEqual(50);
  expect(c).toBeGreaterThanOrEqual(b);
  expect(isRepoLocked("/r")).toBe(false);
});

test("withRepoLock: different repos don't wait on each other; /r and /r/ are one lock", async () => {
  const order: string[] = [];
  await Promise.all([
    withRepoLock("/x", async () => {
      await Bun.sleep(50);
      order.push("x");
    }),
    withRepoLock("/y", async () => void order.push("y")),
  ]);
  expect(order).toEqual(["y", "x"]);

  const seen: string[] = [];
  await Promise.all([
    withRepoLock("/r", async () => {
      await Bun.sleep(30);
      seen.push("first");
    }),
    withRepoLock("/r/", async () => void seen.push("second")),
  ]);
  expect(seen).toEqual(["first", "second"]);
});

test("withRepoLock releases on a throw, so the next caller still runs", async () => {
  const failing = withRepoLock("/r", async () => {
    throw new Error("boom");
  });
  const next = withRepoLock("/r", async () => "ran");
  await expect(failing).rejects.toThrow("boom");
  expect(await next).toBe("ran");
});

// ---------- gate runner ----------

test("runMergeGate: no gate is status none; commands run in order and stop at the first failure", async () => {
  expect(await runMergeGate(undefined, dir)).toEqual({ status: "none", runs: [], durationMs: 0 });
  expect(await runMergeGate({ commands: [] }, dir)).toEqual({ status: "none", runs: [], durationMs: 0 });

  const ran: string[][] = [];
  const fake: GateCommandRunner = async (argv, opts) => {
    ran.push(argv);
    expect(opts).toEqual({ cwd: dir, timeoutMs: DEFAULT_GATE_TIMEOUT_MS });
    return argv[0] === "fail" ? { exitCode: 2, output: "it broke\n", timedOut: false } : { exitCode: 0, output: "", timedOut: false };
  };
  const report = await runMergeGate({ commands: [["ok"], ["fail", "x y"], ["never"]] }, dir, fake);

  expect(ran).toEqual([["ok"], ["fail", "x y"]]);
  expect(report.status).toBe("failed");
  expect(report.runs.map((r) => r.exitCode)).toEqual([0, 2]);
  expect(report.feedback).toContain('`fail "x y"` exited 2');
  expect(report.feedback).toContain("it broke");
});

test("runGateCommand: real process, stderr folded into the output in order, exit code kept", async () => {
  const res = await runGateCommand(["sh", "-c", "echo one; echo two >&2; echo three; exit 7"], { cwd: dir, timeoutMs: 10_000 });
  expect(res).toEqual({ exitCode: 7, output: "one\ntwo\nthree\n", timedOut: false });
});

test("runGateCommand: a timeout kills the whole process group, including children holding the pipe", async () => {
  const t0 = Date.now();
  const res = await runGateCommand(["sh", "-c", "echo up; (sleep 30; echo child) & sleep 30"], { cwd: dir, timeoutMs: 300 });
  expect(Date.now() - t0).toBeLessThan(5_000);
  expect(res.timedOut).toBe(true);
  expect(res.exitCode).toBeNull();
  expect(res.output).toBe("up\n");
});

test("runGateCommand runs without the server's WISSEL_* settings, everything else kept", async () => {
  process.env.WISSEL_GATE_TEST_LEAK = "leaked";
  process.env.GATE_TEST_KEEP = "kept";
  try {
    const res = await runGateCommand(["sh", "-c", 'echo "[$WISSEL_GATE_TEST_LEAK][$GATE_TEST_KEEP]"'], { cwd: dir, timeoutMs: 10_000 });
    expect(res.output).toBe("[][kept]\n");
  } finally {
    delete process.env.WISSEL_GATE_TEST_LEAK;
    delete process.env.GATE_TEST_KEEP;
  }
});

test("tailLines keeps the last N lines", () => {
  expect(tailLines("a\nb\nc\nd\n", 2)).toBe("c\nd");
  expect(tailLines("only", 200)).toBe("only");
});

test("validateMergeGate accepts argv arrays and a positive timeout, refuses anything else", () => {
  expect(validateMergeGate([["bun", "run", "test"]], 1000)).toEqual({ ok: true, gate: { commands: [["bun", "run", "test"]], timeoutMs: 1000 } });
  expect(validateMergeGate([], undefined)).toEqual({ ok: true, gate: { commands: [] } });
  expect(validateMergeGate("bun run test", undefined).ok).toBe(false);
  expect(validateMergeGate([["bun", ""]], undefined).ok).toBe(false);
  expect(validateMergeGate([[]], undefined).ok).toBe(false);
  expect(validateMergeGate([["x"]], -5).ok).toBe(false);
  expect(validateMergeGate([["x"]], 1.5).ok).toBe(false);
});

// ---------- the project's gate ----------

function wisselCheckout(path: string): string {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "wissel" }));
  Bun.spawnSync(["git", "init", "-q"], { cwd: path });
  return path;
}

test("seedMergeGateFor: wissel's own checkout gets typecheck + test; anything else none", () => {
  const wissel = wisselCheckout(join(dir, "wissel"));
  mkdirSync(join(dir, "other"));
  writeFileSync(join(dir, "other", "package.json"), JSON.stringify({ name: "other" }));
  expect(seedMergeGateFor(wissel)).toEqual([["bun", "run", "typecheck"], ["bun", "run", "test"]]);
  expect(seedMergeGateFor(join(dir, "other"))).toBeUndefined();
  expect(seedMergeGateFor(join(dir, "missing"))).toBeUndefined();
  expect(WISSEL_MERGE_GATE).toEqual([["bun", "run", "typecheck"], ["bun", "run", "test"]]);
});

test("migration: an existing projects table gains mergeGate, seeded once for a registered wissel checkout only", async () => {
  const wissel = wisselCheckout(join(dir, "wissel"));
  const other = join(dir, "other");
  mkdirSync(other);
  const db = new Database(":memory:");
  // The table as it was before this column existed.
  db.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, source TEXT NOT NULL, sourceUrl TEXT, createdAt TEXT NOT NULL, eli5 TEXT, eli5UpdatedAt TEXT)");
  db.run("INSERT INTO projects VALUES ('w', 'wissel', ?, 'local', NULL, '2026-01-01', NULL, NULL)", [wissel]);
  db.run("INSERT INTO projects VALUES ('o', 'other', ?, 'local', NULL, '2026-01-01', NULL, NULL)", [other]);

  const store = new SqliteProjectStore(db);
  expect(await store.mergeGateFor(wissel)).toEqual({ commands: WISSEL_MERGE_GATE });
  expect(await store.mergeGateFor(`${wissel}/`)).toEqual({ commands: WISSEL_MERGE_GATE });
  expect(await store.mergeGateFor(other)).toBeUndefined();

  // Cleared by a human, it stays cleared on the next open.
  await store.setMergeGate("w", null);
  const reopened = new SqliteProjectStore(db);
  expect(await reopened.mergeGateFor(wissel)).toBeUndefined();
});

test("setMergeGate sets the commands and timeout; addLocalProject seeds a wissel checkout", async () => {
  const db = new Database(":memory:");
  const store = new SqliteProjectStore(db);
  const added = await store.addLocalProject(wisselCheckout(join(dir, "wissel")), {}, runViaBun);
  if ("error" in added) throw new Error(added.error);
  expect(added.project.mergeGate).toEqual(WISSEL_MERGE_GATE);

  const set = await store.setMergeGate(added.project.id, [["make", "check"]], 120_000);
  expect(set).toMatchObject({ mergeGate: [["make", "check"]], mergeGateTimeoutMs: 120_000 });
  expect(await store.mergeGateFor(added.project.path)).toEqual({ commands: [["make", "check"]], timeoutMs: 120_000 });
  expect((await store.list())[0]).toMatchObject({ mergeGate: [["make", "check"]], mergeGateTimeoutMs: 120_000 });
  await expect(store.setMergeGate("nope", null)).rejects.toThrow("project not found");
});

test("POST /projects/:id/merge-gate sets, validates and clears a project's gate", async () => {
  const board = new SqliteBoard();
  const fetchApp = createApp(board, await Registry.load(), undefined, {});
  const repo = join(dir, "repo");
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  const created = await fetchApp(new Request("http://x/projects/local", { method: "POST", body: JSON.stringify({ path: repo }) }));
  const project = (await created.json()) as { id: string };
  const post = (body: unknown) => fetchApp(new Request(`http://x/projects/${project.id}/merge-gate`, { method: "POST", body: JSON.stringify(body) }));

  const set = await post({ mergeGate: [["sh", "-c", "true"]], mergeGateTimeoutMs: 5000 });
  expect(set.status).toBe(200);
  expect(await set.json()).toMatchObject({ mergeGate: [["sh", "-c", "true"]], mergeGateTimeoutMs: 5000 });

  const bad = await post({ mergeGate: "bun run test" });
  expect(bad.status).toBe(400);

  const cleared = await post({ mergeGate: null });
  expect(((await cleared.json()) as { mergeGate?: unknown }).mergeGate).toBeUndefined();

  expect((await fetchApp(new Request("http://x/projects/nope/merge-gate", { method: "POST", body: "{}" }))).status).toBe(404);
});

// ---------- Board.recordMerge ----------

test("recordMerge stamps mergedSha and mergedAt on the latest result in one write; getResult reads them back", async () => {
  const board = new SqliteBoard();
  const t = await board.create({ title: "t", body: "", labels: [], repo: "/r" });
  await board.recordResult({ taskId: t.id, agentId: "a", ok: true, summary: "first" });
  await board.recordResult({ taskId: t.id, agentId: "a", ok: true, summary: "second", worktree: { path: "/w", branch: "wissel/t" } });
  expect((await board.getResult(t.id))!.mergedSha).toBeUndefined();

  await board.recordMerge(t.id, "abc123");

  const r = (await board.getResult(t.id))!;
  expect(r).toMatchObject({ summary: "second", mergedSha: "abc123", worktree: { path: "/w", branch: "wissel/t" } });
  expect(Date.parse(r.mergedAt!)).not.toBeNaN();
  await expect(board.recordMerge("no-such-task", "x")).rejects.toThrow("no result to record a merge on");
});
