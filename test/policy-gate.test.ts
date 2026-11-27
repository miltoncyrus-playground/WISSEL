import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteBoard } from "../src/services/board.ts";
import { DEFAULT_HARD_LIMITS, dutyOf, evaluate, gateContextFor, GateLog, hardLimitHit, inQuietHours, loadHardLimits, OUTWARD, type Duty, type GateAction, type GateContext } from "../src/services/policy-gate.ts";
import { ACTION_KINDS, DECISION_KINDS, PROJECT_ROLES, type WorkstreamProject } from "../src/services/workstreams.ts";

// docs/SDD-coordinator.md §4.2, §4.13, §6, §8; phase 3 card 14: the gate,
// its rule order, the hard limits, the append-only log, and a property
// test that no allow ever matches a deny rule.

const NOON = new Date("2026-11-27T12:00:00Z");
const project = (over: Partial<WorkstreamProject> = {}): WorkstreamProject => ({ projectId: "p1", role: "decide", decideAlone: [], mustAsk: [], never: [], ...over });
const ctx = (over: Partial<GateContext> = {}): GateContext => ({ project: project(), hardLimits: DEFAULT_HARD_LIMITS, now: NOON, mainBranch: "main", channels: ["doc:decisions"], ...over });
const v = (a: GateAction, c: GateContext) => {
  const d = evaluate(a, c);
  return `${d.verdict} ${d.rule}${d.mode === "shadow" ? " (shadow)" : ""}`;
};

describe("the rules, in order", () => {
  test("1. hard limits: production, read-only repos, pushing main, arming off main or red, posting outside the channels", () => {
    const limits = { production: { accounts: ["prod-*"], clusters: ["eu-prod"], hosts: ["*.prod.example.com"] }, readOnlyRepos: ["other-team/*"] };
    const c = ctx({ hardLimits: limits });
    expect(v({ kind: "card.start", target: { account: "prod-billing" } }, c)).toBe("deny hard-limit: a production target");
    expect(v({ kind: "card.start", target: { host: "db.prod.example.com" } }, c)).toBe("deny hard-limit: a production target");
    expect(v({ kind: "pr.open", target: { repo: "other-team/api" } }, c)).toBe("deny hard-limit: other-team/api is read-only");
    expect(v({ kind: "branch.push", target: { branch: "main" } }, c)).toBe("deny hard-limit: pushing to the main branch or a long-lived one");
    expect(v({ kind: "branch.push", target: { branch: "feat/A4" } }, c)).toBe("allow role");
    expect(v({ kind: "pr.arm", target: { base: "release", checks: "passing" } }, c)).toContain("whose base is release");
    expect(v({ kind: "pr.arm", target: { base: "main", checks: "failing" } }, c)).toContain("checks are failing");
    expect(v({ kind: "pr.arm", target: { base: "main", checks: "passing" } }, c)).toBe("allow role");
    expect(v({ kind: "channel.post", message: "status", target: { channel: "slack:#random" } }, c)).toBe("deny hard-limit: posting outside the workstream's configured channels");
  });

  test("2-3. never, then a duty owned by an external coordinator, deny before anything else is considered", () => {
    expect(v({ kind: "chat.post", target: { channel: "doc:decisions" } }, ctx({ project: project({ never: ["chat.post"] }), shadow: true }))).toBe("deny never");
    expect(v({ kind: "pr.arm", target: { base: "main", checks: "passing" } }, ctx({ duties: { arming: "external" } }))).toBe("deny duty: arming belongs to an external coordinator");
    expect(v({ kind: "channel.post", message: "claim", target: { channel: "doc:decisions" } }, ctx({ duties: { claims: "external" } }))).toContain("duty: claims");
    expect(v({ kind: "channel.post", message: "question", target: { channel: "doc:decisions" } }, ctx({ duties: { claims: "external" } }))).toBe("allow role");
  });

  test("4. shadow, for the role or the whole instance: allowed, record only", () => {
    expect(v({ kind: "card.start" }, ctx({ project: project({ role: "shadow" }) }))).toBe("allow shadow (shadow)");
    expect(v({ kind: "card.start" }, ctx({ shadow: true }))).toBe("allow shadow (shadow)");
  });

  test("5. quiet hours queue outward actions only, in the workstream's timezone, across midnight", () => {
    const q = { start: "22:00", end: "07:00", timezone: "Europe/Madrid" };
    const night = new Date("2026-11-27T23:30:00Z"); // 00:30 in Madrid
    expect(inQuietHours(q, night)).toBe(true);
    expect(inQuietHours(q, NOON)).toBe(false);
    expect(v({ kind: "chat.post", target: { channel: "doc:decisions" } }, ctx({ quietHours: q, now: night }))).toBe("queue quiet-hours");
    expect(v({ kind: "card.start" }, ctx({ quietHours: q, now: night }))).toBe("allow role");
  });

  test("6. mustAsk asks the decider for follow, the owner otherwise", () => {
    expect(v({ kind: "pr.open" }, ctx({ project: project({ role: "follow", mustAsk: ["pr.open"] }) }))).toBe("ask-decider must-ask");
    expect(v({ kind: "decision", decisionKind: "triage-red" }, ctx({ project: project({ mustAsk: ["triage-red"], decideAlone: [] }) }))).toBe("ask-owner must-ask");
  });

  test("7-8. the role table: follow asks for starts, arms and decisions; decide allows what decideAlone lists; the rest asks the owner", () => {
    const follow = ctx({ project: project({ role: "follow" }) });
    expect(v({ kind: "card.start" }, follow)).toBe("ask-decider role");
    expect(v({ kind: "pr.arm", target: { base: "main", checks: "passing" } }, follow)).toBe("ask-decider role");
    expect(v({ kind: "decision", decisionKind: "plan-batch" }, follow)).toBe("ask-decider role");
    expect(v({ kind: "ticket.comment" }, follow)).toBe("allow role");
    const decide = ctx({ project: project({ role: "decide", decideAlone: ["triage-red"] }) });
    expect(v({ kind: "decision", decisionKind: "triage-red" }, decide)).toBe("allow role");
    expect(v({ kind: "decision", decisionKind: "plan-batch" }, decide)).toBe("ask-owner default");
    expect(v({ kind: "card.start" }, ctx({ project: undefined }))).toBe("ask-owner default: the project is in no workstream");
  });
});

describe("context, limits file and log", () => {
  test("gateContextFor takes the project's lists and the workstream's channels and quiet hours", () => {
    const ws = { projects: [project({ role: "follow" })], channel: { target: "doc:x" }, chat: { channel: "slack:#team" }, quietHours: { start: "22:00", end: "07:00", timezone: "UTC" } };
    const c = gateContextFor(ws, "p1", { hardLimits: DEFAULT_HARD_LIMITS, now: NOON, mainBranch: "main" });
    expect([c.project?.role, c.channels, c.quietHours?.start]).toEqual(["follow", ["doc:x", "slack:#team"], "22:00"]);
    expect(gateContextFor(ws, "p9", { hardLimits: DEFAULT_HARD_LIMITS, now: NOON, mainBranch: "main" }).project).toBeUndefined();
  });

  test("hard-limits.yaml: missing is the defaults; a list is read; a malformed one stops start-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-limits-"));
    try {
      expect(await loadHardLimits(join(dir, "none.yaml"))).toEqual(DEFAULT_HARD_LIMITS);
      writeFileSync(join(dir, "ok.yaml"), "production:\n  accounts: [prod-*]\nreadOnlyRepos:\n  - other-team/*\n");
      expect(await loadHardLimits(join(dir, "ok.yaml"))).toEqual({ production: { accounts: ["prod-*"], clusters: [], hosts: [] }, readOnlyRepos: ["other-team/*"] });
      writeFileSync(join(dir, "bad.yaml"), "readOnlyRepos: everything\n");
      await expect(loadHardLimits(join(dir, "bad.yaml"))).rejects.toThrow("readOnlyRepos must be a list");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the gate log records every decision and can't be rewritten", () => {
    const board = new SqliteBoard();
    const log = new GateLog(board.db, () => NOON);
    const rec = log.decide({ kind: "pr.arm", workstreamId: "ws1", target: { base: "main", checks: "failing" } }, ctx());
    expect(rec).toMatchObject({ workstreamId: "ws1", verdict: "deny", mode: "live", at: NOON.toISOString() });
    expect(log.list("ws1").map((r) => r.id)).toEqual([rec.id]);
    expect(() => board.db.run("DELETE FROM gate_records")).toThrow(/append-only/);
    expect(() => board.db.run("UPDATE gate_records SET verdict = 'allow'")).toThrow(/append-only/);
  });
});

describe("property: no allow ever matches a deny rule (§8)", () => {
  // A small seeded generator, so a failure is reproducible.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const some = <T,>(r: () => number, xs: readonly T[]): T[] => xs.filter(() => r() < 0.2);
  const DUTIES: Duty[] = ["status", "host", "landing", "review", "channel-read", "claims", "ready-to-merge", "arming"];

  test("5,000 random actions and contexts", () => {
    const r = rng(20261127);
    for (let i = 0; i < 5000; i++) {
      const kind = pick(r, [...ACTION_KINDS, "decision"] as const);
      const action: GateAction = {
        kind,
        ...(kind === "decision" ? { decisionKind: pick(r, DECISION_KINDS) } : {}),
        ...(kind === "channel.post" ? { message: pick(r, ["claim", "release", "ready-to-merge", "question", "status"]) } : {}),
        target: {
          ...(r() < 0.3 ? { account: pick(r, ["prod-1", "dev-1"]) } : {}),
          ...(r() < 0.3 ? { repo: pick(r, ["other-team/api", "mine/app"]) } : {}),
          ...(r() < 0.5 ? { branch: pick(r, ["main", "feat/x", "release"]) } : {}),
          ...(r() < 0.5 ? { base: pick(r, ["main", "release"]) } : {}),
          ...(r() < 0.5 ? { checks: pick(r, ["passing", "failing", "pending", "none"] as const) } : {}),
          ...(r() < 0.6 ? { channel: pick(r, ["doc:decisions", "slack:#random"]) } : {}),
        },
      };
      const c: GateContext = {
        ...(r() < 0.85 ? { project: { role: pick(r, PROJECT_ROLES), decideAlone: some(r, DECISION_KINDS), mustAsk: some(r, [...ACTION_KINDS, ...DECISION_KINDS]), never: some(r, ACTION_KINDS) } } : {}),
        hardLimits: { production: { accounts: ["prod-*"], clusters: [], hosts: [] }, readOnlyRepos: ["other-team/*"] },
        duties: Object.fromEntries(DUTIES.filter(() => r() < 0.3).map((d) => [d, "external" as const])),
        shadow: r() < 0.1,
        ...(r() < 0.3 ? { quietHours: { start: "22:00", end: "07:00", timezone: "UTC" } } : {}),
        now: r() < 0.5 ? NOON : new Date("2026-11-27T23:00:00Z"),
        mainBranch: "main",
        channels: ["doc:decisions"],
      };
      const d = evaluate(action, c);
      const duty = dutyOf(action);
      const mustDeny = hardLimitHit(action, c) !== undefined || (c.project?.never.includes(action.kind as never) ?? false) || (duty !== undefined && c.duties?.[duty] === "external");
      if (mustDeny) expect(d.verdict).toBe("deny");
      if (d.verdict === "allow") expect(mustDeny).toBe(false);
      if (d.verdict === "allow" && d.mode === "live" && OUTWARD.has(action.kind)) expect(inQuietHours(c.quietHours, c.now)).toBe(false);
    }
  });
});
