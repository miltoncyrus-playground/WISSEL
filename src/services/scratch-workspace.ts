import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where a readonly, no-file-access agent's subprocess runs when its task
 * has no `repo` at all — e.g. "check Jira, post to Slack," a task that
 * will never touch a filesystem for real. Same `~/.wissel/` root
 * `worktreesRoot()` uses (see src/services/worktree.ts), sibling to
 * `worktrees/`, same injectable `homeDir` convention so tests never
 * touch the real $HOME.
 *
 * A plain directory — never a git repo, never created via `git worktree
 * add`, nothing here is ever committed, diffed, or merged. Idempotent:
 * `mkdirSync(..., { recursive: true })` is a no-op if the directory
 * already exists, so a retried run reuses the same scratch dir instead
 * of erroring.
 *
 * Unlike a task worktree — which `mergeTaskWorktree`/`removeTaskWorktree`
 * clean up once a human merges or discards the run (see
 * docs/SDD-worktree-isolation.md) — a scratch workspace has no merge or
 * discard action to trigger cleanup, because nothing it holds is ever
 * read back or acted on after the run ends. Left on disk indefinitely
 * by design; a human can delete `~/.wissel/scratch/<taskId>` by hand if
 * it ever needs reclaiming. See docs/SDD-mcp-orchestration.md §3.3/§4
 * (Subtask 5).
 */
export async function resolveScratchWorkspace(taskId: string, homeDir?: string): Promise<string> {
  const path = join(homeDir ?? homedir(), ".wissel", "scratch", taskId);
  mkdirSync(path, { recursive: true });
  return path;
}
