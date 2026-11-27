import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";
import { OWNER_PRINCIPAL_ID } from "../src/services/authorization.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import { Orchestrator, finishResult, recordHarnessLimit } from "../src/core/orchestrator.ts";
import { cardPrincipal, HarnessOverrideError, HarnessPool } from "../src/core/harness-pool.ts";
import { describeHarnessLimit, harnessLimitEvent, harnessLimitOf } from "../src/core/harness-limit.ts";
import { buildAccountStatus } from "../src/core/account-status.ts";
import { formatReport, parseResultEvents, summarizeUsage, UNRECORDED } from "../scripts/usage-report.ts";
import type { AgentDef, Executor, Harness, TaskResult } from "../src/core/types.ts";

// docs/SDD-identity-and-permissions.md §4.7, build plan card 4: a
// harness is an account with an owner; a non-shared one runs only its
// owner's cards; spend splits per person and per account; a limit names
// whose account it hit.

const h = (o: Partial<Harness> & Pick<Harness, "id">): Harness => ({ tool: "claude-cli", label: o.id, enabled: true, ...o });

const agent: AgentDef = {
  id: "reader",
  name: "reader",
  kind: "agent",
  tier: "readonly",
  description: "test",
  whenToUse: "test",
  tags: ["intake"],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "low",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 },
};

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "wissel-ownership-"));
  return { path: join(dir, "t.jsonl"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const lines = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("a harness with no owner, or a shared one, runs anyone's card; an owned one only its owner's", () => {
  const pool = HarnessPool.from([h({ id: "open" }), h({ id: "team", ownerPrincipalId: "alice", shared: true }), h({ id: "alices", ownerPrincipalId: "alice" })]);
  const [open, team, alices] = pool.all() as [Harness, Harness, Harness];
  expect([pool.mayRun(open, "bob"), pool.mayRun(team, "bob"), pool.mayRun(alices, "bob")]).toEqual([true, true, false]);
  expect(pool.mayRun(alices, "alice")).toBe(true);
});

test("acquire skips a harness the card's principal may not use, and waits when none is left", () => {
  const pool = HarnessPool.from([h({ id: "alices", ownerPrincipalId: "alice" })]);
  expect(pool.canAcquire("claude-cli", undefined, "bob")).toBe(false);
  expect(pool.acquire("claude-cli", undefined, undefined, "bob")).toBeUndefined();
  expect(pool.activeCount("alices")).toBe(0);
  expect(pool.acquire("claude-cli", undefined, undefined, "alice")?.id).toBe("alices");
  // An agent's own list is filtered the same way.
  expect(pool.canAcquire("claude-cli", ["alices"], "bob")).toBe(false);
});

test("an explicit override onto someone else's non-shared harness fails loud, naming both", () => {
  const pool = HarnessPool.from([h({ id: "alices", ownerPrincipalId: "alice" })]);
  expect(() => pool.acquire("claude-cli", "alices", undefined, "bob")).toThrow(HarnessOverrideError);
  expect(() => pool.acquire("claude-cli", "alices", undefined, "bob")).toThrow(/belongs to alice.*authorized by bob/);
});

test("with no principal given, and for a card nobody authorized, the instance owner is assumed: nothing changes for a single-owner board", () => {
  expect(cardPrincipal({})).toBe(OWNER_PRINCIPAL_ID);
  expect(cardPrincipal({ authorizedByPrincipalId: "alice" })).toBe("alice");
  const pool = HarnessPool.from([h({ id: "mine", ownerPrincipalId: OWNER_PRINCIPAL_ID })]);
  expect(pool.acquire("claude-cli")?.id).toBe("mine");
});

test("orchestrator: a card waits rather than run on another person's account, and runs on its own principal's", async () => {
  const ran: string[] = [];
  const exec: Executor = {
    id: "fake",
    harnessTool: "claude-cli",
    canHandle: () => true,
    run: async (task, a, hh) => (ran.push(`${task.title}@${hh!.id}`), { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }),
  };
  const harnesses = HarnessPool.from([h({ id: "alices", ownerPrincipalId: "alice" })]);
  const board = new SqliteBoard();
  const registry = Registry.from([agent]);
  const orch = new Orchestrator(board, registry, new Router(registry), [exec], undefined, { harnesses });
  const bobs = await board.create({ title: "bobs", body: "", labels: ["intake"], repo: "r", authorizedByPrincipalId: "bob" });
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  try {
    await orch.sweep();
  } finally {
    console.log = original;
  }
  expect(ran).toEqual([]);
  expect((await board.get(bobs.id))!.status).toBe("inbox");
  expect(logs.some((l) => l.includes("no enabled claude-cli harness is shared or owned by bob"))).toBe(true);
  await board.create({ title: "alices", body: "", labels: ["intake"], repo: "r", authorizedByPrincipalId: "alice" });
  await orch.sweep();
  expect(ran).toEqual(["alices@alices"]);
});

test("a pipeline step card runs for whoever started the run", async () => {
  const board = new SqliteBoard();
  const root = await board.create({ title: "run", body: "", labels: [], authorizedByPrincipalId: "alice" });
  const step = await board.create({ title: "step", body: "", labels: [], pipelineId: "p", pipelineRunId: root.id, pipelineStepId: "s" });
  expect(step.authorizedByPrincipalId).toBe("alice");
});

test("every result event names the harness and the principal, so spend splits by both", async () => {
  const t = tmp();
  try {
    const board = new SqliteBoard();
    const card = await board.create({ title: "x", body: "", labels: [], authorizedByPrincipalId: "alice" });
    await finishResult(board, Registry.from([agent]), { taskId: card.id, agentId: agent.id, ok: true, summary: "done", harnessId: "alices", actualCost: 0.5 }, new TelemetryLog(t.path));
    const result = lines(t.path).find((e) => e.type === "result")!;
    expect([result.harnessId, result.principalId]).toEqual(["alices", "alice"]);
  } finally {
    t.done();
  }
});

test("harnessLimitOf: a rescheduled 429, an exhausted balance and a lapsed sign-in; anything else is none", () => {
  const r = (summary: string, extra: Partial<TaskResult> = {}) => ({ ok: false, summary, ...extra });
  expect(harnessLimitOf(r("limit", { retryAfter: "2026-11-27T10:00:00Z" }))).toBe("session-limit");
  expect(harnessLimitOf(r("API error: Your credit balance is too low to access the API"))).toBe("balance");
  expect(harnessLimitOf(r("OAuth token has expired. Please run /login"))).toBe("signed-out");
  expect(harnessLimitOf(r("tests failed"))).toBeUndefined();
  expect(harnessLimitOf({ ok: true, summary: "credit balance is too low (quoted in a doc)" })).toBeUndefined();
});

test("a limit becomes one event naming whose account it is; a run with no harness or no limit records nothing", async () => {
  const t = tmp();
  try {
    const log = new TelemetryLog(t.path);
    const alices = h({ id: "alices", ownerPrincipalId: "alice" });
    const hit: TaskResult = { taskId: "t1", agentId: "reader", ok: false, summary: "limit", retryAfter: "2026-11-27T10:00:00Z" };
    const warn = console.warn;
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      await recordHarnessLimit(log, hit, alices, "bob");
      await recordHarnessLimit(log, hit, undefined, "bob");
      await recordHarnessLimit(log, { ...hit, retryAfter: undefined, summary: "tests failed" }, alices, "bob");
    } finally {
      console.warn = warn;
    }
    const events = lines(t.path);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "harness.limit", kind: "session-limit", harnessId: "alices", ownerPrincipalId: "alice", principalId: "bob", taskId: "t1" });
    expect(warned[0]).toContain("alice's account alices hit a session limit");
    const unowned = harnessLimitEvent({ ...hit, retryAfter: undefined, summary: "credit balance is too low" }, h({ id: "open" }), "bob")!;
    expect(describeHarnessLimit(unowned)).toBe("account open (no owner named) is out of credit (card t1, authorized by bob)");
  } finally {
    t.done();
  }
});

test("usage:report splits spend per person and per account; older results land under (unrecorded)", () => {
  const at = "2026-11-20T00:00:00Z";
  const log = [
    { type: "result", taskId: "a", agentId: "x", actualCost: 1, harnessId: "alices", principalId: "alice", at },
    { type: "result", taskId: "b", agentId: "x", actualCost: 2, harnessId: "team", principalId: "bob", retryAfter: at, at },
    { type: "result", taskId: "c", agentId: "x", actualCost: 4, at },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  const since = new Date("2026-11-01T00:00:00Z");
  const s = summarizeUsage(parseResultEvents(log), since);
  expect(s.principals.map((p) => [p.id, p.costUsd, p.cutByLimit])).toEqual([
    [UNRECORDED, 4, 0],
    ["bob", 2, 1],
    ["alice", 1, 0],
  ]);
  expect(s.harnesses.map((p) => p.id)).toEqual([UNRECORDED, "team", "alices"]);
  const out = formatReport(s, since);
  expect(out).toContain("person");
  expect(out).toContain("account");
  expect(out).toMatch(/bob\s+1\s+\$2\.00/);
});

test("the account line shows each harness's owner and whether it is shared", () => {
  const rows = buildAccountStatus({
    harnesses: [h({ id: "alices", ownerPrincipalId: "alice" }), h({ id: "team", ownerPrincipalId: "alice", shared: true }), h({ id: "open" })],
    tasks: [],
    agents: { get: () => undefined },
    activeCount: () => 0,
  });
  expect(rows.map((r) => [r.id, r.ownerPrincipalId, r.shared])).toEqual([
    ["alices", "alice", undefined],
    ["team", "alice", true],
    ["open", undefined, undefined],
  ]);
});
