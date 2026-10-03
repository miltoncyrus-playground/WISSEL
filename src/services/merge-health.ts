import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Board } from "./board.ts";
import type { ProjectStore } from "./projects.ts";

/**
 * Detection + visibility only — never resolution. See
 * docs/SDD-crash-recovery.md §3.2: a human could be mid-manual-resolve
 * of this exact conflict in their own editor the moment wissel restarts
 * (a deploy, an unrelated process-supervisor hiccup), so an auto-`git
 * merge --abort` here would destroy real, in-progress work with no way
 * to recover it. Pure, deterministic — no LLM anywhere in this file,
 * per CLAUDE.md's latent-vs-deterministic-space rule, same spirit as
 * src/services/project-status.ts's own git-status parsing.
 */
export interface DanglingMerge {
  repo: string;
  branch: string;
}

async function run(runner: CommandRunner, cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await runner(["git", ...args], { cwd });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim() };
}

/**
 * One repo's check. `.git/MERGE_HEAD` existing means a `git merge`
 * started and never finished (not completed, not `--abort`ed) — the
 * exact, unambiguous signal §3.2 relies on; `mergeTaskWorktree`
 * (src/services/worktree.ts) confirmed to never call `git merge
 * --abort` itself, so this state is never a false positive from
 * wissel's own code, only ever a real lingering conflict.
 *
 * Branch name is resolved via `git name-rev --name-only` against the
 * sha in MERGE_HEAD — picked over a filesystem-only read of
 * `.git/MERGE_HEAD` because `name-rev` works whether `.git` is a plain
 * directory or a file pointing elsewhere (a linked worktree). When
 * `name-rev` can't resolve a name (its own "undefined" sentinel, or a
 * non-zero exit — a branch that's since moved or been deleted), falls
 * back to the raw sha rather than guessing or omitting the entry.
 */
async function checkOneRepo(repo: string, runner: CommandRunner): Promise<DanglingMerge | undefined> {
  const isRepo = await run(runner, repo, ["rev-parse", "--is-inside-work-tree"]);
  if (!isRepo.ok) return undefined;

  const mergeHeadPath = join(repo, ".git", "MERGE_HEAD");
  if (!existsSync(mergeHeadPath)) return undefined;

  const sha = readFileSync(mergeHeadPath, "utf8").trim();
  if (!sha) return undefined;

  const nameRev = await run(runner, repo, ["name-rev", "--name-only", "--exclude=tags/*", sha]);
  const branch = nameRev.ok && nameRev.stdout && nameRev.stdout !== "undefined" ? nameRev.stdout : sha;
  return { repo, branch };
}

/**
 * Checks every repo in `repos`, in order, and returns only the ones
 * actually mid-merge — a repo that isn't a real git working tree, or has
 * no `MERGE_HEAD`, reports nothing. Duplicate paths in `repos` (a
 * project also referenced by a task's own `repo` field) are checked
 * once.
 *
 * One repo's check is never allowed to abort every other repo's: a repo
 * path that doesn't exist on disk at all (a stale registered Project, or
 * a task whose repo directory was since deleted) makes `runner` throw
 * synchronously — `Bun.spawn`'s own behavior for a nonexistent `cwd` —
 * rather than resolving with a non-zero exit code the way an ordinary
 * git failure would. Caught per-repo and treated the same as "not a real
 * git working tree," so a bad path in the middle of `repos` still lets
 * every repo after it get checked.
 */
export async function checkDanglingMerges(repos: string[], runner: CommandRunner): Promise<DanglingMerge[]> {
  const uniqueRepos = Array.from(new Set(repos));
  const results: DanglingMerge[] = [];
  for (const repo of uniqueRepos) {
    let found: DanglingMerge | undefined;
    try {
      found = await checkOneRepo(repo, runner);
    } catch {
      found = undefined;
    }
    if (found) results.push(found);
  }
  return results;
}

/**
 * The repo set a dangling-merge check should cover: every registered
 * Project.path, union'd with the distinct `repo` values already seen
 * across the board's own tasks — mirrors board.html's
 * `renderRepoOptions`'s own "projects ∪ task history" union. A repo a
 * human is actively using doesn't stop being worth checking just
 * because it was never formally registered as a Project.
 */
export async function resolveReposToCheck(board: Pick<Board, "list">, projects: Pick<ProjectStore, "list">): Promise<string[]> {
  const [projectList, tasks] = await Promise.all([projects.list(), board.list()]);
  const repos = new Set<string>();
  for (const p of projectList) repos.add(p.path);
  for (const t of tasks) if (t.repo) repos.add(t.repo);
  return Array.from(repos);
}
