// Host guard (docs/SDD-coordinator.md §4.12): thresholds, the verdict from
// injected probes, one owner task per pause, and the sweep holding new dispatches.

import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { checkHost, DEFAULT_HOST_THRESHOLDS, HostGuard, hostThresholdsFromEnv, type HostProbes } from "../src/services/host-guard.ts";
import type { Executor, TaskCard } from "../src/core/types.ts";

const GB = 1024 ** 3;

/** A healthy 8-core host: 32 GB (16 free), 200 GB free on every path. */
function healthy(overrides: Partial<HostProbes> = {}): HostProbes {
  return { load: () => 2, cores: () => 8, memory: () => ({ totalBytes: 32 * GB, freeBytes: 16 * GB }), diskFree: async () => 200 * GB, ...overrides };
}

test("defaults per §4.12; WISSEL_HOST_* overrides each; junk keeps the default", () => {
  expect(DEFAULT_HOST_THRESHOLDS).toEqual({ maxLoadPerCore: 3, minMemoryFreeFraction: 0.2, minDiskFreeBytes: 30 * GB });
  expect(hostThresholdsFromEnv({})).toEqual(DEFAULT_HOST_THRESHOLDS);
  const env = { WISSEL_HOST_MAX_LOAD_PER_CORE: "1.5", WISSEL_HOST_MIN_MEMORY_FREE: "0.1", WISSEL_HOST_MIN_DISK_FREE_GB: "5" };
  expect(hostThresholdsFromEnv(env)).toEqual({ maxLoadPerCore: 1.5, minMemoryFreeFraction: 0.1, minDiskFreeBytes: 5 * GB });
  expect(hostThresholdsFromEnv({ WISSEL_HOST_MAX_LOAD_PER_CORE: "lots", WISSEL_HOST_MIN_DISK_FREE_GB: "-1" })).toEqual(DEFAULT_HOST_THRESHOLDS);
});

test("checkHost: healthy is ok, cwd always probed, duplicates once; each short or unprobeable resource is a reason with its numbers", async () => {
  const probed: string[] = [];
  const ok = healthy({ diskFree: async (p) => (probed.push(p), 200 * GB) });
  expect(await checkHost(ok, DEFAULT_HOST_THRESHOLDS, ["/scratch/tmp", "/scratch/tmp"])).toEqual({ ok: true, reasons: [] });
  expect(probed).toEqual([process.cwd(), "/scratch/tmp"]);

  const short = healthy({
    load: () => 30,
    memory: () => ({ totalBytes: 32 * GB, freeBytes: 2 * GB }),
    diskFree: async (p) => (p === "/gone" ? Promise.reject(new Error("ENOENT")) : p === "/scratch/tmp" ? 1 * GB : 200 * GB),
  });
  expect(await checkHost(short, DEFAULT_HOST_THRESHOLDS, ["/scratch/tmp", "/gone"])).toEqual({
    ok: false,
    reasons: ["load 30.0 over 24.0 (3 x 8 cores)", "memory 6% free, under 20%", "disk /scratch/tmp 1.0 GB free, under 30.0 GB", "disk /gone could not be probed: ENOENT"],
  });
});

test("HostGuard raises one owner task per pause episode, logs the recovery, raises again on the next; a throwing raise is logged", async () => {
  let free = 1 * GB;
  const raised: { title: string; why: string }[] = [];
  const logged: string[] = [];
  const log = (line: string) => void logged.push(line);
  const guard = new HostGuard({
    probes: healthy({ diskFree: async () => free }),
    paths: async () => ["/scratch/tmp"],
    raiseOwnerTask: async (t) => void raised.push({ title: t.title, why: t.why }),
    log,
  });

  expect((await guard.check()).ok).toBe(false);
  expect((await guard.check()).ok).toBe(false);
  expect(raised).toHaveLength(1);
  expect(raised[0]!.title).toBe("Host short on resources: new cards paused");
  expect(raised[0]!.why).toContain("disk /scratch/tmp 1.0 GB free, under 30.0 GB");
  expect(raised[0]!.why).toContain("Running cards continue");
  expect(logged.some((l) => l.includes("host guard: pausing new dispatches"))).toBe(true);

  free = 200 * GB;
  expect((await guard.check()).ok).toBe(true);
  expect(logged.some((l) => l.includes("host guard: resources recovered"))).toBe(true);
  free = 1 * GB;
  expect((await guard.check()).ok).toBe(false);
  expect(raised).toHaveLength(2);

  const raiseOwnerTask = async () => Promise.reject(new Error("store down"));
  expect((await new HostGuard({ probes: healthy({ load: () => 99 }), raiseOwnerTask, log }).check()).ok).toBe(false);
  expect(logged.some((l) => l.includes("store down"))).toBe(true);

  logged.length = 0; // no owner-task store: the evidence goes to the log instead
  expect((await new HostGuard({ probes: healthy({ load: () => 99 }), log }).check()).ok).toBe(false);
  expect(logged).toEqual([expect.stringContaining("no owner-task store")]);
  expect(logged[0]).toContain("load 99.0 over 24.0 (3 x 8 cores)");
});

test("sweep dispatches nothing while the host guard says no, and resumes when it recovers", async () => {
  let free = 1 * GB;
  const guard = new HostGuard({ probes: healthy({ diskFree: async () => free }), log: () => undefined });
  const seen: TaskCard[] = [];
  const run: Executor["run"] = async (task, agent) => (seen.push(task), { taskId: task.id, agentId: agent.id, ok: true, summary: "triaged" });
  const executor: Executor = { id: "fake-readonly", harnessTool: "claude-cli", canHandle: (agent) => agent.tier === "readonly", run };
  const board = new SqliteBoard();
  const registry = await Registry.load();
  const orchestrator = new Orchestrator(board, registry, new Router(registry), [executor], undefined, { hostGuard: guard });
  const task = await board.create({ title: "raw input", body: "", labels: ["intake"], repo: "r" });

  await orchestrator.sweep();
  expect(seen).toHaveLength(0);
  expect((await board.get(task.id))!).toMatchObject({ status: "inbox", routedTo: undefined });

  free = 200 * GB;
  await orchestrator.sweep();
  expect(seen.map((t) => t.id)).toEqual([task.id]);
  expect((await board.get(task.id))!.status).toBe("done");
});
