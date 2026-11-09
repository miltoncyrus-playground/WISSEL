import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import type { Project, ReviewVerdict, TaskCard } from "../src/core/types.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { inboxEventFromChannelEntry, type ChannelEntry } from "../src/services/channel.ts";
import { CoordinatorExecutor, SqliteOutboundQueue, gateContextFor, type ExecutableAction } from "../src/services/coordinator-executor.ts";
import { DEFAULT_REVIEW_POLICY, createCoordinatorDriver, type DriverDeps } from "../src/services/coordinator-driver.ts";
import { InboxDispatcher, SqliteInbox, inboxEventFromBoardEvent, type InboxEvent, type NewInboxEvent } from "../src/services/inbox.ts";
import { DEFAULT_HARD_LIMITS, PolicyGate, SqliteGateLog } from "../src/services/policy-gate.ts";
import { SqliteWorkstreamStore, type ProjectRole } from "../src/services/workstreams.ts";

// The coordinator driver (docs/SDD-coordinator.md §4.1, §4.3, §4.13): one
// deterministic handler per inbox kind, each building actions and handing
// them to the executor, the only path to acting. The driver is the same in
// every mode; in Shadow the gate marks the verdict and the executor records
// would-entries instead of acting.

const SHA = "a".repeat(40);
const REPO = "/repo/a";
const project: Project = {
  id: "p1", name: "a", path: REPO, source: "local", createdAt: "2026-11-09T00:00:00Z",
  cardTemplates: { "fix-round": "Fix round {round} of {key}\n\n{review}\n\nticket {ticket}; files {files}" },
  reviewPolicy: { ...DEFAULT_REVIEW_POLICY, tiers: [{ id: "default", when: "", reviewers: [{ model: "other-than-coder", mode: "standard" }], maxRounds: 2 }] },
};

async function setup(role: ProjectRole, over: Partial<DriverDeps> = {}) {
  const board = new SqliteBoard();
  const workstreams = new SqliteWorkstreamStore(board.db);
  const ws = await workstreams.create({ name: "w", ticket: "WS-7", projects: [{ projectId: "p1", role, decider: "Ana", decideAlone: ["naming"], mustAsk: [], never: [] }] });
  const executed: string[] = [];
  const handler = (name: string) => async (a: ExecutableAction) => void executed.push(`${name}:${a.post ?? ""}`);
  const executor = new CoordinatorExecutor({
    gate: new PolicyGate(new SqliteGateLog(board.db)), queue: new SqliteOutboundQueue(board.db),
    handlers: { "channel.post": handler("post"), "pr.arm": handler("arm"), "card.start": handler("start"), "owner.task": handler("owner"), "ticket.transition": handler("ticket") },
    context: async (a) => gateContextFor((await workstreams.get(a.workstreamId))!, a.projectId, { limits: DEFAULT_HARD_LIMITS, mainBranch: "main", shadow: false }),
    quietHours: async () => undefined,
  });
  const actions: ExecutableAction[] = [];
  const decisionCards: string[] = [];
  const warnings: string[] = [];
  const deps: DriverDeps = {
    executor: { execute: (a) => { actions.push(a); return executor.execute(a); } },
    board, workstreams, projects: { list: async () => [project] },
    openDecisionCard: async (kind, event) => void decisionCards.push(`${kind}:${event.id}`),
    logger: { warn: (m) => void warnings.push(m) },
    ...over,
  };
  const inbox = new SqliteInbox(board.db);
  const dispatcher = new InboxDispatcher({ inbox, handlers: createCoordinatorDriver(deps).handlers, logger: deps.logger });
  const card = (more: Partial<TaskCard> = {}) => board.create({ title: "A4 add the index (WS-7)", body: "", labels: [], dependsOn: [], repo: REPO, workstreamId: ws.id, key: "A4", round: 1, ...more });
  const moved = (task: TaskCard, status: TaskCard["status"]) => dispatcher.ingest(inboxEventFromBoardEvent({ type: "task.moved", task: { ...task, status } })!);
  const approve = (taskId: string) => board.recordResult({ taskId, agentId: "reviewer", ok: true, summary: "LGTM", verdict: "approve", reviewFeedback: "Looks right." });
  const unhandled = () => inbox.list({ unhandled: true }).map((e) => e.id);
  return { board, ws, executor, inbox, dispatcher, actions, executed, decisionCards, warnings, card, moved, approve, unhandled };
}

const pr = (over: Partial<NonNullable<TaskCard["pr"]>> = {}): TaskCard["pr"] => ({ number: 12, url: "https://code.example/pr/12", head: "feat/a4", reviewedSha: SHA, lifecycle: "ready", watch: { sha: SHA, checks: "passing", mergeable: "clean", state: "open", at: "2026-11-09T12:00:00Z" }, ...over });
const entry = (ws: string, message: ChannelEntry["message"], ref = "7"): NewInboxEvent => inboxEventFromChannelEntry({ ref, at: "2026-11-09T12:00:00Z", workstreamId: ws, message, untrusted: true });

test("shadow: every kind builds its actions through the executor, which records would-entries and executes nothing", async () => {
  const s = await setup("shadow");
  const reviewed = await s.card({ pr: pr() });
  await s.approve(reviewed.id);
  await s.moved(reviewed, "review");
  await s.moved(await s.card({ key: "A5" }), "failed");
  const escalated = await s.card({ key: "A6", escalationContext: "the reviewer repeated itself" });
  await s.moved(escalated, "escalated");
  await s.dispatcher.ingest(inboxEventFromBoardEvent({ type: "pr.checks", task: reviewed, checks: "passing", sha: SHA })!);
  await s.dispatcher.ingest(inboxEventFromBoardEvent({ type: "pr.checks", task: { ...reviewed, key: "A7" }, checks: "failing", sha: "b".repeat(40) })!);
  await s.dispatcher.ingest(inboxEventFromBoardEvent({ type: "pr.dirty", task: { ...reviewed, pr: pr({ watch: { ...pr()!.watch!, mergeable: "dirty" } }) } })!);
  await s.dispatcher.ingest(inboxEventFromBoardEvent({ type: "pr.merged", task: reviewed })!);
  await s.dispatcher.ingest(entry(s.ws.id, { kind: "decision", from: "Ana", about: { card: "A4" }, decision: "naming", text: "snake_case" }));
  await s.dispatcher.ingest(entry(s.ws.id, { kind: "answer", from: "Ana", about: { card: "A4" }, questionRef: "3", text: "take the default" }, "8"));
  await s.dispatcher.ingest(entry(s.ws.id, { kind: "question", from: "Ana", about: { card: "A4" }, text: "index or view?", options: ["index", "view"], lean: "index" }, "9"));
  await s.dispatcher.ingest(entry(s.ws.id, { kind: "claim", from: "other-coordinator", about: { card: "A9" }, item: "A9", version: 1 }, "10"));
  await s.dispatcher.ingest(entry(s.ws.id, { kind: "decision", from: "wissel", about: { card: "A4" }, decision: "naming", text: "our own post, read back" }, "11"));

  expect(s.actions.map((a) => `${a.kind}${a.post ? `/${a.post}` : ""}`)).toEqual([
    "pr.arm", // card.review passed: shadow reads the decide column
    "owner.task", // card.escalated
    "pr.arm", // pr.checks green on a reviewed head
    "channel.post/status", // pr.dirty
    "ticket.transition", "channel.post/status", // pr.merged
    "channel.post/decision", "channel.post/decision", // the decider's decision and answer
  ]);
  expect(s.decisionCards).toEqual([expect.stringMatching(/^triage-red:board:.*card\.failed/), expect.stringMatching(/^triage-red:code-host:.*pr\.checks/), "decide-default:channel:9"]);
  expect(s.executed).toEqual([]);
  expect((await s.executor.status(s.ws.id)).would.map((e) => `${e.action.kind}=${e.verdict}`)).toEqual([
    "pr.arm=allow", "owner.task=ask-owner", "pr.arm=allow", "channel.post=allow", "ticket.transition=allow", "channel.post=allow", "channel.post=allow", "channel.post=ask-owner",
  ]);
  for (const a of s.actions) expect(a).toMatchObject({ workstreamId: s.ws.id, projectId: "p1", id: expect.stringMatching(/^(board|code-host|channel):.+#\d+$/) });
  expect(s.actions[0]).toMatchObject({ base: "main", checks: "green", repo: REPO, own: true, payload: { taskId: reviewed.id, pr: 12 } });
  expect(s.actions[1]!.payload).toMatchObject({ title: expect.stringContaining("A6"), why: "the reviewer repeated itself", blocks: [escalated.id] });
  expect(s.actions[4]!.payload).toMatchObject({ key: "WS-7", to: "done" });
  expect(s.actions[6]).toMatchObject({ decision: "naming", payload: { message: { kind: "decision", from: "wissel", decision: "naming", text: expect.stringContaining("snake_case") } } });
  expect(s.actions[7]).toMatchObject({ decision: "default", payload: { message: { about: { card: "A4" }, text: expect.stringContaining("take the default") } } });
  expect(s.unhandled()).toEqual([]);
});

test("a passing review: follow posts ready-to-merge with the head sha, decide arms the PR; no PR yet is a status line", async () => {
  const follow = await setup("follow");
  const f = await follow.card({ pr: pr() });
  await follow.approve(f.id);
  await follow.moved(f, "review");
  expect(follow.actions).toEqual([expect.objectContaining({ kind: "channel.post", post: "ready-to-merge", payload: { message: { kind: "ready-to-merge", from: "wissel", about: { card: "A4", pr: "12" }, headSha: SHA } } })]);
  expect(follow.executed).toEqual(["post:ready-to-merge"]);

  const decide = await setup("decide");
  const d = await decide.card({ pr: pr() });
  await decide.approve(d.id);
  await decide.moved(d, "review");
  expect(decide.actions.map((a) => a.kind)).toEqual(["pr.arm"]);
  expect(decide.executed).toEqual(["arm:"]);
  const noPr = await decide.card({ key: "A5" });
  await decide.approve(noPr.id);
  await decide.moved(noPr, "review");
  expect(decide.actions[1]).toMatchObject({ kind: "channel.post", post: "status", payload: { message: { text: expect.stringContaining("no pull request") } } });
  // A review verdict without a verdict row is nothing to act on: handled, no action.
  await decide.moved(await decide.card({ key: "A6" }), "review");
  expect(decide.actions).toHaveLength(2);
  expect(decide.warnings).toEqual([expect.stringContaining("no review verdict")]);
  expect(decide.unhandled()).toEqual([]);
});

test("blocking findings start a fix round from the full review text; at the cap the policy's atCap asks the decider", async () => {
  const verdict: ReviewVerdict = { verdict: "changes_requested", feedback: "The index misses the tenant column.", findings: [{ severity: "HIGH", title: "missing tenant column", scenario: true }, { severity: "LOW", title: "naming", scenario: false }] };
  const s = await setup("decide", { reviewVerdictFor: async () => verdict });
  const first = await s.card({ round: 1 });
  await s.moved(first, "review");
  expect(s.actions).toEqual([expect.objectContaining({ kind: "card.start", payload: expect.objectContaining({ template: "fix-round", key: "A4", round: 2, labels: ["fix-round"], optional: ["key", "ticket", "files"] }) })]);
  expect(s.actions[0]!.payload!.vars).toEqual({ round: "2", review: "The index misses the tenant column.\n\nFindings:\n- HIGH: missing tenant column (scenario given)\n- LOW: naming", key: "A4", ticket: "WS-7", files: undefined });
  expect(s.executed).toEqual(["start:"]);

  const capped = await s.card({ key: "A5", round: 2 });
  await s.moved(capped, "review");
  expect(s.actions[1]).toMatchObject({ kind: "channel.post", post: "question", payload: { message: { kind: "question", options: ["accept as is", "one more fix round", "ask about the spec"], lean: "one more fix round" } } });
  expect(s.unhandled()).toEqual([]);
});

test("a card with no workstream is a handled no-op; an event for an unknown card too", async () => {
  const s = await setup("decide");
  const loose = await s.board.create({ title: "loose", body: "", labels: [], dependsOn: [], repo: "/elsewhere" });
  await s.moved(loose, "escalated");
  await s.dispatcher.ingest({ id: "board:nope:card.review:r0.p0", source: "board", kind: "card.review", payload: { taskId: "nope" } });
  expect(s.actions).toEqual([]);
  expect(s.unhandled()).toEqual([]);
  // A card whose workstream is found through its repo's project still acts.
  const byRepo = await s.board.create({ title: "by repo", body: "", labels: [], dependsOn: [], repo: REPO, escalationContext: "stuck" });
  await s.moved(byRepo, "escalated");
  expect(s.actions.map((a) => `${a.kind}@${a.workstreamId}`)).toEqual([`owner.task@${s.ws.id}`]);
});

test("the same event twice acts once; a handler error leaves the row unhandled without throwing", async () => {
  const s = await setup("decide");
  const c = await s.card({ escalationContext: "needs a human" });
  const evt = inboxEventFromBoardEvent({ type: "task.moved", task: { ...c, status: "escalated" } })!;
  expect((await s.dispatcher.ingest(evt)).duplicate).toBe(false);
  expect((await s.dispatcher.ingest(evt)).duplicate).toBe(true);
  expect(s.actions.map((a) => a.id)).toEqual([`${evt.id}#0`]);
  await s.dispatcher.dispatch(s.inbox.get(evt.id)!); // a replay of the stored row builds the same source-stable id
  expect(s.actions.map((a) => a.id)).toEqual([`${evt.id}#0`, `${evt.id}#0`]);

  const broken = await setup("decide", { executor: { execute: async () => { throw new Error("executor down"); } } });
  const b = await broken.card({ escalationContext: "x" });
  await broken.moved(b, "escalated");
  expect(broken.unhandled()).toEqual([expect.stringContaining("card.escalated")]);
  expect(broken.warnings).toEqual([expect.stringContaining("executor down")]);
});

test("createApp wires the default driver to the real executor and dispatches unhandled rows at startup", async () => {
  const board = new SqliteBoard();
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "shadow", decideAlone: [], mustAsk: [], never: [] }] });
  const early = await board.create({ title: "before start", body: "", labels: [], dependsOn: [], workstreamId: ws.id, escalationContext: "left over" });
  const inbox = new SqliteInbox(board.db);
  inbox.receive(inboxEventFromBoardEvent({ type: "task.moved", task: { ...early, status: "escalated" } })!);
  const app = createApp(board, await Registry.load(), undefined, { hardLimits: DEFAULT_HARD_LIMITS });
  const late = await board.create({ title: "after start", body: "", labels: [], dependsOn: [], workstreamId: ws.id });
  await board.escalate(late.id, "stuck twice");
  await new Promise((r) => setTimeout(r, 20));
  expect(inbox.list({ unhandled: true })).toEqual([]);
  const outbound = (await (await app(new Request(`http://x/workstreams/${ws.id}/outbound`))).json()) as { would: { action: ExecutableAction }[] };
  expect(outbound.would.map((e) => `${e.action.kind}:${e.action.payload?.why}`).sort()).toEqual(["owner.task:left over", "owner.task:stuck twice"]);
});
