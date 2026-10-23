import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runViaBun } from "../src/executors/claude-cli.ts";
import { getProjectGitOverview, parseWorktrees, type OverviewCard } from "../src/services/project-git.ts";

function git(args: string[], cwd: string): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8");
}

let root: string;
let repo: string;
let wt: string;
let home: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wissel-project-git-"));
  repo = join(root, "repo");
  home = join(root, "home");
  wt = join(home, ".wissel", "worktrees", "c3");
  git(["init", "-q", "-b", "main", repo], root);
  git(["commit", "-q", "--allow-empty", "-m", "first"], repo);
  git(["branch", "spec/ABC-943-desks"], repo);
  git(["branch", "feat/ABC-940-04b-comments"], repo);
  git(["branch", "feat/ABC-940-02-attachments"], repo);
  git(["branch", "chore/dec-019-rollout"], repo);
  git(["branch", "ticketless-but-subject"], repo);
  git(["worktree", "add", "-q", wt, "-b", "wissel/abcd1234"], repo);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const card = (over: Partial<OverviewCard>): OverviewCard => ({ id: "c1", title: "t", status: "running", repo, ...over });

test("not a git repository is an error, not a partial overview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-project-git-none-"));
  try {
    expect(await getProjectGitOverview(dir, runViaBun)).toEqual({ error: `not a git repository: ${dir}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("branches are grouped by ticket key, keyless ones last", async () => {
  const o = await getProjectGitOverview(repo, runViaBun, { ticketPatterns: ["ABC-\\d+"] });
  if ("error" in o) throw new Error(o.error);
  expect(o.status.branch).toBe("main");
  expect(o.tickets.map((t) => t.key)).toEqual(["ABC-940", "ABC-943", null]);
  expect(o.tickets[0]!.branches.sort()).toEqual(["feat/ABC-940-02-attachments", "feat/ABC-940-04b-comments"]);
  expect(o.tickets[2]!.branches).toContain("main");
  expect(o.tickets[2]!.branches).toContain("chore/dec-019-rollout");
  const main = o.branches.find((b) => b.name === "main");
  expect(main).toMatchObject({ local: true, remote: false, current: true, subject: "first" });
});

test("a card joins its ticket by title, merge target or worktree branch, and its worktree is matched", async () => {
  const cards = [
    card({ id: "c1", title: "ABC-943: desks as code" }),
    card({ id: "c2", title: "no key here", mergeTarget: "feat/ABC-940-04b-comments" }),
    card({ id: "c3", title: "work" }),
    card({ id: "c4", title: "ABC-1 elsewhere", repo: join(root, "other") }),
    card({ id: "c5", title: "ABC-2 archived", archivedAt: "2026-10-01T00:00:00Z" }),
  ];
  const o = await getProjectGitOverview(repo, runViaBun, { ticketPatterns: ["ABC-\\d+"], cards, homeDir: home });
  if ("error" in o) throw new Error(o.error);
  const byKey: Record<string, (typeof o.tickets)[number]> = Object.fromEntries(o.tickets.map((t) => [String(t.key), t]));
  expect(byKey["ABC-943"]!.cards.map((c) => c.id)).toEqual(["c1"]);
  expect(byKey["ABC-940"]!.cards.map((c) => c.id)).toEqual(["c2"]);
  expect(byKey["ABC-1"]).toBeUndefined();
  expect(byKey["ABC-2"]).toBeUndefined();
  expect(o.worktrees).toHaveLength(1);
  expect(o.worktrees[0]).toMatchObject({ branch: "wissel/abcd1234", cardId: "c3" });
  // The card with no ticket sits with the keyless branches.
  expect(o.tickets.at(-1)!.key).toBeNull();
  expect(o.tickets.at(-1)!.cards.map((c) => c.id)).toEqual(["c3"]);
  // Tickets with live cards sort first.
  expect(o.tickets[0]!.cards.length).toBeGreaterThan(0);
});

test("reference patterns label a branch without linking it", async () => {
  const o = await getProjectGitOverview(repo, runViaBun, { referencePatterns: ["dec-\\d+"] });
  if ("error" in o) throw new Error(o.error);
  expect(o.branches.find((b) => b.name === "chore/dec-019-rollout")!.references).toEqual(["dec-019"]);
});

test("remote branches merge with local ones; the remote HEAD and merge-queue refs are not work", async () => {
  const clone = join(root, "clone");
  git(["clone", "-q", repo, clone], root);
  git(["update-ref", "refs/remotes/origin/gh-readonly-queue/main/pr-1-abc", "HEAD"], clone);
  const o = await getProjectGitOverview(clone, runViaBun, { ticketPatterns: ["ABC-\\d+"] });
  if ("error" in o) throw new Error(o.error);
  const names = o.branches.map((b) => b.name);
  expect(names).not.toContain("HEAD");
  expect(names.some((n) => n.includes("gh-readonly-queue"))).toBe(false);
  expect(o.branches.find((b) => b.name === "main")).toMatchObject({ local: true, remote: true });
  expect(o.branches.find((b) => b.name === "spec/ABC-943-desks")).toMatchObject({ local: false, remote: true });
});

test("the overview changes nothing in the repo", async () => {
  const before = git(["for-each-ref"], repo) + git(["status", "--porcelain"], repo) + git(["worktree", "list"], repo);
  await getProjectGitOverview(repo, runViaBun, { cards: [card({})] });
  expect(git(["for-each-ref"], repo) + git(["status", "--porcelain"], repo) + git(["worktree", "list"], repo)).toBe(before);
});

test("parseWorktrees reads path and branch, and a detached worktree has no branch", () => {
  const out = "worktree /a\nHEAD abc\nbranch refs/heads/main\n\nworktree /b\nHEAD def\ndetached\n";
  expect(parseWorktrees(out)).toEqual([{ path: "/a", branch: "main" }, { path: "/b" }]);
});
