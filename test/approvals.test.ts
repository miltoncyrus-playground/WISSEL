import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/api/server.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { ApprovalStore } from "../src/services/approvals.ts";
import { AuthorizationLog, OWNER_PRINCIPAL_ID } from "../src/services/authorization.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { contentHashOf, PENDING_TTL_MS, SqlitePendingActionStore } from "../src/services/pending-actions.ts";
import type { ControlAction } from "../src/services/concierge-actions.ts";
import type { PrWatch } from "../src/core/types.ts";

// docs/SDD-identity-and-permissions.md §3.5, §4.5, §8; card 9: approvals
// cover one thing, once, for one person, while it is unchanged.

describe("an approval", () => {
  test("reuse, expiry, another principal and changed content are each refused with their reason", () => {
    const clock = { t: Date.parse("2026-11-28T10:00:00Z") };
    const store = new ApprovalStore(new Database(":memory:"), () => new Date(clock.t));
    const issue = () => store.issue({ principalId: "dana", actionKind: "pr.arm", targetRef: "card:c1#7", contentHash: "a".repeat(40), line: "Arm" });
    const a = issue();
    expect(store.confirm(a.id, "eve", "a".repeat(40))).toEqual({ ok: false, reason: "wrong-principal" });
    expect(store.confirm(a.id, "dana", "b".repeat(40))).toEqual({ ok: false, reason: "changed" });
    expect(store.confirm(a.id, "dana", "a".repeat(40))).toMatchObject({ ok: true, approval: { resolution: "confirmed" } });
    expect(store.confirm(a.id, "dana", "a".repeat(40))).toEqual({ ok: false, reason: "used" });
    const b = issue();
    clock.t += PENDING_TTL_MS + 1;
    expect(store.confirm(b.id, "dana", "a".repeat(40))).toEqual({ ok: false, reason: "expired" });
    expect(store.confirm("nope", "dana", "x")).toEqual({ ok: false, reason: "not-found" });
    const c = issue();
    expect(store.cancel(c.id, "eve")).toEqual({ ok: false, reason: "wrong-principal" });
    expect(store.openFor("dana").map((x) => x.id)).toEqual([c.id]);
  });
});

describe("Ask's pending actions", () => {
  test("bound to who asked and to the cards they touch, as those were", async () => {
    const board = new SqliteBoard();
    const card = await board.create({ title: "Flaky", body: "b", labels: [], repo: "/tmp/r", dependsOn: [] });
    const actions = [{ type: "delete_task", tier: "B", taskId: card.id, title: "Flaky" }] as unknown as ControlAction[];
    const store = new SqlitePendingActionStore(board.db);
    const hash = await contentHashOf(actions, (id) => board.get(id));
    const p = store.create({ conversationId: "c1", messageId: "m1", kind: "confirm", actions, lines: ["Delete Flaky"], principalId: "dana", contentHash: hash });
    expect(store.take(p.id, "c1", new Date(), { by: "eve", contentHash: hash })).toEqual({ ok: false, reason: "wrong-principal" });
    await board.move(card.id, "running");
    const now = await contentHashOf(actions, (id) => board.get(id));
    expect(now).not.toBe(hash);
    expect(store.take(p.id, "c1", new Date(), { by: "dana", contentHash: now })).toEqual({ ok: false, reason: "changed" });
    // Still open for its own person, on the content they saw.
    await board.move(card.id, "inbox");
    expect(store.take(p.id, "c1", new Date(), { by: "dana", contentHash: await contentHashOf(actions, (id) => board.get(id)) }).ok).toBe(true);
  });
});

describe("arming a pull request", () => {
  const reviewed = "a".repeat(40);
  const watch = (headSha: string, armBlockedBy: string | null = null): PrWatch => ({ lifecycle: armBlockedBy ? "landed" : "ready", checks: { state: "passing", headSha, failing: [] }, mergeable: "clean", armed: false, draft: false, base: "main", armBlockedBy, observedAt: "2026-11-28T10:00:00Z" } as PrWatch);

  async function setup() {
    const board = new SqliteBoard();
    const log = new AuthorizationLog(board.db);
    log.ensureOwner("milton");
    const armed: string[] = [];
    let who = OWNER_PRINCIPAL_ID;
    const app = createApp(board, await Registry.load(), undefined, {
      harnesses: HarnessPool.from([]),
      authorization: { log, principalFor: () => who },
      mergeContext: { runner: async () => ({ exitCode: 1, stdout: "", stderr: "no commands here" }), codeHost: { findOpen: async () => undefined, open: async () => ({ ok: false, error: "no" }), arm: async (_repo, n, sha) => (armed.push(`${n}@${sha}`), { ok: true }) } },
    });
    const call = async (method: string, path: string) => {
      const r = await app(new Request(`http://x${path}`, { method }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const card = await board.create({ title: "Add export", body: "b", labels: [], repo: "/tmp/r", dependsOn: [] });
    return { board, call, card, armed, as: (p: string) => void (who = p) };
  }

  test("only once the watcher saw it ready; the approval is bound to the reviewed head and the arm pinned to it", async () => {
    const { board, call, card, armed } = await setup();
    expect((await call("POST", `/tasks/${card.id}/arm`)).body.error).toBe("this card has no pull request");
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: reviewed, reviewedHead: reviewed });
    expect((await call("POST", `/tasks/${card.id}/arm`)).body.error).toBe("the PR watcher hasn't looked at this PR yet");
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: reviewed, reviewedHead: reviewed, watch: watch(reviewed, "checks are pending") });
    expect((await call("POST", `/tasks/${card.id}/arm`)).body.error).toBe("this PR can't be armed: checks are pending");
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: reviewed, reviewedHead: reviewed, watch: watch(reviewed) });
    const issued = await call("POST", `/tasks/${card.id}/arm`);
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({ actionKind: "pr.arm", contentHash: reviewed, principalId: OWNER_PRINCIPAL_ID, line: `Arm auto-merge on PR #7 of "Add export" at ${reviewed.slice(0, 12)}` });
    expect(((await call("GET", "/approvals")).body as unknown as unknown[]).length).toBe(1);
    const ok = await call("POST", `/approvals/${issued.body.id}/confirm`);
    expect(ok.body).toMatchObject({ armed: true });
    expect(armed).toEqual([`7@${reviewed}`]);
    expect((await call("POST", `/approvals/${issued.body.id}/confirm`)).status).toBe(409);
  });

  test("an arm against a moved head is refused, and so is someone else's confirm", async () => {
    const { board, call, card, armed, as } = await setup();
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: reviewed, reviewedHead: reviewed, watch: watch(reviewed) });
    const issued = await call("POST", `/tasks/${card.id}/arm`);
    as("dana");
    expect((await call("POST", `/approvals/${issued.body.id}/confirm`)).status).toBe(403);
    as(OWNER_PRINCIPAL_ID);
    // A push after the review: the head moved.
    await board.setPullRequest(card.id, { number: 7, url: "https://example.invalid/7", head: "b".repeat(40), reviewedHead: reviewed, watch: watch("b".repeat(40)) });
    const moved = await call("POST", `/approvals/${issued.body.id}/confirm`);
    expect(moved.status).toBe(409);
    expect(moved.body.error).toContain("the PR's head moved since it was reviewed");
    expect(armed).toEqual([]);
  });
});
