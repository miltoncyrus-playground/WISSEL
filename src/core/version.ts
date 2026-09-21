import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import packageJson from "../../package.json";

export interface VersionInfo {
  commit: string;
  commitShort: string;
  branch: string;
  dirty: boolean;
  packageVersion: string;
  startedAt: string;
}

/**
 * Walks up from `startDir` to find the directory containing
 * `package.json` — the repo root. Deliberately not `process.cwd()`:
 * wissel can be invoked from anywhere (the CLI, a task's own worktree
 * cwd), and version info must always describe wissel's own source, not
 * wherever the process happened to be started from.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir;
    dir = parent;
  }
}

function runGit(args: string[], cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.toString("utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * Computes version info fresh against `repoRoot` — unmemoized, so tests
 * can point it at a throwaway directory without fighting the real
 * module-level cache. `getVersionInfo()` below is the memoized,
 * real-repo entrypoint every other call site actually uses.
 *
 * Never throws: a missing `git` binary or a `repoRoot` that isn't a git
 * repo (e.g. installed from a tarball) falls back to "unknown" fields
 * (`dirty: false`) plus a single warning, rather than crashing startup
 * over something purely informational.
 */
export function computeVersionInfo(repoRoot: string): VersionInfo {
  const envCommit = process.env.WISSEL_COMMIT;

  let commit = "unknown";
  let commitShort = "unknown";
  let branch = "unknown";
  let dirty = false;

  if (envCommit) {
    commit = envCommit;
    commitShort = envCommit;
  } else {
    const resolvedCommit = runGit(["rev-parse", "HEAD"], repoRoot);
    if (resolvedCommit) {
      commit = resolvedCommit;
      commitShort = resolvedCommit.slice(0, 7);
    } else {
      console.warn(
        `wissel: could not resolve git commit for ${repoRoot} (git not installed, or not a git repo) — version info will report "unknown"`,
      );
    }
  }

  const resolvedBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
  if (resolvedBranch) branch = resolvedBranch;

  const status = runGit(["status", "--porcelain"], repoRoot);
  if (status !== undefined) dirty = status.length > 0;

  return {
    commit,
    commitShort,
    branch,
    dirty,
    packageVersion: packageJson.version,
    startedAt: new Date().toISOString(),
  };
}

let cached: VersionInfo | undefined;

/**
 * The git identity of the code this process actually loaded, snapshotted
 * once at first call and served from cache for the rest of the process's
 * lifetime. Deliberately not a live git check on every call: wissel runs
 * straight from source with no build step, so a live check would report
 * whatever's on disk right now, not what this process is actually
 * running — those diverge the moment someone `git pull`s without
 * restarting. Under `bun run --watch`, this is still correct, since
 * Bun's watcher fully restarts the process (and this module) on change.
 */
export function getVersionInfo(): VersionInfo {
  if (!cached) {
    cached = computeVersionInfo(findRepoRoot(import.meta.dir));
  }
  return cached;
}
