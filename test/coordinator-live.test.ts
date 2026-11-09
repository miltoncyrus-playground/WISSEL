// Decide-mode acceptance suite, Shadow flip and role-change timing
// (docs/SDD-coordinator.md §4.13, §7, §8): the real createApp over a temp
// git repo with a local bare origin, a fake `gh`, a fake ticket tracker
// with write-back on, and one scripted day driven through the real board
// events, the channel and the API, never by calling handlers. Shadow is
// the off switch: the same script leaves gh, the remote and the tracker
// untouched. Nothing here reaches a network.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { PrRef, TaskCard } from "../src/core/types.ts";
import { runViaBun, type CommandRunner } from "../src/executors/claude-cli.ts";
import type { Ask } from "../src/services/asks.ts";
import { SqliteBoard, type BoardEvent } from "../src/services/board.ts";
import { SqliteChannelLog, type ChannelEntry } from "../src/services/channel.ts";
import type { ExecutableAction, OutboundEntry } from "../src/services/coordinator-executor.ts";
import type { WindowDocument } from "../src/services/coordinator-window.ts";
import { DECISION_CARD_LABEL } from "../src/services/decision-cards.ts";
import type { InboxEvent } from "../src/services/inbox.ts";
import type { GateRecord, HardLimits } from "../src/services/policy-gate.ts";
import { SqliteProjectStore } from "../src/services/projects.ts";
import type { TicketProvider } from "../src/services/ticket-provider.ts";
import { SqliteWorkstreamStore, type Workstream } from "../src/services/workstreams.ts";

const dir = mkdtempSync(join(tmpdir(), "wissel-coordinator-live-"));
const repo = join(dir, "repo"), origin = join(dir, "origin.git"), elsewhere = join(dir, "elsewhere");
const savedHome = process.env.WISSEL_HOME;
const req = (path: string, method = "GET", body?: unknown): Request => new Request(`http://x${path}`, body === undefined ? { method } : { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const json = (o: unknown) => `Answer:\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 40));
async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runViaBun(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// --- the day's fakes and state -------------------------------------------
const clock = { now: new Date("2026-11-09T12:00:00Z") };
const gh = { head: "", checks: "SUCCESS" as "SUCCESS" | "FAILURE", hold: undefined as Promise<void> | undefined };
const calls: string[][] = [];
const ghCalls = (sub: string) => calls.filter((c) => c[0] === "gh" && c[2] === sub);
const pushes = () => calls.filter((c) => c[0] === "git" && c[1] === "push");
const host: CommandRunner = async (cmd, opts) => {
  calls.push(cmd);
  if (cmd[0] !== "gh") return runViaBun(cmd, opts); // real git, against the local bare origin only
  if (cmd[1] === "pr" && cmd[2] === "view") return { exitCode: 0, stdout: JSON.stringify({ headRefOid: gh.head, baseRefName: "main", state: "OPEN", statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: gh.checks }] }), stderr: "" };
  if (cmd[1] === "pr" && cmd[2] === "merge") {
    await gh.hold;
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  throw new Error(`unexpected host command: ${cmd.join(" ")}`);
};
const ticket = { status: "To Do", writes: [] as string[] };
const tickets: TicketProvider = {
  id: "fake-tracker", writeBack: true,
  lookup: async (keys) => Object.fromEntries(keys.filter((k) => k === "WS-7").map((k) => [k, { key: k, summary: "Checkout", status: ticket.status, url: "https://tracker.invalid/WS-7" }])),
  transitions: async () => [{ id: "1", name: "Start", to: "In Progress" }, { id: "2", name: "Review", to: "In Review" }, { id: "3", name: "Finish", to: "Done" }],
  comment: async (key, text) => void ticket.writes.push(`comment ${key}: ${text.split("\n")[0]}`),
  transition: async (key, id) => { ticket.status = { "1": "In Progress", "2": "In Review", "3": "Done" }[id]!; ticket.writes.push(`transition ${key}: ${ticket.status}`); },
};
const hardLimits: HardLimits = { production: [], readOnlyRepos: [elsewhere] };
/** The owner's terminal: the channel log's lines and the coordinator> lines (the "channel" is this plus the board log). */
const lines: string[] = [];
const consoleLog = console.log;
const recorded: BoardEvent[] = [];
let flushTick: (() => void) | undefined;
const action = (r: GateRecord): ExecutableAction => r.action as ExecutableAction;

let board: SqliteBoard, app: ReturnType<typeof createApp>, ws: Workstream, projectId: string, SHA: string, mainTip: string;
const get = async <T>(path: string): Promise<T> => (await (await app(req(path))).json()) as T;
const outbound = () => get<{ queued: OutboundEntry[]; would: OutboundEntry[] }>(`/workstreams/${ws.id}/outbound`);
const gateLog = () => get<GateRecord[]>(`/workstreams/${ws.id}/gate-log`);
const channel = () => get<ChannelEntry[]>(`/workstreams/${ws.id}/channel`);
const wisselPosts = async () => (await channel()).filter((e) => e.message.from === "wissel");
const openAsks = () => get<Ask[]>(`/workstreams/${ws.id}/asks?status=open`);
const workstream = () => get<Workstream>(`/workstreams/${ws.id}`);
const cards = () => board.list();
const pr = (number: number, over: Partial<PrRef> = {}): PrRef => ({ number, url: `https://code.invalid/pr/${number}`, head: "feat/a4", reviewedSha: SHA, lifecycle: "ready", watch: { sha: SHA, checks: "passing", mergeable: "clean", state: "open", at: clock.now.toISOString() }, ...over });
/** A card of the workstream in the real repo (or `repoPath`), with its PR set the way the delivery and the watcher leave it. */
async function card(key: string, prRef?: PrRef, over: Partial<TaskCard> = {}): Promise<TaskCard> {
  const c = await board.create({ title: `${key} add the index (WS-7)`, body: "", labels: [], dependsOn: [], repo, workstreamId: ws.id, key, round: 1, ...over });
  return prRef ? board.updateFields(c.id, { pr: prRef }) : c;
}
/** The review path's end: a passing verdict recorded, then the card reaches review on the board. */
async function passesReview(c: TaskCard): Promise<void> {
  await board.recordResult({ taskId: c.id, agentId: "reviewer", ok: true, summary: "LGTM", verdict: "approve", reviewFeedback: "Looks right." });
  await board.move(c.id, "review");
}
const decisionCards = async () => (await cards()).filter((t) => t.labels.includes(DECISION_CARD_LABEL));
const fixRounds = async () => (await cards()).filter((t) => t.labels.includes("fix-round"));
/** The decision-maker answered: the stubbed text lands as the card's result and the card reaches done. */
async function answerDecisionCard(c: TaskCard, output: unknown): Promise<void> {
  await board.recordResult({ taskId: c.id, agentId: "decision-maker", ok: true, summary: json(output) });
  await board.move(c.id, "done");
}
const setRole = (role: string) => app(req(`/workstreams/${ws.id}/projects/${projectId}/role`, "POST", { confirm: true, role }));

beforeAll(async () => {
  process.env.WISSEL_HOME = join(dir, "home"); // never ~/.wissel
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  await runViaBun(["git", "init", "-q", "--bare", "-b", "main", origin], { cwd: dir });
  await runViaBun(["git", "init", "-q", "-b", "main", repo], { cwd: dir });
  await runViaBun(["git", "init", "-q", "-b", "main", elsewhere], { cwd: dir });
  await git(repo, "config", "user.email", "t@example.invalid");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "-u", "origin", "main");
  await git(repo, "checkout", "-q", "-b", "feat/a4");
  writeFileSync(join(repo, "a.txt"), "a from card\n");
  await git(repo, "commit", "-q", "-am", "A4 add the index");
  await git(repo, "push", "-q", "-u", "origin", "feat/a4");
  await git(repo, "checkout", "-q", "main");
  SHA = await git(origin, "rev-parse", "feat/a4");
  mainTip = await git(origin, "rev-parse", "main");
  gh.head = SHA;

  board = new SqliteBoard();
  board.events.on("event", (e: BoardEvent) => void recorded.push(e));
  const projects = new SqliteProjectStore(board.db);
  const added = await projects.addLocalProject(repo, {}, runViaBun);
  if ("error" in added) throw new Error(added.error);
  projectId = added.project.id;
  await projects.setSettings(projectId, {
    ticketPatterns: ["WS-\\d+"],
    // Only {review}: the driver's fix round fills round and key, triage-red's proposal does not (§4.16 would refuse an empty one).
    cardTemplates: { "fix-round": "Fix what the review below says, nothing else.\n\n{review}" },
    delivery: { mode: "pull-request", branchPattern: "feat/{ticket}-{key}-{slug}", hostGates: [], gateRetries: 0, draft: true },
  });
  ws = await new SqliteWorkstreamStore(board.db).create({
    name: "checkout", ticket: "WS-7", quietHours: { start: "22:00", end: "06:00", timezone: "UTC" },
    projects: [{ projectId, role: "decide", decider: "Ana", decideAlone: ["naming"], mustAsk: ["schema"], never: [] }],
  });
  app = createApp(board, await Registry.load(), undefined, {
    hardLimits, tickets: { provider: tickets }, shadowPrs: async () => [],
    channelLog: new SqliteChannelLog(board.db, { log: (l) => void lines.push(l) }),
    mergeContext: { host, gateRunner: async () => ({ exitCode: 0, output: "ok", timedOut: false }) },
    executor: { now: () => clock.now },
    outboundFlusher: { setInterval: (fn) => ((flushTick = fn), 0), clearInterval: () => {} },
  });
});
afterAll(() => {
  console.log = consoleLog;
  rmSync(dir, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.WISSEL_HOME;
  else process.env.WISSEL_HOME = savedHome;
});

test("1. decide: a card reaching review with a passing verdict and a PR at the reviewed sha with green checks arms it once with --auto; the tracker moves", async () => {
  const a4 = await card("A4", pr(12));
  await passesReview(a4);
  await until(() => ghCalls("merge").length === 1, "the arm");
  expect(ghCalls("view")).toEqual([["gh", "pr", "view", "12", "--json", "headRefOid,baseRefName,state,statusCheckRollup"]]);
  expect(ghCalls("merge")).toEqual([["gh", "pr", "merge", "12", "--auto", "--squash"]]);
  await until(() => ticket.writes.length >= 2, "the tracker write");
  expect(ticket.writes).toEqual(["transition WS-7: In Review", expect.stringContaining("comment WS-7: Wissel moved WS-7 to In Review")]);
  expect((await gateLog()).map((r) => `${r.action.kind}=${r.verdict}/${r.mode}`).sort()).toEqual(["pr.arm=allow/live", "ticket.transition=allow/live"]);
  expect(lines).toContainEqual(expect.stringMatching(/^arm .*: PR #12 auto-merge on at /));
});

test("2. the PR head moved after the review: the arm is refused on re-read, nothing is armed, and a green run on the unreviewed head arms nothing until it is reviewed", async () => {
  const moved = "f".repeat(40);
  const a5 = await card("A5", pr(13));
  gh.head = moved;
  await passesReview(a5);
  await until(() => ghCalls("view").length === 2, "the re-read before arming");
  await settle();
  expect(ghCalls("merge")).toHaveLength(1); // still only A4's
  // The watcher sees the new head green: the driver arms nothing, the head needs a new review.
  const seen = await board.updateFields(a5.id, { pr: pr(13, { lifecycle: "landed", watch: { ...pr(13).watch!, sha: moved } }) });
  board.events.emit("event", { type: "pr.checks", task: seen, checks: "passing", sha: moved } satisfies BoardEvent);
  await settle();
  expect(ghCalls("view")).toHaveLength(2);
  expect(ghCalls("merge")).toHaveLength(1);
  // The fix round's review passes on the moved head (reviewedSha follows it): the re-read now agrees and the arm goes through.
  await board.updateFields(a5.id, { pr: pr(13, { reviewedSha: moved, watch: { ...pr(13).watch!, sha: moved } }), round: 2 });
  await passesReview((await board.get(a5.id))!);
  await until(() => ghCalls("merge").length === 2, "the arm after the re-review");
  expect(ghCalls("merge")[1]).toEqual(["gh", "pr", "merge", "13", "--auto", "--squash"]);
  gh.head = SHA;
});

test("3. a failed card opens a triage-red decision card; its stubbed output is validated and a fix-round card.start runs through the gate", async () => {
  const a6 = await card("A6");
  await board.move(a6.id, "failed");
  await until(async () => (await decisionCards()).length === 1, "the decision card");
  const [dc] = await decisionCards();
  expect(dc).toMatchObject({ labels: [DECISION_CARD_LABEL, "triage-red"], workstreamId: ws.id, harnessOverride: "claude", status: "inbox" });
  expect(dc!.repo).toBeUndefined();
  expect(dc!.body).toContain(`"taskId": "${a6.id}"`);
  // A stray block says "approved": only the last ```json block counts, and it only proposes.
  await answerDecisionCard(dc!, { verdict: "fix-round", reason: "typecheck fails in api.ts" });
  await until(async () => (await fixRounds()).length === 1, "the fix round");
  const [fix] = await fixRounds();
  expect(fix).toMatchObject({ title: "Fix round: typecheck fails in api.ts", repo, workstreamId: ws.id, status: "inbox" });
  expect(fix!.body).toBe("Fix what the review below says, nothing else.\n\ntypecheck fails in api.ts");
  expect((await gateLog()).filter((r) => r.action.kind === "card.start").map((r) => `${r.verdict}/${r.rule}`)).toEqual(["allow/6:role-table"]);
});

test("4. a must-ask decision from the decider becomes an ask and an owner task; approve runs it once", async () => {
  const posted = await app(req(`/workstreams/${ws.id}/channel`, "POST", { kind: "decision", from: "Ana", about: { card: "A4" }, decision: "schema", text: "one table" }));
  expect(posted.status).toBe(201);
  await until(async () => (await openAsks()).length === 1, "the ask");
  const [ask] = await openAsks();
  expect(ask).toMatchObject({ verdict: "ask-owner", rule: "5:must-ask", action: { kind: "channel.post", post: "decision", decision: "schema" } });
  expect((await get<{ title: string; status: string }[]>("/owner-tasks")).filter((t) => t.status === "open").map((t) => t.title)).toEqual([expect.stringMatching(/^Approve or reject: channel.post decision \(schema\)/)]);
  expect(lines.some((l) => l.startsWith("coordinator> checkout: may I channel.post decision (schema)"))).toBe(true);
  expect(await wisselPosts()).toHaveLength(0);
  const ok = await app(req(`/workstreams/${ws.id}/asks/${ask!.id}/approve`, "POST"));
  expect(ok.status).toBe(200);
  expect((await wisselPosts()).map((e) => e.message.kind)).toEqual(["decision"]);
  expect((await app(req(`/workstreams/${ws.id}/asks/${ask!.id}/approve`, "POST"))).status).toBe(409);
  expect(await wisselPosts()).toHaveLength(1);
  expect(await openAsks()).toEqual([]);
});

test("5. hard limits: arming on red checks and acting in a read-only repo are denied by rule 1, reach gh never, and open no ask to approve", async () => {
  const red = await card("A7", pr(14, { watch: { ...pr(14).watch!, checks: "failing" } }));
  await passesReview(red);
  const foreign = await card("A8", pr(15), { repo: elsewhere });
  await passesReview(foreign);
  await settle();
  const denied = (await gateLog()).filter((r) => r.verdict === "deny");
  expect(denied.map((r) => `${r.action.kind}:${r.action.checks}:${r.action.repo === elsewhere ? "read-only" : "own"}=${r.rule}`)).toEqual(["pr.arm:red:own=1:hard-limit", "pr.arm:green:read-only=1:hard-limit"]);
  expect(ghCalls("view")).toHaveLength(3); // A4, A5 twice: a denied arm is never read, let alone armed
  expect(ghCalls("merge")).toHaveLength(2);
  expect(await openAsks()).toEqual([]);
  expect(await get<Ask[]>(`/workstreams/${ws.id}/asks`)).toHaveLength(1); // only the approved one from 4
});

test("6. quiet hours queue the outward arm; after the window the flusher re-gates and sends it, with the remote unchanged", async () => {
  clock.now = new Date("2026-11-09T23:00:00Z");
  const a9 = await card("A9", pr(16));
  await passesReview(a9);
  await until(async () => (await outbound()).queued.length === 1, "the queued arm");
  const [queued] = (await outbound()).queued;
  expect(queued).toMatchObject({ status: "queued", verdict: "queue", rule: "4:quiet-hours", action: { kind: "pr.arm", payload: { pr: 16 } } });
  expect(ghCalls("merge")).toHaveLength(2);
  const doc = await get<WindowDocument>(`/workstreams/${ws.id}/window`);
  expect(doc.header.quietHours).toMatchObject({ quiet: true });
  expect(doc.header.outbound).toEqual({ queued: 1, flushAt: "2026-11-10T06:00:00.000Z" });
  flushTick!();
  await settle();
  expect((await outbound()).queued).toHaveLength(1); // still inside the window
  clock.now = new Date("2026-11-10T06:30:00Z");
  flushTick!();
  await until(async () => (await outbound()).queued.length === 0, "the flush");
  expect(ghCalls("merge")[2]).toEqual(["gh", "pr", "merge", "16", "--auto", "--squash"]);
  expect((await gateLog()).filter((r) => action(r).id === queued!.action.id).map((r) => r.verdict)).toEqual(["queue", "allow"]);
  expect(pushes()).toEqual([]);
  expect(await git(origin, "rev-parse", "main")).toBe(mainTip);
  expect(await git(origin, "rev-parse", "feat/a4")).toBe(SHA);
});

test("7. Shadow: the role flips to shadow through the confirm step; the same script makes zero gh calls, pushes or ticket writes, records would-entries and a report; flipping back resumes", async () => {
  const flipped = await setRole("shadow");
  expect(flipped.status).toBe(200);
  expect((await workstream()).projects[0]!.role).toBe("shadow");
  const before = { gh: calls.filter((c) => c[0] === "gh").length, writes: ticket.writes.length, posts: (await wisselPosts()).length, cards: (await cards()).length };
  // The script again: a reviewed green card, a failed card answered fix-round, a decider's decision, a merged PR.
  await passesReview(await card("B1", pr(21)));
  const failed = await card("B2");
  await board.move(failed.id, "failed");
  await until(async () => (await decisionCards()).length === 2, "the shadow decision card");
  await answerDecisionCard((await decisionCards()).find((c) => c.status === "inbox")!, { verdict: "fix-round", reason: "lint fails" });
  await app(req(`/workstreams/${ws.id}/channel`, "POST", { kind: "decision", from: "Ana", about: { card: "B1" }, decision: "naming", text: "snake_case" }));
  const merged = await card("B3", pr(23, { lifecycle: "merged", watch: { ...pr(23).watch!, state: "merged" } }));
  board.events.emit("event", { type: "pr.merged", task: merged } satisfies BoardEvent);
  await until(async () => (await outbound()).would.length >= 5, "the would-entries");
  await settle();
  const would = (await outbound()).would;
  expect(would.map((e) => `${e.action.kind}${e.action.post ? `/${e.action.post}` : ""}=${e.verdict}`).sort()).toEqual(["card.start=allow", "channel.post/decision=allow", "channel.post/status=allow", "pr.arm=allow", "ticket.transition=allow"]);
  expect(calls.filter((c) => c[0] === "gh")).toHaveLength(before.gh);
  expect(pushes()).toEqual([]);
  expect(ticket.writes).toHaveLength(before.writes);
  expect(await wisselPosts()).toHaveLength(before.posts);
  expect(await fixRounds()).toHaveLength(1); // the shadow fix round was recorded, not started
  const report = await get<{ would: number; hardLimitViolations: unknown[]; unmatched: { side: string; kind: string }[] }>(`/workstreams/${ws.id}/shadow-report`);
  expect(report.would).toBe(5);
  expect(report.hardLimitViolations).toEqual([]);
  expect(report.unmatched.map((u) => `${u.side}:${u.kind}`)).toContain("wissel:pr.arm");
  expect(report.unmatched.length).toBeGreaterThanOrEqual(5);

  expect((await setRole("decide")).status).toBe(200);
  await passesReview(await card("B4", pr(24)));
  await until(() => ghCalls("merge").length === 4, "the arm after flipping back");
  expect(ghCalls("merge")[3]).toEqual(["gh", "pr", "merge", "24", "--auto", "--squash"]);
});

test("8. a duty owned by an external coordinator: the arm is denied by rule 3, so there is no double arm", async () => {
  expect((await app(req(`/workstreams/${ws.id}/duties/arming`, "POST", { confirm: true, owner: "external" }))).status).toBe(200);
  await passesReview(await card("C1", pr(31)));
  await settle();
  expect((await gateLog()).filter((r) => r.rule === "3:duty-external").map((r) => `${r.action.kind}:${action(r).payload?.pr as number}`)).toEqual(["pr.arm:31"]);
  expect(ghCalls("merge")).toHaveLength(4);
  expect((await app(req(`/workstreams/${ws.id}/duties/arming`, "POST", { confirm: true, owner: "wissel" }))).status).toBe(200);
});

test("9. a role change requested during an arm waits for the arm to settle; the window shows the pending role", async () => {
  let release!: () => void;
  gh.hold = new Promise<void>((r) => (release = r));
  await passesReview(await card("D1", pr(41)));
  await until(() => ghCalls("merge").length === 5, "the arm to start");
  const res = await setRole("shadow");
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ pending: { projectId, change: { role: "shadow" }, waitingOn: "arm" } });
  expect((await workstream()).projects[0]!.role).toBe("decide");
  const doc = await get<WindowDocument>(`/workstreams/${ws.id}/window`);
  expect(doc.header.roles).toEqual([{ projectId, role: "decide", decider: "Ana", pendingRole: "shadow" }]);
  release();
  gh.hold = undefined;
  await until(async () => (await workstream()).projects[0]!.role === "shadow", "the role change after the arm");
  expect((await get<WindowDocument>(`/workstreams/${ws.id}/window`)).header.roles).toEqual([{ projectId, role: "shadow", decider: "Ana" }]);
  expect((await setRole("decide")).status).toBe(200); // nothing in flight: applied at once
});

test("10. idempotence: replaying the day's inbox events changes nothing; no push and no force push happened all day", async () => {
  const inboxBefore = await get<InboxEvent[]>(`/workstreams/${ws.id}/inbox`);
  expect(inboxBefore.filter((e) => !e.handledAt)).toEqual([]);
  const snapshot = async () => ({ calls: calls.length, writes: ticket.writes.length, channel: (await channel()).length, cards: (await cards()).length, asks: (await get<Ask[]>(`/workstreams/${ws.id}/asks`)).length, would: (await outbound()).would.length, gate: (await gateLog()).length });
  const before = await snapshot();
  for (const e of recorded.slice()) if (e.type === "task.moved" || e.type === "pr.checks" || e.type === "pr.dirty" || e.type === "pr.merged") board.events.emit("event", e);
  await settle();
  expect(await snapshot()).toEqual(before);
  expect(await get<InboxEvent[]>(`/workstreams/${ws.id}/inbox`)).toEqual(inboxBefore);
  expect(pushes()).toEqual([]);
  expect(calls.some((c) => c[0] === "git" && c.some((a) => /^(-f|--force.*)$/.test(a) || a.startsWith("+")))).toBe(false);
  expect(await git(origin, "rev-parse", "main")).toBe(mainTip);
});
