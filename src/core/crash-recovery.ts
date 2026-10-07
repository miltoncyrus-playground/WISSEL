import type { Board } from "../services/board.ts";
import type { Registry } from "./registry.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import { resumeAfterReviewVerdict } from "./orchestrator.ts";
import { taskWorktreePath } from "../services/worktree.ts";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename } from "node:path";

/**
 * Startup-only cleanup for tasks crash-orphaned at `status: "running"`.
 *
 * `HarnessPool`'s in-flight map and `Orchestrator`'s own in-flight set
 * are both pure in-process state, confirmed empty on a fresh process
 * start — a task's "run" *is* this process's own subprocess call, never
 * something a separate supervisor tracks. That makes every task found at
 * `"running"` here unambiguously a crash/restart orphan *as far as the
 * board is concerned*. See docs/SDD-crash-recovery.md §3.1.
 *
 * The subprocess itself is a different matter: a server that died
 * without running its shutdown hook (SIGKILL, a crash, `--watch`'s own
 * restart) leaves its `claude`/`codex` child alive, reparented to PID 1,
 * still writing into the task's worktree. Resetting that task would
 * dispatch a second session into the same directory — confirmed live
 * 2026-10-07, see docs/SDD-crash-recovery.md §10. So before each reset,
 * any live agent process whose cwd is that task's worktree is killed
 * first. If that check can't run at all (no `/proc`, unreadable), it's
 * logged and the reset goes ahead exactly as before; if a matching
 * process can't be stopped, the task is left at `"running"` (fails
 * closed) rather than reset under a live writer. Returns the number of
 * tasks actually reset.
 *
 * `"dispatched"` tasks are deliberately never touched — those are
 * handed off to an external runner (agetor), not something this process
 * itself was driving, so wissel has no basis for reclaiming them.
 *
 * Called once, before the first `sweep()`, from `createApp` (see
 * src/api/server.ts) — unconditionally, regardless of whether the
 * automatic orchestrator loop (`WISSEL_ORCHESTRATOR`) is on, since this
 * is cleanup of existing state, not automation of new work.
 */
export async function reconcileOrphanedTasks(board: Pick<Board, "list" | "resetToInbox">, opts: OrphanProcessOptions = {}): Promise<number> {
  const orphaned = await board.list({ status: "running" });
  if (orphaned.length === 0) return 0;

  const log = opts.log ?? ((line: string) => console.log(line));
  const logError = opts.logError ?? ((line: string) => console.error(line));
  const listProcesses = opts.listProcesses ?? listProcProcesses;
  const killProcess = opts.killProcess ?? killExternalProcess;

  // One process listing for the whole pass, not one per task. Null means
  // "couldn't check" — today's behavior (reset regardless) applies.
  let processes: ProcessInfo[] | null;
  try {
    processes = (await listProcesses()).filter((p) => p.pid !== process.pid && isAgentProcess(p.argv));
  } catch (e) {
    logError(`crash recovery: can't check for live agent processes (${(e as Error).message}) — resetting orphaned tasks without that check`);
    processes = null;
  }

  let reset = 0;
  for (const task of orphaned) {
    if (processes) {
      const worktree = taskWorktreePath(task, opts.homeDir);
      // /proc's cwd is always fully resolved, so a symlinked $HOME would
      // never match the unresolved path.
      const roots = [...new Set([worktree, resolvedPath(worktree)])];
      const live = processes.filter((p) => roots.some((root) => p.cwd === root || p.cwd.startsWith(root + "/")));
      let allStopped = true;
      for (const p of live) {
        const stopped = await killProcess(p.pid).catch((e) => {
          logError(`crash recovery: failed to kill live agent process ${p.pid} for task ${task.id}: ${(e as Error).message}`);
          return false;
        });
        if (stopped) {
          log(`crash recovery: killed orphaned agent process ${p.pid} (${p.argv[0] ?? "?"}) still running in ${p.cwd} for task ${task.id}`);
        } else {
          allStopped = false;
        }
      }
      if (!allStopped) {
        // Fail closed: resetting now would dispatch a second session into
        // a worktree a live one is still writing to — the exact bug this
        // check exists to prevent. Left at "running" for a human; the
        // next start retries the kill.
        logError(`crash recovery: task ${task.id} ("${task.title}") left at running — a live agent process in ${worktree} couldn't be stopped; needs a human`);
        continue;
      }
    }
    await board.resetToInbox(task.id);
    reset++;
  }
  return reset;
}

/** One live process as crash recovery sees it: its working directory and
 *  its argv. */
export interface ProcessInfo {
  pid: number;
  cwd: string;
  argv: string[];
}

export interface OrphanProcessOptions {
  /** Injectable for tests; defaults to reading `/proc` (Linux only —
   *  throws elsewhere, which reconcileOrphanedTasks treats as "can't
   *  check"). */
  listProcesses?: () => ProcessInfo[] | Promise<ProcessInfo[]>;
  /** Resolves true once `pid` is gone, false if it couldn't be stopped. */
  killProcess?: (pid: number) => Promise<boolean>;
  /** Root the worktree paths resolve under; defaults to `$HOME`. */
  homeDir?: string;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

const AGENT_BINARIES = new Set(["claude", "codex"]);

/** True for a `claude`/`codex` process, whether it's the binary itself
 *  (`claude -p ...`) or a Node shim in front of it (`node .../codex.js`).
 *  Narrow on purpose: crash recovery only ever kills what wissel itself
 *  could have spawned into a worktree, never a shell, editor, or test
 *  run a human has open there. */
export function isAgentProcess(argv: string[]): boolean {
  return argv.slice(0, 2).some((arg) => AGENT_BINARIES.has(basename(arg).replace(/\.(c|m)?js$/, "")));
}

/**
 * Every process on this machine whose cwd and cmdline are readable by
 * us, from `/proc`. Per-process read failures (another user's process,
 * or one that exited mid-scan) are skipped — that's normal, not an
 * error. Only `/proc` itself being unavailable throws.
 */
export function listProcProcesses(): ProcessInfo[] {
  if (process.platform !== "linux") throw new Error(`needs /proc, which ${process.platform} doesn't have`);
  const out: ProcessInfo[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      out.push({ pid: Number(entry), cwd, argv });
    } catch {
      // not ours to read, or already gone
    }
  }
  return out;
}

function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // worktree already removed — nothing can be running in it anyway
  }
}

/** Gone, or a zombie waiting on its (new) parent to reap it — either way
 *  it isn't writing anything anymore. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await Bun.sleep(50);
  }
  return !isAlive(pid);
}

/** SIGTERM, then SIGKILL after a grace period, for a process that isn't
 *  our own child (so there's no `exited` promise to await — polled). */
export async function killExternalProcess(pid: number, graceMs = 3000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw e;
  }
  if (await waitForExit(pid, graceMs)) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw e;
  }
  return waitForExit(pid, 1000);
}

/**
 * Startup-only recovery for an implementer task stuck at
 * `"pending-review"` whose reviewer already reported a verdict before a
 * crash interrupted whatever `handleReviewVerdict` was about to do next
 * (`resumeAfterApproval`'s merge, `spawnPushbackImplementer`, or the
 * escalation branch — see docs/SDD-crash-recovery.md's interrupted-
 * review-verdict section for the real incident this covers: an approved
 * card merged into the repo for real, then the process restarted before
 * `board.move(implementerTask.id, "done")` ever ran, stranding both the
 * card and every `dependsOn` follower).
 *
 * A candidate is any task that's still `"pending-review"`, not already
 * superseded (a pushback re-attempt already replaced it — the crash
 * already got reconciled by an earlier pass, or never happened on this
 * one) and not archived, whose own reviewer child (found via its review
 * lineage, filtered to `parentTaskId === implementerTask.id` and
 * `routedTo === "reviewer"`) is `"done"` with a recorded verdict.
 * Re-drives exactly what `handleReviewVerdict` would have done next via
 * `resumeAfterReviewVerdict` — the same function the live path uses,
 * never a parallel copy — which is itself what makes this idempotent:
 * on approve it already refuses to re-run a merge that landed before the
 * crash (`resumeAfterApproval`'s own `determineWorktreeMergeState`
 * gate), and either outcome (approve or pushback/escalate) always moves
 * the implementer out of `"pending-review"` (or leaves it there only
 * when the merge state truly can't be proven), so a second run over the
 * same board finds nothing left to do.
 *
 * Fails closed, never a silent `"done"`, whenever the merge state can't
 * be proven (worktree and branch both already gone, no matching merge
 * commit in history either — see `determineWorktreeMergeState`) — left
 * at `"pending-review"` exactly as found, logged for a human to look at,
 * never counted in the returned recovery count. One failing candidate
 * (a repo that no longer exists on disk, say) never takes the rest of
 * the sweep down with it.
 *
 * Called once, before the first `sweep()`, from `createApp` (see
 * src/api/server.ts), right after `reconcileOrphanedTasks` above —
 * unconditionally, same reasoning: this is cleanup of existing state,
 * not automation of new work.
 */
export async function reconcileInterruptedReviewVerdicts(board: Board, registry: Registry, runner: CommandRunner): Promise<number> {
  const candidates = await board.list({ status: "pending-review" });
  let recovered = 0;

  for (const implementerTask of candidates) {
    if (implementerTask.supersededBy !== undefined) continue;
    if (implementerTask.archivedAt !== undefined) continue;

    try {
      const lineageId = implementerTask.reviewLineageId ?? implementerTask.id;
      const lineage = await board.getLineage(lineageId);
      const reviewerTask = lineage.filter((t) => t.parentTaskId === implementerTask.id && t.routedTo === "reviewer" && t.status === "done").pop();
      if (!reviewerTask) continue; // reviewer still running/in inbox, or never existed — not this case

      const result = await board.getResult(reviewerTask.id);
      if (!result || result.verdict === undefined) continue; // done for some other reason, not a recorded verdict

      const outcome = await resumeAfterReviewVerdict(board, registry, reviewerTask, result, runner);
      if (outcome === "unresolved") {
        console.error(
          `crash recovery: pending-review task ${implementerTask.id} ("${implementerTask.title}") left unresolved — can't prove whether its worktree branch already merged into ${implementerTask.repo}; needs a human`,
        );
        continue;
      }

      console.log(`crash recovery: recovered interrupted review verdict for task ${implementerTask.id} ("${implementerTask.title}") — ${outcome}`);
      recovered++;
    } catch (e) {
      console.error(`crash recovery: failed to reconcile pending-review task ${implementerTask.id}: ${(e as Error).message}`);
    }
  }

  return recovered;
}
