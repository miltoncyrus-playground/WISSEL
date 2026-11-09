/**
 * Host guard (docs/SDD-coordinator.md §4.12). Before a sweep dispatches, the
 * orchestrator asks whether the host has room: load, free memory, free disk
 * under the server and on every project's TMPDIR (Project.env, §3.2). Below
 * a threshold the sweep pauses new cards; running ones continue. The first
 * check of a pause raises one owner task with the evidence (the OwnerTask
 * store, §3.4, when wired), otherwise logs it. Probes are injectable.
 */

import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";

const GB = 1024 ** 3;

/** Host settings; defaults per §4.12, each overridable by WISSEL_HOST_*:
 *  load over `maxLoadPerCore` x cores, under `minMemoryFreeFraction` of
 *  memory free, or under `minDiskFreeBytes` on any probed path pauses. */
export interface HostThresholds {
  maxLoadPerCore: number;
  minMemoryFreeFraction: number;
  minDiskFreeBytes: number;
}

export const DEFAULT_HOST_THRESHOLDS: HostThresholds = { maxLoadPerCore: 3, minMemoryFreeFraction: 0.2, minDiskFreeBytes: 30 * GB };

/** WISSEL_HOST_MAX_LOAD_PER_CORE, _MIN_MEMORY_FREE (a fraction), _MIN_DISK_FREE_GB; a non-positive or junk value keeps the default. */
export function hostThresholdsFromEnv(env: Record<string, string | undefined>): HostThresholds {
  const positive = (raw: string | undefined, fallback: number): number => {
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    maxLoadPerCore: positive(env.WISSEL_HOST_MAX_LOAD_PER_CORE, DEFAULT_HOST_THRESHOLDS.maxLoadPerCore),
    minMemoryFreeFraction: positive(env.WISSEL_HOST_MIN_MEMORY_FREE, DEFAULT_HOST_THRESHOLDS.minMemoryFreeFraction),
    minDiskFreeBytes: positive(env.WISSEL_HOST_MIN_DISK_FREE_GB, DEFAULT_HOST_THRESHOLDS.minDiskFreeBytes / GB) * GB,
  };
}

/** What the guard reads: 1-minute load average, cores, memory, and free bytes
 *  on the filesystem holding `path` (rejects when unreadable). */
export interface HostProbes {
  load(): number;
  cores(): number;
  memory(): { totalBytes: number; freeBytes: number };
  diskFree(path: string): Promise<number>;
}

export const realHostProbes: HostProbes = {
  load: () => loadavg()[0] ?? 0,
  cores: () => Math.max(1, cpus().length),
  memory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
  diskFree: async (path) => {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  },
};

export type HostVerdict = { ok: boolean; /** one line per short resource */ reasons: string[] };

const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

/** Reads every probe once and names each resource under its threshold. The
 *  server's own working directory is always probed; `paths` adds the TMPDIRs. */
export async function checkHost(probes: HostProbes, thresholds: HostThresholds, paths: string[]): Promise<HostVerdict> {
  const reasons: string[] = [];
  const cores = probes.cores();
  const load = probes.load();
  const maxLoad = thresholds.maxLoadPerCore * cores;
  if (load > maxLoad) reasons.push(`load ${load.toFixed(1)} over ${maxLoad.toFixed(1)} (${thresholds.maxLoadPerCore} x ${cores} cores)`);
  const mem = probes.memory();
  const freeFraction = mem.totalBytes > 0 ? mem.freeBytes / mem.totalBytes : 1;
  if (freeFraction < thresholds.minMemoryFreeFraction) {
    reasons.push(`memory ${Math.round(freeFraction * 100)}% free, under ${Math.round(thresholds.minMemoryFreeFraction * 100)}%`);
  }
  for (const path of new Set([process.cwd(), ...paths])) {
    try {
      const free = await probes.diskFree(path);
      if (free < thresholds.minDiskFreeBytes) reasons.push(`disk ${path} ${gb(free)} free, under ${gb(thresholds.minDiskFreeBytes)}`);
    } catch (e) {
      reasons.push(`disk ${path} could not be probed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

export type HostGuardOwnerTask = { title: string; why: string; steps: string[]; blocks: string[] }; // OwnerTask (§3.4) minus id and status

export interface HostGuardOptions {
  probes?: HostProbes;
  thresholds?: HostThresholds;
  /** Extra paths to probe (every project's `env.TMPDIR`); read per check. */
  paths?: () => Promise<string[]>;
  /** The OwnerTask store's create, once card P1.4 lands. Absent: `log` gets the evidence. */
  raiseOwnerTask?: (task: HostGuardOwnerTask) => Promise<unknown>;
  log?: (line: string) => void;
}

export class HostGuard {
  /** Set from the check that paused until the one that recovered: one pause, one task. */
  private paused = false;

  constructor(private readonly opts: HostGuardOptions = {}) {}

  /** The verdict for this sweep; raises or logs on the edge into a pause. */
  async check(): Promise<HostVerdict> {
    const { probes = realHostProbes, thresholds = DEFAULT_HOST_THRESHOLDS, paths, log = console.warn } = this.opts;
    const verdict = await checkHost(probes, thresholds, paths ? await paths() : []);
    if (verdict.ok) {
      if (this.paused) log("host guard: resources recovered, dispatching again");
      this.paused = false;
    } else if (!this.paused) {
      this.paused = true;
      await this.raise(verdict.reasons.map((r) => `- ${r}`).join("\n"), log);
    }
    return verdict;
  }

  private async raise(evidence: string, log: (line: string) => void): Promise<void> {
    if (!this.opts.raiseOwnerTask) {
      log(`host guard: pausing new dispatches (no owner-task store; running cards continue):\n${evidence}`);
      return;
    }
    log(`host guard: pausing new dispatches, raising an owner task:\n${evidence}`);
    try {
      await this.opts.raiseOwnerTask({
        title: "Host short on resources: new cards paused",
        why: `The sweep stopped dispatching new cards. Running cards continue.\n${evidence}`,
        steps: ["Free the resource named above (the largest temp directories first)", "Or raise the threshold with a WISSEL_HOST_* env var and restart"],
        blocks: [],
      });
    } catch (e) {
      log(`host guard: couldn't raise the owner task: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
