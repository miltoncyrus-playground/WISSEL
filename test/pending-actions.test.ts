import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PENDING_TTL_MS, REFUSAL_TEXT, SqlitePendingActionStore, pendingState, pendingView } from "../src/services/pending-actions.ts";
import type { ControlAction } from "../src/services/concierge-actions.ts";

// docs/SDD-wissel-app.md §3.7: a Tier B action waits here for a Confirm
// tap. Used once, in time, in its own chat; anything else fails closed.

const merge: ControlAction = { type: "merge_task", tier: "B", taskIds: ["t1"], batch: false };
const T0 = new Date("2026-10-11T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function store() {
  const s = new SqlitePendingActionStore(new Database(":memory:"));
  const p = s.create({ conversationId: "c1", messageId: "m1", kind: "confirm", actions: [merge], lines: ["Merge 'X' (card t1)"] }, T0);
  return { s, p };
}

describe("SqlitePendingActionStore", () => {
  test("create stores the action with a 10 minute expiry, open", () => {
    const { s, p } = store();
    expect(PENDING_TTL_MS).toBe(600_000);
    expect(p.expiresAt).toBe("2026-10-11T10:10:00.000Z");
    expect(s.get(p.id)).toEqual(p);
    expect(pendingState(p, T0)).toBe("open");
    expect(s.forMessage("m1").map((x) => x.id)).toEqual([p.id]);
    expect(s.forMessage("other")).toEqual([]);
  });

  test("confirm takes it once; a second confirm or a cancel after it is refused", () => {
    const { s, p } = store();
    const first = s.take(p.id, "c1", at(1000));
    expect(first.ok).toBe(true);
    expect(first.ok && first.pending.resolution).toBe("confirmed");
    expect(s.take(p.id, "c1", at(2000))).toEqual({ ok: false, reason: "used" });
    expect(s.cancel(p.id, "c1", at(2000))).toEqual({ ok: false, reason: "used" });
    s.finish(p.id, []);
    expect(s.get(p.id)!.outcome).toEqual([]);
    expect(pendingView(s.get(p.id)!, at(3000)).state).toBe("confirmed");
  });

  test("expired: refused at and after the expiry instant, and shown as expired", () => {
    const { s, p } = store();
    expect(s.take(p.id, "c1", at(PENDING_TTL_MS))).toEqual({ ok: false, reason: "expired" });
    expect(s.cancel(p.id, "c1", at(PENDING_TTL_MS + 1))).toEqual({ ok: false, reason: "expired" });
    expect(pendingState(s.get(p.id)!, at(PENDING_TTL_MS))).toBe("expired");
    // One millisecond before, it still works.
    const fresh = store();
    expect(fresh.s.take(fresh.p.id, "c1", at(PENDING_TTL_MS - 1)).ok).toBe(true);
  });

  test("the wrong conversation is refused and leaves it usable in the right one", () => {
    const { s, p } = store();
    expect(s.take(p.id, "c2", at(1000))).toEqual({ ok: false, reason: "wrong-conversation" });
    expect(s.cancel(p.id, "c2", at(1000))).toEqual({ ok: false, reason: "wrong-conversation" });
    expect(s.take(p.id, "c1", at(1000)).ok).toBe(true);
  });

  test("an unknown id is not found", () => {
    const { s } = store();
    expect(s.take("nope", "c1", T0)).toEqual({ ok: false, reason: "not-found" });
  });

  test("cancel closes it; a confirm after is refused", () => {
    const { s, p } = store();
    const c = s.cancel(p.id, "c1", at(10));
    expect(c.ok && c.pending.resolution).toBe("cancelled");
    expect(s.take(p.id, "c1", at(20))).toEqual({ ok: false, reason: "used" });
    expect(pendingView(s.get(p.id)!, at(30))).toEqual({ id: p.id, kind: "confirm", lines: ["Merge 'X' (card t1)"], state: "cancelled", expiresAt: p.expiresAt });
  });

  test("two takes at the same instant: exactly one wins (the UPDATE is the lock)", () => {
    const { s, p } = store();
    const results = [s.take(p.id, "c1", at(5)), s.take(p.id, "c1", at(5))];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("every refusal has a plain sentence", () => {
    expect(Object.keys(REFUSAL_TEXT).sort()).toEqual(["expired", "not-found", "used", "wrong-conversation"]);
  });
});
