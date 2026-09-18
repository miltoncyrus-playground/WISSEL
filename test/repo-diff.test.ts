import { expect, test } from "bun:test";
import { getRepoDiff } from "../src/services/repo-diff.ts";
import type { CommandResult } from "../src/executors/claude-cli.ts";

function fakeGit(responses: Record<string, CommandResult>) {
  return async (cmd: string[]) => {
    const key = cmd.join(" ");
    const hit = responses[key];
    if (!hit) throw new Error(`unexpected command: ${key}`);
    return hit;
  };
}

test("reports isGitRepo: false without running diff/status when the repo check fails", async () => {
  const diff = await getRepoDiff(
    "/not/a/repo",
    fakeGit({ "git rev-parse --is-inside-work-tree": { stdout: "", stderr: "not a git repository", exitCode: 128 } }),
  );
  expect(diff).toEqual({ isGitRepo: false, diff: "", untracked: [] });
});

test("returns the HEAD diff and untracked paths for a real repo", async () => {
  const diff = await getRepoDiff(
    "/tmp/repo",
    fakeGit({
      "git rev-parse --is-inside-work-tree": { stdout: "true\n", stderr: "", exitCode: 0 },
      "git diff HEAD": { stdout: "diff --git a/x.txt b/x.txt\n+hello\n", stderr: "", exitCode: 0 },
      "git status --porcelain": { stdout: "?? new-file.txt\n M x.txt\n", stderr: "", exitCode: 0 },
    }),
  );
  expect(diff).toEqual({
    isGitRepo: true,
    diff: "diff --git a/x.txt b/x.txt\n+hello\n",
    untracked: ["new-file.txt"],
  });
});

test("no untracked files parses to an empty array, not a stray blank entry", async () => {
  const diff = await getRepoDiff(
    "/tmp/repo",
    fakeGit({
      "git rev-parse --is-inside-work-tree": { stdout: "true\n", stderr: "", exitCode: 0 },
      "git diff HEAD": { stdout: "", stderr: "", exitCode: 0 },
      "git status --porcelain": { stdout: "", stderr: "", exitCode: 0 },
    }),
  );
  expect(diff).toEqual({ isGitRepo: true, diff: "", untracked: [] });
});
