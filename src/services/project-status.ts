import type { CommandRunner } from "../executors/claude-cli.ts";

/** Real, deterministic git state for a registered project — no LLM
 *  involved anywhere in this file. Everything here is a plain "run git,
 *  parse its stdout" lookup: same input (a repo's on-disk state) always
 *  produces the same output, which is exactly the CLAUDE.md test for
 *  code that must never be computed in latent space. */
export interface ProjectGitStatus {
  branch: string;
  /** True when HEAD isn't on a named branch (`git rev-parse
   *  --abbrev-ref HEAD` prints the literal string "HEAD") — `branch`
   *  still carries the short commit sha in this case, same as `git
   *  status` itself reports it. */
  detached: boolean;
  dirty: boolean;
  changedFiles: number;
  hasUpstream: boolean;
  /** Commits on the upstream not yet on HEAD. Undefined when there's no
   *  upstream to compare against. */
  behind?: number;
  /** Commits on HEAD not yet on the upstream. Undefined when there's no
   *  upstream to compare against. */
  ahead?: number;
  /** Undefined only for a repo with zero commits (a fresh `git init`
   *  with nothing committed yet) — `git log` has nothing to report. */
  latestCommit?: { sha: string; shortSha: string; message: string; date: string; author: string };
}

/** A single, low-ASCII separator no commit message/author name is
 *  remotely likely to contain — safer than a comma/pipe, which real
 *  commit messages do use. */
const SEP = "\x1f";

async function run(runner: CommandRunner, path: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runner(["git", ...args], { cwd: path });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export async function getProjectGitStatus(path: string, runner: CommandRunner): Promise<ProjectGitStatus | { error: string }> {
  const isRepo = await run(runner, path, ["rev-parse", "--is-inside-work-tree"]);
  if (!isRepo.ok) return { error: `not a git repository: ${path}` };

  const branchResult = await run(runner, path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const rawBranch = branchResult.ok ? branchResult.stdout : "HEAD";
  const detached = rawBranch === "HEAD";
  let branch = rawBranch;
  if (detached) {
    const shortSha = await run(runner, path, ["rev-parse", "--short", "HEAD"]);
    if (shortSha.ok) branch = shortSha.stdout;
  }

  const statusResult = await run(runner, path, ["status", "--porcelain"]);
  const changedFiles = statusResult.ok ? statusResult.stdout.split("\n").filter((line) => line.length > 0).length : 0;

  let hasUpstream = false;
  let ahead: number | undefined;
  let behind: number | undefined;
  const upstream = await run(runner, path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.ok) {
    hasUpstream = true;
    // Left = upstream-only commits (behind), right = HEAD-only commits
    // (ahead) — @{u}...HEAD's own left/right order, not alphabetical.
    const counts = await run(runner, path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (counts.ok) {
      const parts = counts.stdout.split(/\s+/);
      const parsedBehind = Number(parts[0]);
      const parsedAhead = Number(parts[1]);
      if (Number.isFinite(parsedBehind) && Number.isFinite(parsedAhead)) {
        behind = parsedBehind;
        ahead = parsedAhead;
      }
    }
  }

  let latestCommit: ProjectGitStatus["latestCommit"];
  const log = await run(runner, path, ["log", "-1", `--format=%H${SEP}%h${SEP}%s${SEP}%aI${SEP}%an`]);
  if (log.ok && log.stdout) {
    const [sha, shortSha, message, date, author] = log.stdout.split(SEP);
    if (sha && shortSha && message !== undefined && date && author !== undefined) {
      latestCommit = { sha, shortSha, message, date, author };
    }
  }

  return { branch, detached, dirty: changedFiles > 0, changedFiles, hasUpstream, ahead, behind, latestCommit };
}
