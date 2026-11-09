import { describe, expect, test } from "vitest";
import { askConfirmLine, describeAsk, pendingRoleText, resolvedAskLine } from "../src/window-asks";
import type { CoordinatorAsk } from "../src/types";

// The window's ask items (docs/SDD-coordinator.md §4.14, §4.2 rules 5 and
// 7): one plain line for what the coordinator wants to do, one for why the
// gate asked, the Confirm line Approve shows first, and the Log line once
// it is resolved.

const base = { id: "a1", workstreamId: "w1", status: "open" as const, askedAt: "2026-11-09T12:00:00.000Z" };
const decision: CoordinatorAsk = {
  ...base, verdict: "ask-owner", rule: "5:must-ask",
  action: { id: "e1#0", kind: "channel.post", workstreamId: "w1", projectId: "p1", post: "decision", decision: "schema", payload: { message: { kind: "decision", about: { card: "A4", pr: "12" }, decision: "schema", text: "one table for orders" } } },
};
const arm: CoordinatorAsk = { ...base, id: "a2", verdict: "ask-decider", rule: "7:default", action: { kind: "pr.arm", workstreamId: "w1", projectId: "p1", base: "main", payload: { taskId: "t-9", pr: 12 } } };

describe("describeAsk", () => {
  test("a decision post names the post, the decision, the card and PR, and the text", () => {
    const d = describeAsk(decision);
    expect(d.what).toBe('post a decision (schema) on the channel about card A4, PR #12: "one table for orders"');
    expect(d.why).toBe("The gate asked you: the decision is on the must-ask list (rule 5:must-ask).");
    expect(d.onChannel).toBe(false);
  });

  test("an arm names the PR and the base; a decider ask says the decider was asked", () => {
    const d = describeAsk(arm);
    expect(d.what).toBe("arm PR #12 to merge into main");
    expect(d.why).toBe("The gate asked the decider on the channel: no rule allows it on its own (rule 7:default).");
    expect(d.onChannel).toBe(true);
  });

  test("an unknown kind still reads as words, and long text is cut", () => {
    const d = describeAsk({ ...arm, action: { kind: "ticket.transition", workstreamId: "w1", projectId: "p1", payload: { key: "SHOP-12", to: "done" } } });
    expect(d.what).toBe("move ticket SHOP-12 to done");
    const long = describeAsk({ ...decision, action: { ...decision.action, payload: { message: { kind: "status", text: "x".repeat(200) } } } });
    expect(long.what.length).toBeLessThan(170);
    expect(long.what).toMatch(/…"$/);
  });

  test("no em dashes in any line", () => {
    for (const ask of [decision, arm]) {
      const d = describeAsk(ask);
      expect(`${d.what}${d.why}${askConfirmLine(ask)}`).not.toContain("—");
    }
  });
});

describe("askConfirmLine", () => {
  test("is the window's Change line, one click before anything runs", () => {
    expect(askConfirmLine(arm)).toBe("Change: wissel will arm PR #12 to merge into main. Confirm.");
  });
});

describe("pendingRoleText", () => {
  test("names the role, and the one a confirmed change becomes once the arm in flight settles", () => {
    expect(pendingRoleText({ role: "follow", pendingRole: "decide" })).toBe("follow, becoming decide after the current arm");
    expect(pendingRoleText({ role: "decide" })).toBe("decide");
  });
});

describe("resolvedAskLine", () => {
  test("says who answered and how", () => {
    expect(resolvedAskLine({ ...arm, status: "approved", resolvedBy: "owner", via: "api", resolvedAt: "2026-11-09T13:00:00.000Z" })).toEqual({ from: "owner", kind: "ask approved", text: "arm PR #12 to merge into main (from the window; it ran once)" });
    expect(resolvedAskLine({ ...decision, status: "rejected", resolvedBy: "Ana", via: "channel" })).toMatchObject({ from: "Ana", kind: "ask rejected", text: expect.stringContaining("(answered on the channel; nothing ran)") });
    expect(resolvedAskLine({ ...decision, status: "expired", resolvedBy: "sweep", via: "sweep" })).toMatchObject({ from: "sweep", kind: "ask expired", text: expect.stringContaining("(after 7 days; nothing ran)") });
    expect(resolvedAskLine({ ...decision, status: "withdrawn", resolvedBy: "role-change", via: "role-change" })).toMatchObject({ from: "role-change", kind: "ask withdrawn", text: expect.stringContaining("(the role changed; nothing ran)") });
  });
});
