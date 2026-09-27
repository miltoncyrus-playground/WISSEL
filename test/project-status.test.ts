import { expect, test } from "bun:test";
import { getProjectGitStatus } from "../src/services/project-status.ts";
import type { CommandResult, CommandRunner } from "../src/executors/claude-cli.ts";

/** Scripts `git`'s stdout/exitCode per exact argv, in call order —
 *  mirrors this repo's own scriptedClaudeRunner convention
 *  (test/review-handoff-pipeline.test.ts) but keyed by argv since
 *  project-status.ts issues several different git subcommands, not one
 *  repeated call. */
function scriptedGit(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): CommandRunner {
  return async (cmd: string[]): Promise<CommandResult> => {
    const key = cmd.slice(1).join(" ");
    const r = responses[key];
    if (!r) throw new Error(`unscripted git invocation: git ${key}`);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
  };
}

test("not a git repository returns an error, not a partial status", async () => {
  const runner = scriptedGit({ "rev-parse --is-inside-work-tree": { exitCode: 128, stderr: "not a git repository" } });
  const result = await getProjectGitStatus("/tmp/not-a-repo", runner);
  expect(result).toEqual({ error: "not a git repository: /tmp/not-a-repo" });
});

test("clean repo on a named branch with no upstream and a real commit", async () => {
  const runner = scriptedGit({
    "rev-parse --is-inside-work-tree": { stdout: "true" },
    "rev-parse --abbrev-ref HEAD": { stdout: "main" },
    "status --porcelain": { stdout: "" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { exitCode: 128, stderr: "no upstream configured" },
    "log -1 --format=%H\x1f%h\x1f%s\x1f%aI\x1f%an": {
      stdout: "abc123full\x1fabc123\x1fFix the thing\x1f2026-09-27T10:00:00+00:00\x1fMilton Cyrus",
    },
  });
  const result = await getProjectGitStatus("/tmp/repo", runner);
  expect(result).toEqual({
    branch: "main",
    detached: false,
    dirty: false,
    changedFiles: 0,
    hasUpstream: false,
    ahead: undefined,
    behind: undefined,
    latestCommit: { sha: "abc123full", shortSha: "abc123", message: "Fix the thing", date: "2026-09-27T10:00:00+00:00", author: "Milton Cyrus" },
  });
});

test("dirty repo counts changed files from a real multi-line porcelain listing", async () => {
  const runner = scriptedGit({
    "rev-parse --is-inside-work-tree": { stdout: "true" },
    "rev-parse --abbrev-ref HEAD": { stdout: "feature-x" },
    "status --porcelain": { stdout: " M file1.ts\n?? file2.ts\nA  file3.ts" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { exitCode: 128 },
    "log -1 --format=%H\x1f%h\x1f%s\x1f%aI\x1f%an": { stdout: "sha\x1fsha7\x1fmsg\x1f2026-01-01T00:00:00+00:00\x1fauthor" },
  });
  const result = await getProjectGitStatus("/tmp/repo", runner);
  expect(result).toMatchObject({ dirty: true, changedFiles: 3 });
});

test("ahead/behind parsed from rev-list's left-right count, left is behind (upstream-only)", async () => {
  const runner = scriptedGit({
    "rev-parse --is-inside-work-tree": { stdout: "true" },
    "rev-parse --abbrev-ref HEAD": { stdout: "main" },
    "status --porcelain": { stdout: "" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { stdout: "origin/main" },
    "rev-list --left-right --count @{u}...HEAD": { stdout: "2\t5" },
    "log -1 --format=%H\x1f%h\x1f%s\x1f%aI\x1f%an": { stdout: "sha\x1fsha7\x1fmsg\x1f2026-01-01T00:00:00+00:00\x1fauthor" },
  });
  const result = await getProjectGitStatus("/tmp/repo", runner);
  expect(result).toMatchObject({ hasUpstream: true, behind: 2, ahead: 5 });
});

test("detached HEAD reports the short sha as the branch and detached: true", async () => {
  const runner = scriptedGit({
    "rev-parse --is-inside-work-tree": { stdout: "true" },
    "rev-parse --abbrev-ref HEAD": { stdout: "HEAD" },
    "rev-parse --short HEAD": { stdout: "d34db33" },
    "status --porcelain": { stdout: "" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { exitCode: 128 },
    "log -1 --format=%H\x1f%h\x1f%s\x1f%aI\x1f%an": { stdout: "sha\x1fd34db33\x1fmsg\x1f2026-01-01T00:00:00+00:00\x1fauthor" },
  });
  const result = await getProjectGitStatus("/tmp/repo", runner);
  expect(result).toMatchObject({ branch: "d34db33", detached: true });
});

test("a repo with zero commits yet has no latestCommit, not a crash", async () => {
  const runner = scriptedGit({
    "rev-parse --is-inside-work-tree": { stdout: "true" },
    "rev-parse --abbrev-ref HEAD": { stdout: "main" },
    "status --porcelain": { stdout: "" },
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": { exitCode: 128 },
    "log -1 --format=%H\x1f%h\x1f%s\x1f%aI\x1f%an": { exitCode: 128, stderr: "fatal: your current branch 'main' does not have any commits yet" },
  });
  const result = await getProjectGitStatus("/tmp/repo", runner);
  expect(result).toMatchObject({ latestCommit: undefined });
});
