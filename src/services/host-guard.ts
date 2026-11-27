// Host guard (docs/SDD-coordinator.md §4.12, phase 1 card 6).
//
// During the pilot a card filled the temp volume and the host ground to a
// halt with work still being dispatched onto it. Before new work starts,
// the guard reads the host's load, available memory, free disk where the
// worktrees live, and free space in each project's temp directory (its
// `env.TMPDIR`, else the system's). Below a threshold it holds new cards
// (running ones carry on) and raises one owner task with the evidence:
// the largest entries in the full temp directories and the running cards
// that write there. Its check is `bun run host:check`, so Done closes the
// task only once the host has room again. The hold lifts by itself as
// soon as a reading is healthy.
//
// Off unless WISSEL_HOST_GUARD=1, like the board's other automatic checks.
import { readdirSync, readFileSync, statfsSync, lstatSync } from "node:fs";
import { availableParallelism, freemem, homedir, loadavg, tmpdir, totalmem } from "node:os";
import { join } from "node:path";

export interface HostThresholds {
  /** Hold when the 1-minute load is at or above this many per core. */
  loadPerCore: number;
  /** Hold when available memory is below this share of the total. */
  minMemoryFreePct: number;
  /** Hold when the worktrees' disk has less free than this. */
  minDiskFreeGb: number;
  /** Hold when a project's temp directory has less free than this. */
  minTempFreeGb: number;
}

export const DEFAULT_THRESHOLDS: HostThresholds = { loadPerCore: 3, minMemoryFreePct: 20, minDiskFreeGb: 30, minTempFreeGb: 2 };

/** Thresholds from WISSEL_HOST_GUARD_* (a bad value keeps the default). */
export function thresholdsFromEnv(env: Record<string, string | undefined>): HostThresholds {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    loadPerCore: num("WISSEL_HOST_GUARD_LOAD_PER_CORE", DEFAULT_THRESHOLDS.loadPerCore),
    minMemoryFreePct: num("WISSEL_HOST_GUARD_MIN_MEMORY_PCT", DEFAULT_THRESHOLDS.minMemoryFreePct),
    minDiskFreeGb: num("WISSEL_HOST_GUARD_MIN_DISK_GB", DEFAULT_THRESHOLDS.minDiskFreeGb),
    minTempFreeGb: num("WISSEL_HOST_GUARD_MIN_TEMP_GB", DEFAULT_THRESHOLDS.minTempFreeGb),
  };
}

export interface HostReading {
  load1: number;
  cores: number;
  memoryFreePct: number;
  /** Free GB per path: the worktrees' disk first, then each temp dir. */
  disk: { path: string; freeGb: number; temp: boolean }[];
}

const GB = 1024 ** 3;

function freeGb(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return (s.bavail * s.bsize) / GB;
  } catch {
    return undefined;
  }
}

/** Available memory as Linux reports it (MemAvailable counts reclaimable
 *  cache), else what the OS calls free. */
function memoryFreePct(): number {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
    if (m) return (Number(m[1]) * 1024 * 100) / totalmem();
  } catch {
    // not Linux
  }
  return (freemem() * 100) / totalmem();
}

/** Reads the host now. `worktreesDisk` is where card worktrees live;
 *  `tempDirs` the temp directories cards write to. Unreadable paths are
 *  left out rather than counted as full. */
export function readHost(worktreesDisk: string, tempDirs: string[]): HostReading {
  const disk: HostReading["disk"] = [];
  const main = freeGb(worktreesDisk);
  if (main !== undefined) disk.push({ path: worktreesDisk, freeGb: main, temp: false });
  for (const path of [...new Set(tempDirs)]) {
    const f = freeGb(path);
    if (f !== undefined) disk.push({ path, freeGb: f, temp: true });
  }
  return { load1: loadavg()[0] ?? 0, cores: availableParallelism(), memoryFreePct: memoryFreePct(), disk };
}

/** What is short, one line each; empty when the host has room. */
export function hostProblems(r: HostReading, t: HostThresholds): string[] {
  const out: string[] = [];
  const maxLoad = t.loadPerCore * r.cores;
  if (r.load1 >= maxLoad) out.push(`load is ${r.load1.toFixed(1)} on ${r.cores} cores (hold at ${maxLoad.toFixed(1)})`);
  if (r.memoryFreePct < t.minMemoryFreePct) out.push(`only ${r.memoryFreePct.toFixed(0)}% of memory is available (hold below ${t.minMemoryFreePct}%)`);
  for (const d of r.disk) {
    const min = d.temp ? t.minTempFreeGb : t.minDiskFreeGb;
    if (d.freeGb < min) out.push(`${d.path} has ${d.freeGb.toFixed(1)} GB free (hold below ${min} GB${d.temp ? ", a temp directory" : ""})`);
  }
  return out;
}

/** The largest entries directly under `dir`, by size on disk, walking at
 *  most `budget` files so a huge tree can't stall the sweep. */
export function largestEntries(dir: string, top = 5, budget = 20_000): { path: string; gb: number }[] {
  let left = budget;
  const size = (p: string): number => {
    if (left-- <= 0) return 0;
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return 0;
      if (!st.isDirectory()) return st.blocks * 512;
      let sum = 0;
      for (const e of readdirSync(p)) sum += size(join(p, e));
      return sum;
    } catch {
      return 0;
    }
  };
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => ({ path: join(dir, n), gb: size(join(dir, n)) / GB }))
    .sort((a, b) => b.gb - a.gb)
    .slice(0, top);
}

export interface GuardDeps {
  worktreesDisk?: string;
  /** Each project's temp directory, with the titles of its running cards. */
  tempDirs: () => Promise<{ path: string; runningCards: string[] }[]>;
  thresholds?: HostThresholds;
  read?: (worktreesDisk: string, tempDirs: string[]) => HostReading;
  /** Raises the owner task, once per episode (none open from the guard). */
  raise: (title: string, why: string, steps: string[]) => Promise<void>;
  log?: (line: string) => void;
}

export const HOST_GUARD_TASK_TITLE = "The host is short of room for new cards";

export class HostGuard {
  private problems: string[] = [];

  constructor(private readonly deps: GuardDeps) {}

  /** Why new cards must wait, or undefined. */
  holding(): string | undefined {
    return this.problems.length > 0 ? `the host guard is holding new cards: ${this.problems.join("; ")}` : undefined;
  }

  /** Reads the host and updates the hold. Raises the owner task when the
   *  host goes from healthy to short. */
  async refresh(): Promise<string[]> {
    const temps = await this.deps.tempDirs();
    const disk = this.deps.worktreesDisk ?? join(homedir(), ".wissel");
    const reading = (this.deps.read ?? readHost)(disk, temps.map((t) => t.path));
    const t = this.deps.thresholds ?? DEFAULT_THRESHOLDS;
    const problems = hostProblems(reading, t);
    const wasHealthy = this.problems.length === 0;
    this.problems = problems;
    const log = this.deps.log ?? console.log;
    if (problems.length > 0 && wasHealthy) {
      log(`host guard: holding new cards: ${problems.join("; ")}`);
      const short = new Set(reading.disk.filter((d) => d.temp && d.freeGb < t.minTempFreeGb).map((d) => d.path));
      const evidence = temps
        .filter((d) => short.has(d.path))
        .map((d) => {
          const big = largestEntries(d.path).map((e) => `${e.path} (${e.gb.toFixed(1)} GB)`).join(", ") || "nothing readable";
          const cards = d.runningCards.length ? ` Running cards writing there: ${d.runningCards.join(", ")}.` : "";
          return `In ${d.path} the largest entries are ${big}.${cards}`;
        });
      await this.deps.raise(
        HOST_GUARD_TASK_TITLE,
        [`Wissel stopped starting new cards because ${problems.join("; ")}. Running cards carry on.`, ...evidence].join(" "),
        ["Free space or memory, or wait for the load to drop (the evidence above names the largest temp entries)", "Press Done: Wissel checks the host again and closes this only if it has room"],
      );
    } else if (problems.length === 0 && !wasHealthy) {
      log("host guard: the host has room again; new cards may start");
    }
    return problems;
  }
}
