import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cardTicketKey, filterWork, projectForRepo, cardsForTicket, epicGroups, featureFollowUps, prLine, ticketStarted, workByKey, prsByProject, ticketCardDraft, projectStateLine, ticketKeyOf, ticketSummary } from "../src/api/public/board-work.js";
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

test("a pull request reads as one line, review and CI only while it is open", () => {
  const pr = (over: object) => ({ number: 9, title: "t", url: "u", branch: "b", state: "open" as const, checks: { state: "none" as const, total: 0, failing: [] }, ...over });
  expect(prLine(pr({}))).toBe("#9 open");
  expect(prLine(pr({ state: "draft", checks: { state: "failing", total: 2, failing: ["fast", "lint"] }, review: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }))).toBe("#9 draft · CI failing (fast, lint) · changes requested · conflicts");
  expect(prLine(pr({ checks: { state: "pending", total: 1, failing: [] }, review: "APPROVED" }))).toBe("#9 open · CI running · approved");
  expect(prLine(pr({ state: "merged", review: "APPROVED", checks: { state: "passing", total: 1, failing: [] } }))).toBe("#9 merged");
  expect(prLine(pr({ state: "merged", checks: { state: "failing", total: 1, failing: ["x"] } }))).toBe("#9 merged · CI failed");
});

test("prsByProject indexes by branch and keeps a project's error", () => {
  const out = prsByProject({ projects: [{ id: "a", repo: "o/r", prs: [{ number: 1, title: "", url: "", branch: "x", state: "open", checks: { state: "none", total: 0, failing: [] } }] }, { id: "b", error: "gh: nope" }] });
  expect(out.a!.byBranch.x!.number).toBe(1);
  expect(out.b).toEqual({ error: "gh: nope", byBranch: {} });
  expect(prsByProject(undefined as never)).toEqual({});
});

const proj = (path: string, ticketPatterns?: string[]) => ({ id: path, name: path, path, ...(ticketPatterns ? { ticketPatterns } : {}) });

test("ticketCardDraft names the key, points back at the ticket, and picks a repo only when one project claims the key", () => {
  const t = { key: "ABC-7", summary: "Fix  the\nthing", status: "To Do", url: "https://j.example.net/browse/ABC-7" };
  const one = ticketCardDraft(t, [proj("/a", ["ABC-\\d+"]), proj("/b", ["XYZ-\\d+"]), proj("/c")]);
  expect(one.title).toBe("ABC-7: Fix the thing");
  expect(one.body).toBe("Jira ticket ABC-7 — https://j.example.net/browse/ABC-7\nStatus in Jira: To Do\n\nFix  the\nthing");
  expect(one.repo).toBe("/a");
  // Two claim it, or none sets a pattern: the person chooses.
  expect(ticketCardDraft(t, [proj("/a", ["ABC-\\d+"]), proj("/b", ["ABC-\\d+"])]).repo).toBeUndefined();
  expect(ticketCardDraft(t, [proj("/c")]).repo).toBeUndefined();
  expect(ticketCardDraft({ ...t, summary: "x".repeat(300) }, []).title.length).toBe(200);
  // The draft's title is found by the chip rule again.
  expect(ticketKeyOf([one.title])).toBe("ABC-7");
});

test("cardsForTicket finds live cards whose title or branch names the key", () => {
  const projects = [proj("/a", ["ABC-\\d+"])];
  const cards = [
    { id: "1", title: "ABC-7: one", repo: "/a" },
    { id: "2", title: "other", repo: "/a", mergeTarget: "feat/ABC-7-x" },
    { id: "3", title: "ABC-7: gone", repo: "/a", archivedAt: "2026-01-01" },
    { id: "4", title: "ABC-8: no", repo: "/a" },
  ];
  expect(cardsForTicket("ABC-7", cards, projects).map((c) => c.id)).toEqual(["1", "2"]);
});

const tk = (key: string, parent?: string) => ({ key, summary: key, status: "To Do", url: "u", ...(parent ? { parent: { key: parent, summary: parent } } : {}) });

test("epicGroups groups by parent in first-seen order, no-epic tickets last", () => {
  const g = epicGroups([tk("A-1", "E-1"), tk("A-2"), tk("A-3", "E-2"), tk("A-4", "E-1")]);
  expect(g.map((x) => [x.epic?.key ?? null, x.tickets.map((t) => t.key)])).toEqual([["E-1", ["A-1", "A-4"]], ["E-2", ["A-3"]], [null, ["A-2"]]]);
});

test("ticketStarted is true for a live card or a branch, not for a bare ticket", () => {
  const projects = [proj("/a", ["ABC-\\d+"])];
  const byKey = workByKey({ tickets: [{ key: "ABC-2", cardCount: 0, branchCount: 1 }, { key: null, cardCount: 3, branchCount: 0 }] });
  expect(byKey).toEqual({ "ABC-2": { cards: 0, branches: 1 } });
  const cards = [{ id: "1", title: "ABC-1: x", repo: "/a" }];
  expect(ticketStarted("ABC-1", cards, projects, byKey)).toBe(true);
  expect(ticketStarted("ABC-2", cards, projects, byKey)).toBe(true);
  expect(ticketStarted("ABC-3", cards, projects, byKey)).toBe(false);
});

test("featureFollowUps relates my tickets to a lane through the epic of the tickets its cards name", () => {
  const projects = [proj("/a", ["ABC-\\d+"])];
  const known = { "ABC-1": tk("ABC-1", "E-1"), "ABC-9": tk("ABC-9", "E-9") };
  const mine = [tk("ABC-1", "E-1"), tk("ABC-2", "E-1"), tk("ABC-3", "E-2"), tk("ABC-4")];
  const done = [{ id: "1", title: "ABC-1: built", repo: "/a", status: "done" }, { id: "2", title: "review", repo: "/a", status: "done" }];
  const r = featureFollowUps(done, mine, known, projects);
  expect(r.implemented).toBe(true);
  expect(r.epics.map((e) => e.key)).toEqual(["E-1"]);
  expect(r.own.map((t) => t.key)).toEqual(["ABC-1"]);
  expect(r.followUps.map((t) => t.key)).toEqual(["ABC-2"]);
  // Not implemented, and a lane with no ticket, relate to nothing.
  expect(featureFollowUps([{ id: "1", title: "ABC-1: wip", repo: "/a", status: "running" }], mine, known, projects).implemented).toBe(false);
  const bare = featureFollowUps([{ id: "3", title: "no key", repo: "/a", status: "done" }], mine, known, projects);
  expect([bare.epics, bare.own, bare.followUps]).toEqual([[], [], []]);
  // A key the tracker does not know yields no epic, so nothing relates.
  expect(featureFollowUps([{ id: "4", title: "ABC-5: x", repo: "/a", status: "done" }], mine, known, projects).followUps).toEqual([]);
});
