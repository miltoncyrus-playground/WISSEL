import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { AuthorizationLog, describeAction, withAuthorizationRecords } from "../src/services/authorization.ts";
import { PolicyRevisions } from "../src/services/policy-revision.ts";
import { DutyStore, shadowReport } from "../src/services/duties.ts";
import type { GateRecord } from "../src/services/policy-gate.ts";
import type { InboxEvent } from "../src/services/inbox.ts";
import type { TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.13, phase 3 card 20: duties switch over one
// at a time, Shadow runs everything record-only, and the shadow report
// compares what Wissel would have done with what happened.

describe("the store", () => {
  test("every duty is Wissel's until switched; Shadow is off until turned on", () => {
    const s = new DutyStore(new SqliteBoard().db);
    expect(s.list("ws1").map((d) => `${d.duty}:${d.owner}`)).toEqual(["status:wissel", "host:wissel", "landing:wissel", "review:wissel", "channel-read:wissel", "claims:wissel", "ready-to-merge:wissel", "arming:wissel"]);
    s.set("ws1", "claims", "external");
    expect(s.owners("ws1").claims).toBe("external");
    expect(s.owners("ws2").claims).toBe("wissel");
    expect(s.shadow()).toBe(false);
    s.setShadow(true);
    expect(s.shadow()).toBe(true);
  });

  test("an /admin route keeps its name in the audit log", () => {
    expect(describeAction("POST", "/admin/shadow").kind).toBe("POST /admin/shadow");
    expect(describeAction("POST", "/workstreams/2f0c1a3e-1111-4111-8111-111111111111/duties/arming").kind).toBe("POST /workstreams/:id/duties/arming");
  });
});

describe("the shadow report", () => {
  test("would-actions by kind beside what actually happened", () => {
    const rec = (kind: string, message?: string, at = "2026-11-28T08:00:00Z"): GateRecord => ({ id: kind + at, workstreamId: "ws1", action: { kind: kind as never, ...(message ? { message } : {}) }, verdict: "allow", rule: "shadow", mode: "shadow", at });
    const live: GateRecord = { ...rec("card.start"), mode: "live", rule: "role" };
    const entries = [{ kind: "channel.entry", receivedAt: "2026-11-28T09:00:00Z" }, { kind: "channel.entry", receivedAt: "2026-11-27T09:00:00Z" }] as InboxEvent[];
    const cards = [{ id: "a", workstreamId: "ws1", pr: { number: 1, url: "u", head: "h", watch: { armed: true, lifecycle: "ready" } } }, { id: "b", workstreamId: "ws2", pr: { number: 2 } }] as unknown as TaskCard[];
    const r = shadowReport("ws1", [rec("channel.post", "claim", "2026-11-28T10:00:00Z"), rec("channel.post", "status"), rec("pr.arm"), live], entries, cards);
    expect(r.would).toEqual({ "channel.post:claim": 1, "channel.post:status": 1, "pr.arm": 1 });
    expect(r.actual).toEqual({ channelEntries: 1, prsOpened: 1, prsArmed: 1, prsMerged: 0 });
    expect(r.compare).toEqual([
      { kind: "channel.post", would: 2, actual: 1 },
      { kind: "pr.open", would: 0, actual: 1 },
      { kind: "pr.arm", would: 1, actual: 1 },
    ]);
    expect(r.recent.map((x) => [x.kind, x.detail ?? null])).toEqual([["channel.post", "claim"], ["channel.post", "status"], ["pr.arm", null]]);
  });
});

describe("through the API", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-duties-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function setup(principal = "owner") {
    const board = new SqliteBoard();
    const log = new AuthorizationLog(board.db);
    log.ensureOwner("me");
    const policy = new PolicyRevisions(board.db);
    const inner = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), authorization: { log, principalFor: () => principal, policy } });
    const app = withAuthorizationRecords(inner, log, { principalFor: () => principal, policy });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const ws = (await call("POST", "/workstreams", { name: "Checkout", projects: [{ projectId, role: "decide" }], channel: { adapter: "claude-docs", target: "doc:x" } })).body.id as string;
    return { call, ws, projectId, policy };
  }

  test("a duty handed to the external coordinator is confirmed, is a policy revision, and the gate then denies it", async () => {
    const { call, ws, projectId, policy } = await setup();
    const before = policy.current();
    expect(await call("POST", `/workstreams/${ws}/duties/claims`, { owner: "external" })).toMatchObject({ status: 409, body: { confirmRequired: true, from: "wissel", to: "external" } });
    expect(policy.current()).toBe(before);
    expect((await call("POST", `/workstreams/${ws}/duties/claims`, { owner: "external", confirm: true })).body).toMatchObject({ duty: "claims", owner: "external" });
    expect(policy.current()).not.toBe(before);
    const claim = await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "channel.post", message: "claim", projectId, target: { channel: "doc:x" }, payload: { message: { kind: "claim", text: "Taking A4" } } } });
    expect(claim).toMatchObject({ status: 403, body: { status: "denied", record: { rule: "duty: claims belongs to an external coordinator" } } });
    expect((await call("POST", `/workstreams/${ws}/duties/nonsense`, { owner: "external", confirm: true })).status).toBe(400);
  });

  test("Shadow for the instance: confirmed, then every action is recorded and nothing acts; the report shows it", async () => {
    const { call, ws, projectId } = await setup();
    expect((await call("POST", "/admin/shadow", { on: true })).status).toBe(409);
    expect((await call("POST", "/admin/shadow", { on: true, confirm: true })).body).toEqual({ on: true });
    const r = await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "owner.task", projectId, payload: { title: "Rotate the key", why: "Expires.", steps: ["Rotate"] } } });
    expect(r.body).toMatchObject({ status: "recorded", record: { mode: "shadow" } });
    expect((await call("GET", "/owner-tasks?status=open")).body).toEqual([] as never);
    const report = (await call("GET", `/workstreams/${ws}/shadow-report`)).body;
    expect(report.would).toEqual({ "owner.task": 1 });
  });

  test("only the owner switches a duty or Shadow", async () => {
    const { call, ws } = await setup("alice");
    expect((await call("POST", `/workstreams/${ws}/duties/claims`, { owner: "external", confirm: true })).status).toBe(403);
    expect((await call("POST", "/admin/shadow", { on: true, confirm: true })).status).toBe(403);
  });
});
