import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorizationLog, withAuthorizationRecords } from "../src/services/authorization.ts";
import { PolicyRevisions } from "../src/services/policy-revision.ts";
import { TelemetryLog } from "../src/services/telemetry.ts";

const ok = (status = 200) => new Response("{}", { status, headers: { "Content-Type": "application/json" } });

describe("PolicyRevisions", () => {
  test("starts at r0 and bumps once per change, recording who and what", () => {
    const p = new PolicyRevisions(new Database(":memory:"));
    expect(p.current()).toBe("r0");
    expect(p.bump("POST /projects/:id/settings", "billing", "owner")).toBe("r1");
    expect(p.bump("POST /projects/:id/merge-gate", "billing", "owner")).toBe("r2");
    expect(p.history().map((h) => [h.revision, h.what, h.principalId])).toEqual([
      ["r2", "POST /projects/:id/merge-gate", "owner"],
      ["r1", "POST /projects/:id/settings", "owner"],
    ]);
  });

  test("history is append-only", () => {
    const db = new Database(":memory:");
    const p = new PolicyRevisions(db);
    p.bump("x", "y", "owner");
    expect(() => db.run("DELETE FROM policy_revisions")).toThrow(/append-only/);
    expect(() => db.run("UPDATE policy_revisions SET principalId = 'someone'")).toThrow(/append-only/);
  });
});

describe("policy at the front door", () => {
  function setup() {
    const db = new Database(":memory:");
    return { log: new AuthorizationLog(db), policy: new PolicyRevisions(db) };
  }

  test("a successful policy write bumps the revision; the record names the revision it ran under", async () => {
    const { log, policy } = setup();
    const f = withAuthorizationRecords(() => ok(), log, { principalFor: () => "owner", policy });
    await f(new Request("http://x/projects/billing/settings", { method: "POST", body: "{}" }));
    expect(policy.current()).toBe("r1");
    expect(log.list()[0]?.policyRevision).toBe("r0");
    await f(new Request("http://x/tasks/t1/run", { method: "POST" }));
    expect(log.list()[0]?.policyRevision).toBe("r1");
    expect(policy.current()).toBe("r1");
  });

  test("a refused policy write changes nothing", async () => {
    const { log, policy } = setup();
    const f = withAuthorizationRecords(() => ok(400), log, { principalFor: () => "owner", policy });
    await f(new Request("http://x/projects/billing/merge-gate", { method: "POST", body: "{}" }));
    expect(policy.current()).toBe("r0");
  });
});

describe("telemetry carries the revision", () => {
  test("every event is stamped with the revision in force when it was written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-policy-"));
    try {
      const policy = new PolicyRevisions(new Database(":memory:"));
      const t = new TelemetryLog(join(dir, "t.jsonl"), () => ({ policyRevision: policy.current() }));
      await t.record({ type: "dispatch", taskId: "a", agentId: "implementer" });
      policy.bump("x", "y", "owner");
      await t.record({ type: "dispatch", taskId: "b", agentId: "implementer" });
      const lines = readFileSync(join(dir, "t.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { taskId: string; policyRevision: string });
      expect(lines.map((l) => [l.taskId, l.policyRevision])).toEqual([["a", "r0"], ["b", "r1"]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without a stamp the log writes exactly what it did before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-policy-"));
    try {
      const t = new TelemetryLog(join(dir, "t.jsonl"));
      await t.record({ type: "dispatch", taskId: "a", agentId: "implementer" });
      expect(Object.keys(JSON.parse(readFileSync(join(dir, "t.jsonl"), "utf8")))).toEqual(["type", "taskId", "agentId", "at"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
