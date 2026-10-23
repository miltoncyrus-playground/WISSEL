import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cardTicketKey, filterWork, projectForRepo, projectStateLine, ticketKeyOf, ticketSummary } from "../src/api/public/board-work.js";
import { attentionOf, groupWork, type ProjectGitOverview, type WorkView } from "../src/services/project-git.ts";
import type { ProjectGitStatus } from "../src/services/project-status.ts";

const PUBLIC = join(import.meta.dir, "..", "src", "api", "public");

const status = (over: Partial<ProjectGitStatus> = {}): ProjectGitStatus => ({ branch: "main", detached: false, dirty: false, changedFiles: 0, hasUpstream: true, ahead: 0, behind: 0, ...over });
const overview = (s: ProjectGitStatus, tickets: ProjectGitOverview["tickets"]): ProjectGitOverview => ({ status: s, branches: [], worktrees: [], tickets, truncated: false });

test("ticketKeyOf, projectForRepo and cardTicketKey: default key, the project's patterns, title before branch", () => {
  expect(ticketKeyOf(["spec/ABC-9-x"])).toBe("ABC-9");
  expect(ticketKeyOf(["spec/ABC-9-x"], ["XYZ-\\d+"])).toBeUndefined();
  expect(ticketKeyOf([undefined, "", "feat/XYZ-7"], ["XYZ-\\d+"])).toBe("XYZ-7");
  expect(ticketKeyOf(["ABC-1"], ["("])).toBeUndefined();
  const projects = [{ path: "/work/one", ticketPatterns: ["ABC-\\d+"] }];
  expect(projectForRepo("/work/one/", projects)).toBe(projects[0]);
  expect(projectForRepo("/work/two", projects)).toBeUndefined();
  expect(projectForRepo(undefined, projects)).toBeUndefined();
  expect(cardTicketKey({ title: "ABC-5 go", repo: "/work/one", mergeTarget: "feat/ABC-9" }, projects)).toBe("ABC-5");
  expect(cardTicketKey({ title: "go", repo: "/work/one", mergeTarget: "feat/ABC-9" }, projects)).toBe("ABC-9");
  expect(cardTicketKey({ title: "go", repo: "/work/one" }, projects)).toBeUndefined();
});

test("attentionOf names changed files, a detached head, a non-main branch and being behind", () => {
  expect(attentionOf(status())).toEqual([]);
  expect(attentionOf(status({ branch: "master" }))).toEqual([]);
  expect(attentionOf(status({ dirty: true, changedFiles: 1 }))).toEqual(["1 changed file"]);
  expect(attentionOf(status({ branch: "spec/ABC-1-x", behind: 2 }))).toEqual(["on spec/ABC-1-x", "2 behind"]);
  expect(attentionOf(status({ detached: true, branch: "abc123" }))).toEqual(["detached at abc123"]);
});

const card = (id: string) => ({ id, title: id, status: "running" as const });

test("groupWork merges projects by ticket: cards first, keys numeric, no ticket last, a failed project kept", () => {
  const work = groupWork([
    { project: { id: "p1", name: "one" }, overview: overview(status(), [
      { key: "ABC-10", branches: ["feat/ABC-10-a"], worktrees: [], cards: [] },
      { key: "ABC-2", branches: ["feat/ABC-2-a", "feat/ABC-2-b"], worktrees: ["/w"], cards: [card("c1")] },
      { key: null, branches: ["main"], worktrees: [], cards: [] },
    ]) },
    { project: { id: "p2", name: "two" }, overview: overview(status({ branch: "spec/ABC-10-s", dirty: true, changedFiles: 3 }), [
      { key: "ABC-10", branches: ["spec/ABC-10-s"], worktrees: [], cards: [card("c2")] },
    ]) },
    { project: { id: "p3", name: "three" }, overview: { error: "not a git repository: /x" } },
  ]);
  expect(work.tickets.map((t) => t.key)).toEqual(["ABC-2", "ABC-10", null]);
  const t10 = work.tickets.find((t) => t.key === "ABC-10")!;
  expect(t10.projects.map((p) => p.name)).toEqual(["one", "two"]);
  expect(t10).toMatchObject({ cardCount: 1, branchCount: 2 });
  expect(work.projects.map((p) => [p.name, p.attention, p.error])).toEqual([
    ["one", [], undefined],
    ["two", ["3 changed files", "on spec/ABC-10-s"], undefined],
    ["three", [], "not a git repository: /x"],
  ]);
});

test("filterWork narrows by project and by needs-a-look, and drops tickets left with no project", () => {
  const work = groupWork([
    { project: { id: "p1", name: "one" }, overview: overview(status(), [{ key: "ABC-1", branches: ["a"], worktrees: [], cards: [card("c1")] }]) },
    { project: { id: "p2", name: "two" }, overview: overview(status({ dirty: true, changedFiles: 1 }), [
      { key: "ABC-1", branches: ["b"], worktrees: [], cards: [] },
      { key: "ABC-2", branches: ["c"], worktrees: [], cards: [] },
    ]) },
  ]) as WorkView;
  expect(filterWork(work).tickets).toHaveLength(2);
  const one = filterWork(work, { projectId: "p1" });
  expect(one.projects.map((p) => p.id)).toEqual(["p1"]);
  expect(one.tickets.map((t) => [t.key, t.cardCount])).toEqual([["ABC-1", 1]]);
  const look = filterWork(work, { attentionOnly: true });
  expect(look.projects.map((p) => p.id)).toEqual(["p2"]);
  expect(look.tickets.map((t) => [t.key, t.cardCount, t.branchCount])).toEqual([["ABC-1", 0, 1], ["ABC-2", 0, 1]]);
  expect(filterWork(work, { projectId: "p1", attentionOnly: true }).tickets).toEqual([]);
});

test("ticketSummary and projectStateLine read as one line each", () => {
  expect(ticketSummary({ key: "A-1", projects: [{ id: "p", name: "n", branches: [], worktrees: 0, cards: [] }], cardCount: 1, branchCount: 1 })).toBe("1 card · 1 branch · 1 repo");
  expect(ticketSummary({ key: "A-1", projects: [], cardCount: 3, branchCount: 9 })).toBe("3 cards · 9 branches · 0 repos");
  expect(projectStateLine({ id: "p", name: "n", attention: [], status: status() })).toBe("main · clean");
  expect(projectStateLine({ id: "p", name: "n", attention: [], status: status({ dirty: true, changedFiles: 2, ahead: 1, behind: 3 }) })).toBe("main · 2 changed files · 1 ahead, 3 behind");
  expect(projectStateLine({ id: "p", name: "n", attention: [], error: "boom" })).toBe("boom");
});

test("board.html loads board-work.js before its inline script and has the Tickets page, filters and card chip", async () => {
  const html = await readFile(join(PUBLIC, "board.html"), "utf8");
  expect(html.indexOf('<script src="/board-work.js"></script>')).toBeGreaterThan(-1);
  expect(html.indexOf('<script src="/board-work.js"></script>')).toBeLessThan(html.indexOf("<script>", html.indexOf('<script src="/board-work.js"></script>')));
  for (const id of ["ticketsPage", "tkProject", "tkAttention", "tkRefresh", "tkProjects", "tkTickets"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('className = "ticket-chip"');
});

test("ticketKeysOf lists each ticket key once and skips the no-ticket group", async () => {
  const { ticketKeysOf } = await import("../src/api/public/board-work.js");
  const share = { id: "p", name: "n", branches: [], worktrees: 0, cards: [] };
  expect(ticketKeysOf({ projects: [], tickets: [
    { key: "ABC-2", projects: [share], cardCount: 0, branchCount: 0 },
    { key: null, projects: [share], cardCount: 0, branchCount: 0 },
    { key: "ABC-2", projects: [share], cardCount: 0, branchCount: 0 },
    { key: "ABC-10", projects: [share], cardCount: 0, branchCount: 0 },
  ] })).toEqual(["ABC-2", "ABC-10"]);
});

test("the Tickets page asks for the tracker's details and only offers writes after a confirm", async () => {
  const html = await readFile(join(PUBLIC, "board.html"), "utf8");
  expect(html).toContain('id="tkTracker"');
  expect(html).toContain('"/tickets?keys="');
  expect(html).toContain("confirm: true");
  expect(html).toContain("window.confirm(");
});
