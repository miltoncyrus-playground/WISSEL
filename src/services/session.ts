import { randomUUID } from "node:crypto";

export interface SessionHandle {
  id: string;
  kind: "tmux" | "process";
  cwd: string;
}

/** Swappable: tmux locally, container elsewhere. */
export interface SessionSupervisor {
  spawn(cwd: string, command: string[], env: Record<string, string>): Promise<SessionHandle>;
  healthy(handle: SessionHandle): Promise<boolean>;
  kill(handle: SessionHandle): Promise<void>;
}

interface TmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function tmux(args: string[]): Promise<TmuxResult> {
  try {
    const proc = Bun.spawn(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, stdout: "", stderr: (e as Error).message };
  }
}

/**
 * Tri-state liveness of a tmux session, ported from agetor's
 * `sessionLiveness` — the fix for a real agetor bug where a bare
 * ok/not-ok read on `has-session` fired the death watch on a transient
 * busy-server error (EAGAIN) and killed live, working sessions. Only
 * unambiguous death strings ("can't find session", "no server running", …)
 * count as `gone`; everything else is `unreachable` and must never be
 * treated as dead.
 *
 * Deliberately NOT ported: agetor's `kill(pid, 0)` fast path
 * (`session-liveness.ts`'s `createDeathProbe`), which exists purely to
 * avoid forking a real `tmux` client on every death-watch tick (2.5
 * forks/sec/task, measurably hot under profiling). Nothing in wissel
 * polls `healthy()` in a tight loop yet — if an orchestrator starts
 * doing that, reach for that pattern then, not before.
 */
async function sessionLiveness(name: string): Promise<"alive" | "gone" | "unreachable"> {
  const r = await tmux(["has-session", "-t", "=" + name]);
  if (r.ok) return "alive";
  const err = `${r.stderr} ${r.stdout}`.toLowerCase();
  if (
    err.includes("find session") ||
    err.includes("session not found") ||
    err.includes("no such session") ||
    err.includes("no server running") ||
    err.includes("lost server")
  ) {
    return "gone";
  }
  return "unreachable";
}

export class TmuxSupervisor implements SessionSupervisor {
  async spawn(cwd: string, command: string[], env: Record<string, string>): Promise<SessionHandle> {
    const id = `wissel-${randomUUID().slice(0, 8)}`;
    const args = ["new-session", "-d", "-s", id, "-c", cwd];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    args.push("--", ...command);

    const result = await tmux(args);
    if (!result.ok) {
      throw new Error(`tmux new-session failed: ${result.stderr || result.stdout}`);
    }
    return { id, kind: "tmux", cwd };
  }

  async healthy(handle: SessionHandle): Promise<boolean> {
    // `unreachable` is deliberately treated as healthy — see
    // `sessionLiveness`'s doc comment. Only a confirmed `gone` is unhealthy.
    return (await sessionLiveness(handle.id)) !== "gone";
  }

  async kill(handle: SessionHandle): Promise<void> {
    // Best-effort and idempotent: killing an already-gone session is a
    // silent no-op, not an error.
    await tmux(["kill-session", "-t", "=" + handle.id]);
  }
}
