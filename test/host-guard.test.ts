import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { OwnerTaskStore } from "../src/services/owner-tasks.ts";
import { DEFAULT_THRESHOLDS, HOST_GUARD_TASK_TITLE, HostGuard, hostProblems, largestEntries, readHost, thresholdsFromEnv, type HostReading } from "../src/services/host-guard.ts";
import { projectTempDirs } from "../scripts/host-check.ts";

// docs/SDD-coordinator.md §4.12, phase 1 card 6: below a threshold, hold
// new cards (running ones carry on) and raise one owner task with the
// evidence; its check reads the host again.

const healthy: HostReading = { load1: 1, cores: 4, memoryFreePct: 50, disk: [{ path: "/home", freeGb: 80, temp: false }, { path: "/tmp", freeGb: 4, temp: true }] };

describe("thresholds and readings", () => {
  test("defaults are load 3 x cores, 20% memory, 30 GB disk, 2 GB per temp dir; env overrides; bad values keep the default", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ loadPerCore: 3, minMemoryFreePct: 20, minDiskFreeGb: 30, minTempFreeGb: 2 });
    expect(thresholdsFromEnv({ WISSEL_HOST_GUARD_MIN_DISK_GB: "10", WISSEL_HOST_GUARD_LOAD_PER_CORE: "nope" })).toEqual({ ...DEFAULT_THRESHOLDS, minDiskFreeGb: 10 });
  });

  test("hostProblems names each shortfall, and nothing on a healthy host", () => {
    expect(hostProblems(healthy, DEFAULT_THRESHOLDS)).toEqual([]);
    const bad: HostReading = { load1: 13, cores: 4, memoryFreePct: 9, disk: [{ path: "/home", freeGb: 12, temp: false }, { path: "/tmp", freeGb: 0.5, temp: true }] };
    expect(hostProblems(bad, DEFAULT_THRESHOLDS)).toEqual([
      "load is 13.0 on 4 cores (hold at 12.0)",
      "only 9% of memory is available (hold below 20%)",
      "/home has 12.0 GB free (hold below 30 GB)",
      "/tmp has 0.5 GB free (hold below 2 GB, a temp directory)",
    ]);
  });

  test("readHost reads this machine; an unreadable path is left out, not counted as full", () => {
    const r = readHost(tmpdir(), [tmpdir(), "/no/such/dir"]);
    expect(r.cores).toBeGreaterThan(0);
    expect(r.memoryFreePct).toBeGreaterThan(0);
    expect(r.disk.map((d) => d.path)).toEqual([tmpdir(), tmpdir()]);
  });

  test("largestEntries lists the biggest entries first", () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-guard-"));
    try {
      mkdirSync(join(dir, "big"));
      writeFileSync(join(dir, "big", "a"), Buffer.alloc(200_000));
      writeFileSync(join(dir, "small"), "x");
      expect(largestEntries(dir).map((e) => e.path)).toEqual([join(dir, "big"), join(dir, "small")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HostGuard", () => {
  function guard(read: () => HostReading) {
    const raised: Array<{ title: string; why: string }> = [];
    const g = new HostGuard({
      worktreesDisk: "/home",
      tempDirs: async () => [{ path: "/tmp", runningCards: ["Build the thing"] }],
      read,
      raise: async (title, why) => void raised.push({ title, why }),
      log: () => {},
    });
    return { g, raised };
  }

  test("holds while short, raises one task per episode with the evidence, and lifts by itself", async () => {
    let reading = healthy;
    const { g, raised } = guard(() => reading);
    await g.refresh();
    expect(g.holding()).toBeUndefined();
    reading = { ...healthy, disk: [healthy.disk[0]!, { path: "/tmp", freeGb: 0.3, temp: true }] };
    await g.refresh();
    await g.refresh();
    expect(g.holding()).toContain("/tmp has 0.3 GB free");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title).toBe(HOST_GUARD_TASK_TITLE);
    expect(raised[0]!.why).toContain("Running cards writing there: Build the thing.");
    reading = healthy;
    await g.refresh();
    expect(g.holding()).toBeUndefined();
    reading = { ...healthy, load1: 20 };
    await g.refresh();
    expect(raised).toHaveLength(2);
  });
});

describe("in the app", () => {
  test("while the guard holds, Run answers 409 with its reason; GET /admin/host-guard shows it; the owner task's check is host:check", async () => {
    const board = new SqliteBoard();
    const ownerTasks = new OwnerTaskStore(board.db, board);
    let reading = { ...healthy, memoryFreePct: 5 };
    const hostGuard = new HostGuard({
      worktreesDisk: "/home",
      tempDirs: async () => [],
      read: () => reading,
      raise: async (title, why, steps) => void (await ownerTasks.create({ title, why, steps, check: ["bun", "run", "host:check"] })),
      log: () => {},
    });
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), hostGuard, ownerTasks });
    await hostGuard.refresh();
    const card = await board.create({ title: "queued", body: "", labels: [], repo: "r" });
    const run = await app(new Request(`http://x/tasks/${card.id}/run`, { method: "POST" }));
    expect(run.status).toBe(409);
    expect(((await run.json()) as { error: string }).error).toContain("host guard is holding new cards: only 5% of memory");
    expect(await (await app(new Request("http://x/admin/host-guard"))).json()).toMatchObject({ enabled: true, holding: expect.stringContaining("memory") });
    expect(ownerTasks.list("open").map((t) => [t.title, t.check])).toEqual([[HOST_GUARD_TASK_TITLE, ["bun", "run", "host:check"]]]);
    reading = healthy;
    await hostGuard.refresh();
    expect(await (await app(new Request("http://x/admin/host-guard"))).json()).toEqual({ enabled: true, holding: null });
  });

  test("off by default: no guard, nothing held", async () => {
    const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
    const env = process.env.WISSEL_HOST_GUARD;
    expect(env === undefined || env !== "1").toBe(true);
    expect(await (await app(new Request("http://x/admin/host-guard"))).json()).toEqual({ enabled: false, holding: null });
  });
});

describe("host:check", () => {
  test("reads each project's TMPDIR from the board read-only, plus the system temp dir; a missing board is just the system one", () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-host-check-"));
    try {
      const path = join(dir, "b.db");
      const db = new Database(path);
      db.run("CREATE TABLE projects (id TEXT, env TEXT)");
      db.run("INSERT INTO projects VALUES ('a', ?), ('b', NULL)", [JSON.stringify({ TMPDIR: "/data/tmp" })]);
      db.close();
      expect(projectTempDirs(path)).toEqual([tmpdir(), "/data/tmp"]);
      expect(projectTempDirs(join(dir, "missing.db"))).toEqual([tmpdir()]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
