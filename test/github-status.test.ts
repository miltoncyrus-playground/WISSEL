import { expect, test } from "bun:test";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import { getProjectPrs, parseGithubRemote, summarizeChecks, withPrCache } from "../src/services/github-status.ts";

test("remote URLs in every form give org/repo", () => {
  expect(parseGithubRemote("https://github.com/acme/repo.git")).toBe("acme/repo");
  expect(parseGithubRemote("https://user@github.com/acme/repo")).toBe("acme/repo");
  expect(parseGithubRemote("git@github.com:acme/repo.git")).toBe("acme/repo");
  expect(parseGithubRemote("git@github-alias:acme/my.repo.git\n")).toBe("acme/my.repo");
  expect(parseGithubRemote("ssh://git@github.com/acme/repo.git")).toBe("acme/repo");
  expect(parseGithubRemote("/home/u/local/repo")).toBeUndefined();
  expect(parseGithubRemote("https://github.com/acme")).toBeUndefined();
  expect(parseGithubRemote("https://github.com/acme/repo/extra")).toBeUndefined();
  expect(parseGithubRemote("git@github.com:acme/re po.git")).toBeUndefined();
});

test("checks fold to failing, pending, passing or none", () => {
  const run = (name: string, status: string, conclusion?: string) => ({ __typename: "CheckRun", name, status, conclusion });
  expect(summarizeChecks([])).toEqual({ state: "none", total: 0, failing: [] });
  expect(summarizeChecks(undefined).state).toBe("none");
  expect(summarizeChecks([run("a", "COMPLETED", "SUCCESS"), run("b", "COMPLETED", "SKIPPED")]).state).toBe("passing");
  expect(summarizeChecks([run("a", "COMPLETED", "SUCCESS"), run("b", "IN_PROGRESS")]).state).toBe("pending");
  const failing = summarizeChecks([run("a", "COMPLETED", "FAILURE"), run("b", "IN_PROGRESS")]);
  expect(failing).toEqual({ state: "failing", total: 2, failing: ["a"] });
  expect(summarizeChecks([{ __typename: "StatusContext", context: "ci/x", state: "SUCCESS" }]).state).toBe("passing");
  expect(summarizeChecks([{ __typename: "StatusContext", context: "ci/x", state: "PENDING" }]).state).toBe("pending");
  expect(summarizeChecks([{ __typename: "StatusContext", context: "ci/x", state: "ERROR" }]).state).toBe("failing");
});

function fakeRunner(gh: { exitCode: number; stdout: string; stderr?: string }, remote = "git@github-alias:acme/repo.git"): { runner: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CommandRunner = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "git") return { exitCode: remote ? 0 : 1, stdout: remote, stderr: "" };
    return { exitCode: gh.exitCode, stdout: gh.stdout, stderr: gh.stderr ?? "" };
  };
  return { runner, calls };
}

const pr = (over: Record<string, unknown>) => ({ number: 1, title: "t", url: "u", headRefName: "feat/ABC-1-x", state: "OPEN", isDraft: false, statusCheckRollup: [], ...over });

test("PRs map to state, newest per branch, with checks", async () => {
  const { runner, calls } = fakeRunner({
    exitCode: 0,
    stdout: JSON.stringify([
      pr({ number: 5, state: "MERGED" }),
      pr({ number: 9, state: "OPEN", isDraft: true, reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", statusCheckRollup: [{ __typename: "CheckRun", name: "fast", status: "COMPLETED", conclusion: "FAILURE" }] }),
      pr({ number: 7, headRefName: "other", state: "CLOSED" }),
      { number: 3 },
    ]),
  });
  const out = await getProjectPrs("/p", runner);
  if ("error" in out) throw new Error(out.error);
  expect(out.repo).toBe("acme/repo");
  expect(out.prs.map((p) => [p.number, p.state])).toEqual([[9, "draft"], [7, "closed"]]);
  expect(out.prs[0]!.checks).toEqual({ state: "failing", total: 1, failing: ["fast"] });
  expect(out.prs[0]!.review).toBe("REVIEW_REQUIRED");
  // Fixed argv, repo passed as its own element.
  expect(calls[1]!.slice(0, 5)).toEqual(["gh", "pr", "list", "--repo", "acme/repo"]);
});

test("errors are reported, never thrown", async () => {
  expect(await getProjectPrs("/p", fakeRunner({ exitCode: 0, stdout: "[]" }, "").runner)).toEqual({ error: "no origin remote" });
  expect(await getProjectPrs("/p", fakeRunner({ exitCode: 0, stdout: "[]" }, "/local/path").runner)).toEqual({ error: "origin is not a GitHub repository" });
  const denied = await getProjectPrs("/p", fakeRunner({ exitCode: 1, stdout: "", stderr: "HTTP 403: SAML enforcement\nmore" }).runner);
  expect(denied).toEqual({ error: "gh: HTTP 403: SAML enforcement" });
  expect(await getProjectPrs("/p", fakeRunner({ exitCode: 0, stdout: "not json" }).runner)).toEqual({ error: "gh: unreadable answer" });
});

test("the cache answers within the ttl and does not keep failures", async () => {
  let t = 0;
  let n = 0;
  let fail = true;
  const cached = withPrCache(async () => (++n, fail ? { error: "x" } : { repo: "a/b", prs: [] }), 1000, () => t);
  await cached("/p");
  await cached("/p");
  expect(n).toBe(2);
  fail = false;
  await cached("/p");
  await cached("/p");
  expect(n).toBe(3);
  t = 2000;
  await cached("/p");
  expect(n).toBe(4);
});
