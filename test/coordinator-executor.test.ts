import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { CoordinatorExecutor, SqliteOutboundQueue, builtinHandlers, gateContextFor, inQuietHours, startOutboundFlusher, quietHoursEnd, type ExecutableAction, type ExecutorOptions } from "../src/services/coordinator-executor.ts";
import { DEFAULT_HARD_LIMITS, PolicyGate, SqliteGateLog, evaluate, type GateContext, type GateVerdict } from "../src/services/policy-gate.ts";
import { SqliteWorkstreamStore, type Workstream } from "../src/services/workstreams.ts";

// The executor (docs/SDD-coordinator.md §4.3, §4.11): acts only on what the
// gate allowed; quiet hours queue outward actions and flush them in order;
// a queued push is re-checked first; Shadow records "would" entries only.

const WS = "ws-1";
const at = (iso: string) => new Date(iso);
const act = (kind: string, more: Partial<ExecutableAction> = {}): ExecutableAction => ({ kind, workstreamId: WS, projectId: "p1", ...more });
const liveCtx: Omit<GateContext, "quiet"> = { role: "decide", decideAlone: ["naming"], mustAsk: ["pr.arm"], never: ["ticket.transition"], limits: DEFAULT_HARD_LIMITS, mainBranch: "main", channels: ["#dev"], duties: {}, shadow: false };
const QUIET = { start: "22:00", end: "07:00", timezone: "UTC" };

function setup(over: Partial<ExecutorOptions> = {}) {
  const board = new SqliteBoard();
  const ran: string[] = [];
  const handler = (name: string) => async (a: ExecutableAction) => void ran.push(`${name}:${a.post ?? a.payload?.text ?? ""}`);
  const clock = { now: at("2026-11-09T12:00:00Z") };
  const opts: ExecutorOptions = {
    gate: new PolicyGate(new SqliteGateLog(board.db)), queue: new SqliteOutboundQueue(board.db),
    handlers: { "channel.post": handler("post"), "branch.push": handler("push"), "chat.post": handler("chat"), "ticket.comment": handler("ticket") },
    context: async () => liveCtx, quietHours: async () => QUIET, now: () => clock.now, ...over,
  };
  return { board, ran, clock, opts, executor: new CoordinatorExecutor(opts) };
}

test("quiet hours: same-day and overnight windows in a time zone, with the next end instant", () => {
  const ams = { start: "22:00", end: "07:00", timezone: "Europe/Amsterdam" };
  const lunch = { start: "12:00", end: "13:00", timezone: "UTC" };
  expect(inQuietHours(undefined, at("2026-11-09T23:00:00Z"))).toBe(false);
  expect(["2026-11-09T23:00:00Z", "2026-11-09T06:59:00Z", "2026-11-09T07:00:00Z", "2026-11-09T12:00:00Z"].map((t) => inQuietHours(QUIET, at(t)))).toEqual([true, true, false, false]);
  expect(["2026-11-09T21:30:00Z", "2026-11-09T20:30:00Z"].map((t) => inQuietHours(ams, at(t)))).toEqual([true, false]); // 22:30 and 21:30 in Amsterdam
  expect(["2026-11-09T12:30:00Z", "2026-11-09T13:00:00Z"].map((t) => inQuietHours(lunch, at(t)))).toEqual([true, false]);
  expect(quietHoursEnd(QUIET, at("2026-11-09T23:00:30Z"))?.toISOString()).toBe("2026-11-10T07:00:00.000Z");
  expect(quietHoursEnd(ams, at("2026-11-09T21:30:00Z"))?.toISOString()).toBe("2026-11-10T06:00:00.000Z");
  expect(quietHoursEnd(QUIET, at("2026-11-09T12:00:00Z"))).toBeUndefined();
});

test("allow executes through the injected handler; deny and ask-* never reach one; an allowed kind without a handler fails, not silently", async () => {
  const { ran, executor } = setup();
  expect(await executor.execute(act("channel.post", { post: "claim" }))).toMatchObject({ outcome: "done", verdict: { verdict: "allow", mode: "live" } });
  expect((await executor.execute(act("ticket.transition"))).outcome).toBe("refused"); // never
  expect(await executor.execute(act("pr.arm", { base: "main", checks: "green" }))).toMatchObject({ outcome: "refused", verdict: { verdict: "ask-owner", rule: "5:must-ask" } });
  expect((await executor.execute(act("branch.push", { base: "release" }))).verdict.verdict).toBe("deny");
  expect((await executor.execute(act("channel.post", { post: "decision", decision: "schema" }))).outcome).toBe("refused"); // not in decideAlone
  expect(ran).toEqual(["post:claim"]);
  const bare = setup({ handlers: {} });
  expect(await bare.executor.execute(act("channel.post", { post: "status" }))).toMatchObject({ outcome: "failed", error: expect.stringContaining("no executor for channel.post") });
  expect(bare.ran).toEqual([]);
});

test("quiet hours: outward actions queue and flush in order when the window ends; the API shows the queue and its flush time", async () => {
  const { board, ran, clock, executor } = setup();
  clock.now = at("2026-11-09T23:00:00Z");
  expect(await executor.execute(act("channel.post", { post: "claim" }))).toMatchObject({ outcome: "queued", verdict: { verdict: "queue", rule: "4:quiet-hours" } });
  await executor.execute(act("chat.post", { payload: { text: "digest" } }));
  await executor.execute(act("channel.post", { post: "ready-to-merge" }));
  expect(await executor.flush(WS)).toEqual([]); // still quiet: nothing moves
  expect(ran).toEqual([]);
  const status = await executor.status(WS);
  expect(status).toMatchObject({ quiet: true, flushAt: "2026-11-10T07:00:00.000Z" });
  expect(status.queued.map((e) => `${e.action.kind}:${e.status}`)).toEqual(["channel.post:queued", "chat.post:queued", "channel.post:queued"]);

  clock.now = at("2026-11-10T07:00:00Z");
  expect((await executor.flush(WS)).map((e) => e.status)).toEqual(["flushed", "flushed", "flushed"]);
  expect(ran).toEqual(["post:claim", "chat:digest", "post:ready-to-merge"]);
  expect((await executor.status(WS)).queued).toEqual([]);
  expect(await executor.flush(WS)).toEqual([]);

  // The route reads the same table, through the app's own executor.
  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [{ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [] }], quietHours: QUIET });
  const app = createApp(board, await Registry.load(), undefined, { hardLimits: DEFAULT_HARD_LIMITS, executor: { now: () => at("2026-11-10T23:30:00Z") } });
  const queued = await app(new Request(`http://x/workstreams/${ws.id}/outbound`));
  expect(await queued.json()).toMatchObject({ quiet: true, flushAt: "2026-11-11T07:00:00.000Z", queued: [], would: [] });
  expect((await app(new Request("http://x/workstreams/nope/outbound"))).status).toBe(404);
});

test("a queued push is re-checked before it flushes: green pushes, red becomes a fix round; a failing handler stops the flush in place", async () => {
  const fixRounds: string[] = [];
  let green = false;
  // The real gate has no rule that allows branch.push yet (§10, gate holes: it falls to ask-owner), so this one stands in for what §4.5 brings.
  const gate = { evaluate: async (a: ExecutableAction, c: GateContext): Promise<GateVerdict> => (a.kind === "branch.push" ? { verdict: c.quiet ? "queue" : "allow", rule: "test:push", mode: "live" } : evaluate(a, c)) };
  const { ran, clock, opts, executor } = setup({
    gate,
    pushStillGreen: async () => ({ green, reason: green ? undefined : "typecheck failed after merging main" }),
    startFixRound: async (a, reason) => void fixRounds.push(`${a.payload?.branch}: ${reason}`),
  });
  clock.now = at("2026-11-09T23:00:00Z");
  await executor.execute(act("branch.push", { base: "main", payload: { branch: "feat/a" } }));
  await executor.execute(act("channel.post", { post: "ready-to-merge" }));
  await executor.execute(act("branch.push", { base: "main", payload: { branch: "feat/b" } }));
  clock.now = at("2026-11-10T08:00:00Z");
  expect((await executor.flush(WS)).map((e) => `${e.action.kind}=${e.status}`)).toEqual(["branch.push=fix-round", "channel.post=flushed", "branch.push=fix-round"]);
  expect(fixRounds).toEqual(["feat/a: typecheck failed after merging main", "feat/b: typecheck failed after merging main"]);
  expect(ran).toEqual(["post:ready-to-merge"]);
  clock.now = at("2026-11-10T23:00:00Z");
  await executor.execute(act("branch.push", { base: "main", payload: { branch: "feat/c" } }));
  await executor.execute(act("channel.post", { post: "claim" }));
  await executor.execute(act("channel.post", { post: "status" }));
  clock.now = at("2026-11-11T08:00:00Z");
  green = true;
  // Order is kept across a failure: the push flushes, the broken post is marked, the rest wait.
  const broken = new CoordinatorExecutor({ ...opts, handlers: { ...opts.handlers, "channel.post": async () => { throw new Error("adapter down"); } } });
  expect(await broken.flush(WS)).toEqual([expect.objectContaining({ status: "flushed" }), expect.objectContaining({ status: "failed", note: expect.stringContaining("adapter down") })]);
  expect(ran).toEqual(["post:ready-to-merge", "push:"]);
  expect((await executor.status(WS)).queued.map((e) => e.action.post)).toEqual(["status"]);
});

test("shadow records would-entries with the live verdict and never executes or queues", async () => {
  const { ran, clock, executor } = setup({ context: async () => ({ ...liveCtx, shadow: true }) });
  expect(await executor.execute(act("channel.post", { post: "claim" }))).toMatchObject({ outcome: "would", verdict: { verdict: "allow", mode: "shadow" } });
  await executor.execute(act("ticket.transition"));
  clock.now = at("2026-11-09T23:00:00Z");
  await executor.execute(act("chat.post"));
  const status = await executor.status(WS);
  expect(status.queued).toEqual([]);
  expect(status.would.map((e) => `${e.action.kind}:${e.verdict}`)).toEqual(["channel.post:allow", "ticket.transition:deny", "chat.post:queue"]);
  expect(ran).toEqual([]);
  expect(await executor.flush(WS)).toEqual([]);
});

test("gateContextFor reads the project's role and lists from the workstream; builtin handlers wire card.start, card.stop, owner.task and host.*", async () => {
  const ws: Workstream = { id: WS, name: "w", createdAt: "2026-11-09T00:00:00Z", channel: { adapter: "file", target: "/tmp/c.jsonl" }, projects: [{ projectId: "p1", role: "follow", decider: "Ana", decideAlone: ["naming"], mustAsk: ["schema"], never: ["pr.arm"] }] };
  const limits = { limits: DEFAULT_HARD_LIMITS, mainBranch: "main", shadow: false };
  expect(gateContextFor(ws, "p1", limits)).toEqual({ role: "follow", decideAlone: ["naming"], mustAsk: ["schema"], never: ["pr.arm"], limits: DEFAULT_HARD_LIMITS, mainBranch: "main", channels: ["/tmp/c.jsonl"], duties: {}, shadow: false });
  expect(() => gateContextFor(ws, "p9", limits)).toThrow(/p9/);

  const board = new SqliteBoard();
  const calls: string[] = [];
  const handlers = builtinHandlers({
    board,
    projects: { list: async () => [{ id: "p1", path: "/repo", cardTemplates: { coder: "Card {key}: {goal}" }, cardRules: "Keep tests green." } as never] },
    ownerTasks: { create: async (t) => (calls.push(`owner:${t.title}`), { ...t, id: "o1", status: "open" as const }) },
    holdDispatch: (reason) => void calls.push(`hold:${reason}`),
    releaseDispatch: () => void calls.push("release"),
    requestRestart: () => (calls.push("restart"), { ok: true as const }),
    stopCard: async (id) => void calls.push(`stop:${id}`),
  });
  const started = (await handlers["card.start"]!(act("card.start", { payload: { template: "coder", title: "A4 cart", key: "A4", labels: ["coder"], vars: { key: "A4", goal: "add the cart" } } }))) as { id: string; body: string };
  expect(await board.get(started.id)).toMatchObject({ title: "A4 cart", key: "A4", workstreamId: WS, repo: "/repo", labels: ["coder"], status: "inbox", body: "Card A4: add the cart\n\nKeep tests green." });
  await expect(handlers["card.start"]!(act("card.start", { payload: { template: "coder", title: "t", vars: { key: "A5" } } }))).rejects.toThrow(/goal/);
  await expect(handlers["card.start"]!(act("card.start", { projectId: "p2", payload: { template: "coder", title: "t", vars: {} } }))).rejects.toThrow(/p2/);
  await handlers["card.stop"]!(act("card.stop", { payload: { taskId: started.id } }));
  await handlers["owner.task"]!(act("owner.task", { payload: { title: "Log in to gh", why: "token expired", steps: ["gh auth login"], blocks: [started.id] } }));
  await handlers["host.pause"]!(act("host.pause", { payload: { reason: "disk" } }));
  await handlers["host.resume"]!(act("host.resume"));
  await handlers["host.restart-when-idle"]!(act("host.restart-when-idle"));
  expect(calls).toEqual([`stop:${started.id}`, "owner:Log in to gh", "hold:disk", "release", "restart"]);
  for (const kind of ["channel.post", "branch.push", "pr.open", "pr.arm", "ticket.transition", "ticket.comment", "chat.post"] as const) expect(handlers[kind]).toBeUndefined();
});

test("the flusher sends queued actions once quiet hours end, with no direct flush call", async () => {
  const s = setup();
  s.clock.now = at("2026-11-09T23:00:00Z");
  expect((await s.executor.execute(act("channel.post", { post: "a" }))).outcome).toBe("queued");
  const flusher = startOutboundFlusher({ executor: s.executor, workstreams: { list: async () => [{ id: WS }] }, setInterval: () => 1, clearInterval: () => {}, logger: () => {} });
  await flusher.tick();
  expect(s.ran).toEqual([]); // still quiet
  s.clock.now = at("2026-11-10T07:01:00Z");
  await flusher.tick();
  expect(s.ran).toEqual(["post:a"]);
  flusher.stop();
});

test("overlapping flushes of one workstream post each queued entry once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = setup({ handlers: { "channel.post": async () => { s0.count++; await gate; } } });
  const s0 = { count: 0 };
  s.clock.now = at("2026-11-09T23:00:00Z");
  await s.executor.execute(act("channel.post", { post: "a" }));
  s.clock.now = at("2026-11-10T07:01:00Z");
  const first = s.executor.flush(WS);
  const second = await s.executor.flush(WS); // overlaps the first, which is parked in the handler
  release();
  await first;
  expect(second).toEqual([]);
  expect(s0.count).toBe(1);
});
