import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createApp } from "../src/api/server.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { Registry } from "../src/core/registry.ts";
import { auditQuery, auditTableHtml, grantFormHtml, MEMBER_PERMISSIONS, membersTableHtml } from "../src/api/public/board-members.js";
import { principalOf, withIdentityRoutes } from "../src/api/sign-in.ts";
import { AuthorizationLog, OWNER_PRINCIPAL_ID } from "../src/services/authorization.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { IdentityStore } from "../src/services/identity.ts";
import { leaverTask, stopCardsOf } from "../src/services/leavers.ts";
import { GrantStore, PERMISSIONS } from "../src/services/permissions.ts";
import { isHeld } from "../src/services/plan-hold.ts";

// docs/SDD-identity-and-permissions.md §4.9, §6, §11 q5; card 7: the
// members page and audit view, and a disabled member's cards stopping to
// ask.

describe("the members and audit pages", () => {
  test("every value is escaped, so a handle or reason can't become markup", () => {
    const html = membersTableHtml([{ id: "x1", handle: "<img src=x onerror=alert(1)>", display: '"quoted"', kind: "person", grants: [{ id: "g1", permissions: ["card.run"], scope: { kind: "workstream", id: "w123456789" } }], tokens: [{}, { revokedAt: "t" }] }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&quot;quoted&quot;");
    expect(html).toContain("card.run · workstream w1234567");
    expect(html).toContain("1 live");
    const audit = auditTableHtml([{ ts: "2026-11-28T10:00:00.000Z", principalId: "x1", action: { kind: "POST /tasks/:id/merge", target: "t1" }, outcome: "denied", reason: "<script>x</script>" }], () => "dana");
    expect(audit).not.toContain("<script>");
    expect(audit).toContain('class="au-denied"');
  });

  test("the owner holds everything and has no actions; a new member sees nothing; a disabled one is marked", () => {
    const html = membersTableHtml([
      { id: "owner", handle: "milton", display: "Milton", kind: "person" },
      { id: "d", handle: "dana", display: "Dana", kind: "person" },
      { id: "e", handle: "eve", display: "Eve", kind: "person", disabledAt: "2026-11-28T09:00:00Z" },
    ]);
    expect(html).toContain("owner, holds everything");
    expect(html).toContain("none: sees nothing");
    expect(html).toContain('data-disable="d"');
    expect(html).not.toContain('data-disable="owner"');
    expect(html).not.toContain('data-disable="e"');
    expect(html).toContain("disabled 2026-11-28");
  });

  test("the grant form offers exactly the server's permissions; the audit query carries the filters", () => {
    expect(MEMBER_PERMISSIONS).toEqual([...PERMISSIONS]);
    expect((grantFormHtml("d").match(/name="perm"/g) ?? []).length).toBe(PERMISSIONS.length);
    expect(auditQuery({})).toBe("/audit?limit=200");
    expect(auditQuery({ principal: "d 1", outcome: "denied", kind: "POST /tasks/:id/merge" })).toBe("/audit?limit=200&principal=d%201&outcome=denied&kind=POST%20%2Ftasks%2F%3Aid%2Fmerge");
  });

  test("the audit filters by outcome", () => {
    const log = new AuthorizationLog(new Database(":memory:"));
    const a = log.begin({ action: { kind: "k", target: "t" }, principalId: "owner", via: "direct" });
    log.complete(a.id, "allowed");
    const d = log.begin({ action: { kind: "k", target: "t" }, principalId: "dana", via: "direct" });
    log.complete(d.id, "denied", { reason: "needs card.merge" });
    expect(log.list({ outcome: "denied" }).map((r) => r.principalId)).toEqual(["dana"]);
  });
});

describe("a disabled member's cards stop and ask", () => {
  test("their unstarted cards are held; running ones are listed; an owner task says so", async () => {
    const board = new SqliteBoard();
    const mk = async (title: string, by: string) => {
      const c = await board.create({ title, body: "b", labels: [], repo: "/tmp/r", dependsOn: [] });
      board.attribute(c.id, by);
      return c;
    };
    const queued = await mk("Add export", "dana");
    const running = await mk("Fix login", "dana");
    await board.move(running.id, "running");
    const done = await mk("Old", "dana");
    await board.move(done.id, "done");
    const others = await mk("Someone else's", "owner");
    const out = await stopCardsOf(board, "dana", new Date());
    expect(out.held.map((c) => c.id)).toEqual([queued.id]);
    expect(out.running.map((c) => c.id)).toEqual([running.id]);
    expect(isHeld((await board.get(queued.id))!)).toBe(true);
    expect(isHeld((await board.get(others.id))!)).toBe(false);
    const task = leaverTask("dana", out)!;
    expect(task.title).toBe("Cards dana authorized wait for you");
    expect(task.why).toContain('Held, not started: "Add export"');
    expect(task.why).toContain('Still running, and will finish: "Fix login"');
    expect(leaverTask("dana", { held: [], running: [] })).toBeUndefined();
  });

  test("disable calls the hook once; re-authorize moves the card onto the caller and releases it", async () => {
    const board = new SqliteBoard();
    const db = board.db;
    const log = new AuthorizationLog(db);
    log.ensureOwner("milton");
    const identity = new IdentityStore(db);
    const grants = new GrantStore(db);
    const dana = (identity.addPerson("dana", "Dana") as { principal: { id: string } }).principal.id;
    const calls: string[] = [];
    const routes = withIdentityRoutes(() => new Response("{}"), identity, grants, async (id, handle) => (calls.push(`${id}:${handle}`), "1 held"));
    const disable = () => routes(new Request(`http://x/members/${dana}/disable`, { method: "POST" }));
    expect(await (await disable()).json()).toMatchObject({ handle: "dana", cards: "1 held" });
    await disable();
    expect(calls).toEqual([`${dana}:dana`]);
    expect(principalOf(new Request("http://x"))).toBe(OWNER_PRINCIPAL_ID);

    const card = await board.create({ title: "Add export", body: "b", labels: [], repo: "/tmp/r", dependsOn: [] });
    board.attribute(card.id, dana);
    await stopCardsOf(board, dana, new Date());
    const app = createApp(board, await Registry.load(), undefined, { harnesses: HarnessPool.from([]), authorization: { log, principalFor: () => OWNER_PRINCIPAL_ID } });
    const r = await app(new Request(`http://x/tasks/${card.id}/reauthorize`, { method: "POST" }));
    expect(r.status).toBe(200);
    const after = (await board.get(card.id))!;
    expect(after.authorizedByPrincipalId).toBe(OWNER_PRINCIPAL_ID);
    expect(after.createdByPrincipalId).toBe(dana);
    expect(isHeld(after)).toBe(false);
  });
});
