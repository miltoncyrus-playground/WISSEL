import { describe, expect, test } from "bun:test";
import { AuthorizationLog, OWNER_PRINCIPAL_ID, withAuthorizationRecords } from "../src/services/authorization.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { CARD_TOKEN_TTL_MS, IdentityStore } from "../src/services/identity.ts";
import { GrantStore } from "../src/services/permissions.ts";
import { withPermissions } from "../src/api/permission-door.ts";
import { principalOf, withIdentityRoutes, withSignIn } from "../src/api/sign-in.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Orchestrator } from "../src/core/orchestrator.ts";
import { Registry } from "../src/core/registry.ts";
import { Router } from "../src/core/router.ts";
import type { AgentDef, Executor } from "../src/core/types.ts";

// docs/SDD-identity-and-permissions.md §4.8, card 8: each card run is an
// agent principal with nothing, and its token reaches only its own card.

function setup(clock = { t: Date.parse("2026-11-28T10:00:00Z") }) {
  const board = new SqliteBoard();
  const log = new AuthorizationLog(board.db, () => new Date(clock.t));
  log.ensureOwner("milton");
  const identity = new IdentityStore(board.db, () => new Date(clock.t));
  const grants = new GrantStore(board.db, () => new Date(clock.t));
  const inner = (req: Request) => new Response(JSON.stringify({ principal: principalOf(req) }), { headers: { "Content-Type": "application/json" } });
  const fetch = withSignIn(withAuthorizationRecords(withPermissions(withIdentityRoutes(inner, identity, grants), { grants, placeOf: async () => undefined }), log, { principalFor: principalOf }), { mode: "tokens", identity, secure: false });
  const call = (token: string, method: string, path: string) => fetch(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${token}` } }));
  return { board, log, identity, grants, call, clock };
}

describe("a card run's token", () => {
  test("a new agent principal per run, which holds no grants and can't be granted any", () => {
    const { identity, grants, board } = setup();
    const a = identity.issueCardToken("t1", "Add export");
    const b = identity.issueCardToken("t1", "Add export");
    expect(a.principalId).not.toBe(b.principalId);
    expect(a.secret).toStartWith("wsc_");
    const p = identity.principal(a.principalId)!;
    expect([p.kind, p.display]).toEqual(["agent", 'Run of "Add export"']);
    expect(p.handle).toStartWith("card-t1-");
    expect(grants.grant(OWNER_PRINCIPAL_ID, a.principalId, { kind: "instance" }, ["board.read"])).toMatchObject({ ok: false, error: "an agent principal can never hold a grant" });
    expect(JSON.stringify(board.db.query("SELECT * FROM card_tokens").all())).not.toContain(a.secret);
  });

  test("it reads its own card and nothing else, and writes nothing", async () => {
    const { identity, call, log } = setup();
    const { secret, principalId } = identity.issueCardToken("t1");
    expect((await call(secret, "GET", "/tasks/t1")).status).toBe(200);
    expect((await call(secret, "GET", "/tasks/t1/output")).status).toBe(200);
    expect(await (await call(secret, "GET", "/me")).json()).toEqual({ principal: principalId });
    for (const [m, p] of [["GET", "/tasks/t2"], ["GET", "/tasks"], ["POST", "/tasks/t1/merge"], ["POST", "/tasks/t1/result"], ["POST", "/tasks"], ["POST", "/members/x/grants"], ["POST", "/tokens"]] as const) {
      const r = await call(secret, m, p);
      expect([m, p, r.status]).toEqual([m, p, 403]);
    }
    // Its writes are recorded, as its own, and denied.
    expect(log.list({ principalId }).every((r) => r.outcome === "denied")).toBe(true);
    expect(log.list({ principalId }).length).toBe(5);
  });

  test("it stops working once revoked or expired", async () => {
    const { identity, call, clock } = setup();
    const a = identity.issueCardToken("t1");
    identity.revokeCardToken(a.principalId);
    expect((await call(a.secret, "GET", "/tasks/t1")).status).toBe(401);
    const b = identity.issueCardToken("t1");
    clock.t += CARD_TOKEN_TTL_MS + 1;
    expect((await call(b.secret, "GET", "/tasks/t1")).status).toBe(401);
  });
});

describe("the orchestrator", () => {
  const agent: AgentDef = {
    id: "reader", name: "reader", kind: "agent", tier: "readonly", description: "test", whenToUse: "test", tags: ["intake"], executor: "readonly",
    inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"], costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 },
  };

  test("puts the run's token into the run's environment and revokes it when the run ends", async () => {
    const seen: Record<string, string>[] = [];
    const exec: Executor = { id: "fake", harnessTool: "claude-cli", canHandle: () => true, run: async (task, a, h) => (seen.push({ ...(h?.env ?? {}) }), { taskId: task.id, agentId: a.id, ok: true, summary: "ran" }) };
    const harnesses = HarnessPool.from([{ id: "claude", tool: "claude-cli", label: "c", enabled: true, env: { CLAUDE_CONFIG_DIR: "/x" } }]);
    const board = new SqliteBoard();
    const registry = Registry.from([agent]);
    const issued: string[] = [];
    const revoked: string[] = [];
    const orch = new Orchestrator(board, registry, new Router(registry), [exec], undefined, {
      harnesses,
      credentials: (task) => (issued.push(task.id), { env: { WISSEL_TOKEN: `wsc_for_${task.id}`, WISSEL_CARD_ID: task.id }, revoke: () => void revoked.push(task.id) }),
    });
    const card = await board.create({ title: "read it", body: "", labels: ["intake"], repo: "r" });
    await orch.sweep();
    expect(seen).toEqual([{ CLAUDE_CONFIG_DIR: "/x", WISSEL_TOKEN: `wsc_for_${card.id}`, WISSEL_CARD_ID: card.id }]);
    expect([issued, revoked]).toEqual([[card.id], [card.id]]);
    // The pool's own harness is untouched: the token was only for that run.
    expect(harnesses.all()[0]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/x" });
  });
});
