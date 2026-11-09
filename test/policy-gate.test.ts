import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { Registry } from "../src/core/registry.ts";
import { SqliteBoard } from "../src/services/board.ts";
import {
  ACTION_KINDS, DEFAULT_HARD_LIMITS, OUTWARD_KINDS, PolicyGate, SqliteGateLog, dutyFor, evaluate, loadHardLimits,
  type Action, type GateContext, type ProjectRole,
} from "../src/services/policy-gate.ts";
import { SqliteWorkstreamStore } from "../src/services/workstreams.ts";

const act = (kind: string, more: Partial<Action> = {}): Action => ({ kind, workstreamId: "w1", projectId: "p1", ...more });
const ctx = (more: Partial<GateContext> = {}): GateContext => ({
  role: "decide", decideAlone: [], mustAsk: [], never: [], limits: DEFAULT_HARD_LIMITS, mainBranch: "main", channels: ["#dev"],
  duties: {}, quiet: false, shadow: false, ...more,
});
const ROLES: ProjectRole[] = ["follow", "decide", "decide-over"];

test("rule 1: hard limits deny before anything else, for every role", () => {
  for (const role of ROLES) {
    const c = ctx({ role, limits: { production: ["prod-*", "acct-123"], readOnlyRepos: ["org/legacy"] } });
    expect(evaluate(act("branch.push", { base: "release" }), c)).toMatchObject({ verdict: "deny", rule: "1:hard-limit", mode: "live" });
    expect(evaluate(act("pr.arm", { base: "main", checks: "red" }), c).verdict).toBe("deny");
    expect(evaluate(act("pr.arm", { base: "main", checks: "pending" }), c).verdict).toBe("deny");
    expect(evaluate(act("pr.open", { foreign: true }), c).verdict).toBe("deny");
    expect(evaluate(act("branch.push", { base: "main", repo: "org/legacy" }), c).verdict).toBe("deny");
    expect(evaluate(act("channel.post", { post: "status", channel: "#random" }), c).verdict).toBe("deny");
    expect(evaluate(act("chat.post", { channel: "#random" }), c).verdict).toBe("deny");
    expect(evaluate(act("ticket.comment", { targets: ["prod-eu"] }), c).verdict).toBe("deny");
    expect(evaluate(act("card.start", { targets: ["acct-123"] }), c).verdict).toBe("deny");
    // The limits win over an explicit mustAsk and over decideAlone.
    expect(evaluate(act("pr.arm", { base: "main", checks: "red" }), { ...c, mustAsk: ["pr.arm"] }).rule).toBe("1:hard-limit");
  }
});

test("rule 2: the project's never list denies, rule 3: an external duty denies", () => {
  expect(evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ never: ["pr.arm"] }))).toMatchObject({ verdict: "deny", rule: "2:never" });
  expect(evaluate(act("channel.post", { post: "decision", decision: "schema" }), ctx({ never: ["schema"] })).rule).toBe("2:never");
  const external = ctx({ duties: { arming: "external", claims: "external", host: "external" } });
  expect(evaluate(act("pr.arm", { base: "main", checks: "green" }), external)).toMatchObject({ verdict: "deny", rule: "3:duty-external" });
  expect(evaluate(act("channel.post", { post: "claim" }), external).rule).toBe("3:duty-external");
  expect(evaluate(act("host.pause"), external).rule).toBe("3:duty-external");
  expect(evaluate(act("channel.post", { post: "ready-to-merge" }), external).verdict).not.toBe("deny");
  expect(evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ duties: { arming: "wissel" } })).verdict).toBe("allow");
});

test("rule 4: quiet hours queue outward kinds only, after the deny rules", () => {
  const quiet = ctx({ quiet: true });
  for (const kind of ACTION_KINDS) {
    const v = evaluate(act(kind, { base: "main", checks: "green", post: "status" }), quiet);
    if (OUTWARD_KINDS.has(kind)) expect(v).toMatchObject({ verdict: "queue", rule: "4:quiet-hours" });
    else expect(v.verdict).not.toBe("queue");
  }
  expect(evaluate(act("chat.post", { channel: "#dev" }), { ...quiet, never: ["chat.post"] }).verdict).toBe("deny");
});

test("rule 5: mustAsk asks the decider for follow and the owner otherwise", () => {
  const a = act("channel.post", { post: "decision", decision: "naming" });
  expect(evaluate(a, ctx({ role: "follow", mustAsk: ["naming"] }))).toMatchObject({ verdict: "ask-decider", rule: "5:must-ask" });
  expect(evaluate(a, ctx({ role: "decide", mustAsk: ["naming"], decideAlone: ["naming"] })).verdict).toBe("ask-owner");
  expect(evaluate(a, ctx({ role: "decide-over", mustAsk: ["naming"] })).verdict).toBe("ask-owner");
  expect(evaluate(act("pr.open"), ctx({ role: "decide", mustAsk: ["pr.open"] })).verdict).toBe("ask-owner");
});

test("rule 6: the role table, rule 7: everything else asks the owner", () => {
  const green = { base: "main", checks: "green" as const };
  // card.start: follow after the claim answer, decide always, decide-over for its own cards.
  expect(evaluate(act("card.start"), ctx({ role: "follow" }))).toMatchObject({ verdict: "ask-owner", rule: "7:default" });
  expect(evaluate(act("card.start", { answered: true }), ctx({ role: "follow" }))).toMatchObject({ verdict: "allow", rule: "6:role-table" });
  expect(evaluate(act("card.start"), ctx({ role: "decide" })).verdict).toBe("allow");
  expect(evaluate(act("card.start", { own: false }), ctx({ role: "decide-over" })).verdict).toBe("ask-owner");
  expect(evaluate(act("card.start"), ctx({ role: "decide-over" })).verdict).toBe("allow");
  for (const role of ROLES) {
    expect(evaluate(act("channel.post", { post: "claim" }), ctx({ role })).verdict).toBe("allow");
    for (const kind of ["ticket.transition", "ticket.comment", "chat.post"]) expect(evaluate(act(kind, { channel: "#dev" }), ctx({ role })).verdict).toBe("allow");
    // Kinds the table does not list, and unknown kinds, ask the owner: never allow.
    for (const kind of ["card.stop", "pr.merge-forward", "owner.task", "host.pause", "made.up"]) expect(evaluate(act(kind), ctx({ role }))).toMatchObject({ verdict: "ask-owner", rule: "7:default" });
  }
  // decisions: follow asks the decider; the others need decideAlone.
  const decision = act("channel.post", { post: "decision", decision: "naming" });
  expect(evaluate(decision, ctx({ role: "follow" }))).toMatchObject({ verdict: "ask-decider", rule: "6:role-table" });
  expect(evaluate(decision, ctx({ role: "decide" })).verdict).toBe("ask-owner");
  expect(evaluate(decision, ctx({ role: "decide", decideAlone: ["naming"] })).verdict).toBe("allow");
  expect(evaluate(decision, ctx({ role: "decide-over", decideAlone: ["naming"] })).verdict).toBe("allow");
  // pr.arm: follow never arms, decide and decide-over do.
  expect(evaluate(act("pr.arm", green), ctx({ role: "follow" })).verdict).toBe("ask-owner");
  expect(evaluate(act("pr.arm", green), ctx({ role: "decide" })).verdict).toBe("allow");
  expect(evaluate(act("pr.arm", green), ctx({ role: "decide-over" })).verdict).toBe("allow");
});

test("shadow runs every rule and marks the verdict shadow", () => {
  const live = evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ role: "decide" }));
  expect(live.mode).toBe("live");
  expect(evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ role: "decide", shadow: true }))).toEqual({ ...live, mode: "shadow" });
  expect(evaluate(act("pr.arm", { base: "main", checks: "red" }), ctx({ role: "shadow" }))).toMatchObject({ verdict: "deny", rule: "1:hard-limit", mode: "shadow" });
  expect(evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ role: "shadow" }))).toMatchObject({ verdict: "allow", mode: "shadow" });
});

/** Seeded PRNG (mulberry32), so a failure is reproducible from the seed. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("property: no allow ever matches a deny rule; quiet hours queue outward kinds only; unknown kinds never allow", () => {
  const r = rng(20261109);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = <T>(x: T): T | undefined => (r() < 0.5 ? x : undefined);
  const KINDS = [...ACTION_KINDS, "made.up", "pr.delete"];
  const WORDS = ["naming", "schema", "pr.arm", "chat.post", "card.start", "x"];
  const DUTIES = ["status", "host", "landing", "review", "channel-read", "claims", "ready-to-merge", "arming"] as const;
  const list = (xs: readonly string[]) => xs.filter(() => r() < 0.3);
  for (let i = 0; i < 3000; i++) {
    const a: Action = {
      kind: pick(KINDS), workstreamId: "w", projectId: "p", post: maybe(pick(["claim", "release", "ready-to-merge", "question", "decision", "status"])),
      decision: maybe(pick(WORDS)), base: maybe(pick(["main", "release"])), repo: maybe(pick(["org/app", "org/legacy"])),
      checks: maybe(pick(["green", "red", "pending"] as const)), foreign: maybe(true), channel: maybe(pick(["#dev", "#random"])),
      targets: maybe([pick(["prod-eu", "staging", "acct-1"])]), own: maybe(r() < 0.5), answered: maybe(true),
    };
    const duties: GateContext["duties"] = {};
    for (const d of DUTIES) if (r() < 0.3) duties[d] = pick(["external", "wissel"] as const);
    const c: GateContext = {
      role: pick(["shadow", ...ROLES]), decideAlone: list(WORDS), mustAsk: list(WORDS), never: list([...KINDS, ...WORDS]),
      limits: { production: list(["prod-*", "acct-1"]), readOnlyRepos: list(["org/legacy"]) }, mainBranch: "main", channels: list(["#dev", "#random"]),
      duties, quiet: r() < 0.3, shadow: r() < 0.3,
    };
    const v = evaluate(a, c);
    const outward = OUTWARD_KINDS.has(a.kind);
    const hardLimit =
      (a.targets ?? []).some((t) => c.limits.production.some((p) => new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(t))) ||
      ((a.kind === "branch.push" || a.kind === "pr.arm") && a.base !== c.mainBranch) || (a.kind === "pr.arm" && a.checks !== "green") ||
      (a.repo !== undefined && c.limits.readOnlyRepos.includes(a.repo)) || a.foreign === true ||
      ((a.kind === "channel.post" || a.kind === "chat.post") && a.channel !== undefined && !c.channels.includes(a.channel));
    const duty = dutyFor(a);
    const denies = hardLimit || c.never.includes(a.kind) || (a.decision !== undefined && c.never.includes(a.decision)) || (duty !== undefined && duties[duty] === "external");
    const where = `#${i} ${JSON.stringify({ a, c, v })}`;
    if (hardLimit || c.never.includes(a.kind)) expect(v.verdict, where).toBe("deny");
    if (v.verdict === "allow") expect(denies, where).toBe(false);
    if (v.verdict === "allow") expect((ACTION_KINDS as readonly string[]).includes(a.kind), where).toBe(true);
    if (v.verdict === "queue") expect(outward && c.quiet, where).toBe(true);
    if (c.quiet && outward && v.verdict !== "deny") expect(v.verdict, where).toBe("queue");
    expect(v.mode, where).toBe(c.shadow || c.role === "shadow" ? "shadow" : "live");
    if (c.shadow && c.role !== "shadow") expect(evaluate(a, { ...c, shadow: false }), where).toEqual({ ...v, mode: "live" });
  }
});

test("hard limits come from a file read at start, with defaults in code", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/wissel-gate-${Math.random().toString(36).slice(2)}`;
  expect(await loadHardLimits(`${dir}/none.yaml`)).toEqual(DEFAULT_HARD_LIMITS);
  await Bun.write(`${dir}/hard-limits.yaml`, "production: [prod-*, 'acct-42']\nreadOnlyRepos: [org/legacy]\n");
  expect(await loadHardLimits(`${dir}/hard-limits.yaml`)).toEqual({ production: ["prod-*", "acct-42"], readOnlyRepos: ["org/legacy"] });
  await Bun.write(`${dir}/bad.yaml`, "production: 3\n");
  await expect(loadHardLimits(`${dir}/bad.yaml`)).rejects.toThrow(/production/);
});

test("every evaluation appends a GateRecord; the log is append-only and served per workstream", async () => {
  const board = new SqliteBoard();
  const log = new SqliteGateLog(board.db);
  const gate = new PolicyGate(log);
  const v = await gate.evaluate(act("pr.arm", { base: "main", checks: "green" }), ctx({ role: "decide" }));
  await gate.evaluate(act("made.up", { workstreamId: "w2" }), ctx({ role: "decide" }));
  await gate.evaluate(act("pr.arm", { base: "main", checks: "red" }), ctx({ role: "shadow" }));
  const records = await log.list("w1");
  expect(records.map((r) => [r.verdict, r.rule, r.mode])).toEqual([["allow", "6:role-table", "live"], ["deny", "1:hard-limit", "shadow"]]);
  expect(records[0]).toMatchObject({ id: expect.any(String), action: act("pr.arm", { base: "main", checks: "green" }), at: expect.any(String), verdict: v.verdict });
  expect((await log.list("w2")).map((r) => r.action.kind)).toEqual(["made.up"]);
  expect(() => board.db.run(`DELETE FROM gate_log`)).toThrow(/append-only/);
  expect(() => board.db.run(`UPDATE gate_log SET verdict = 'allow'`)).toThrow(/append-only/);
  expect((await log.list("w1")).length).toBe(2);

  const ws = await new SqliteWorkstreamStore(board.db).create({ name: "w", projects: [] });
  await gate.evaluate(act("chat.post", { workstreamId: ws.id, channel: "#dev" }), ctx());
  const app = createApp(board, await Registry.load(), undefined, { gateLog: log });
  const res = await app(new Request(`http://x/workstreams/${ws.id}/gate-log`));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject([{ verdict: "allow", action: { kind: "chat.post", workstreamId: ws.id } }]);
  expect((await app(new Request("http://x/workstreams/nope/gate-log"))).status).toBe(404);
});
