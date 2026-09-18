import { runViaBun, type CommandRunner } from "../executors/claude-cli.ts";

export interface RepoDiff {
  /** False when `repo` isn't a git working tree at all (e.g. a plain
   *  folder) — the UI shows "not a git repo" rather than an empty diff,
   *  which would otherwise read as "no changes." */
  isGitRepo: boolean;
  /** Working tree changes to already-tracked files, against HEAD —
   *  covers both staged and unstaged edits, which is everything a
   *  write-tier run could have produced without committing. */
  diff: string;
  /** Paths git doesn't track yet (`git status --porcelain`'s `??`
   *  lines) — a new file a write-tier run created has no HEAD to diff
   *  against, so it never shows up in `diff` above. */
  untracked: string[];
}

/**
 * What the board UI's "View diff" action reads: the visible result of a
 * write-tier run against its task's repo, without requiring the run to
 * have committed or staged anything first.
 */
export async function getRepoDiff(repo: string, runner: CommandRunner = runViaBun): Promise<RepoDiff> {
  const check = await runner(["git", "rev-parse", "--is-inside-work-tree"], { cwd: repo });
  if (check.exitCode !== 0) return { isGitRepo: false, diff: "", untracked: [] };

  const [diffResult, statusResult] = await Promise.all([
    runner(["git", "diff", "HEAD"], { cwd: repo }),
    runner(["git", "status", "--porcelain"], { cwd: repo }),
  ]);

  const untracked = statusResult.stdout
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  return { isGitRepo: true, diff: diffResult.stdout, untracked };
}
