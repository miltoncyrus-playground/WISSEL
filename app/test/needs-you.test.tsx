import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { postAction } from "../src/api";
import { TaskRow } from "../src/components/TaskRow";
import { laneOf, needsYouReason, needsYouView, startOfLocalDay } from "../src/lanes";
import type { NeedsYou, TaskCard } from "../src/types";

// The Needs you row reads the server's TaskCard.needsYou (src/services/
// needs-you.ts): one line, the reason for escalated and grant-tools, the
// blocker for blocked-on and merge-after, and one button. Fixtures are
// shaped like deriveNeedsYou's output.

const ID = "1a2b3c4d-0000-4000-8000-000000000001";
const DEP = "9f8e7d6c-0000-4000-8000-000000000002";

function card(over: Partial<TaskCard> = {}): TaskCard {
  return { id: ID, title: "Fix the thing", body: "", labels: [], status: "review", ...over };
}

const escalated: NeedsYou = {
  kind: "escalated",
  value: "escalated",
  line: "Escalated after 3 rounds: tests still fail on the merge path",
  reason: "Round 1: missing tests.\n\nRound 3: tests still fail on the merge path",
  reasonSource: "escalation",
  rounds: 3,
  action: { label: "Retry", href: `/tasks/${ID}/escalation/retry`, method: "POST" },
};

const grantTools: NeedsYou = {
  kind: "grant-tools",
  value: "grant-tools",
  line: "Needs Bash(git:*), WebFetch to continue (round 2)",
  reason: "It needs git to rebase.",
  reasonSource: "escalation",
  rounds: 2,
  grants: ["Bash(git:*)", "WebFetch"],
  action: { label: "Grant and retry", href: `/tasks/${ID}/escalation/grant-and-retry`, method: "POST" },
};

const merge: NeedsYou = {
  kind: "merge",
  value: "merge",
  line: "Ready to merge",
  action: { label: "Merge", href: `/tasks/${ID}/merge`, method: "POST" },
};

const mcp: NeedsYou = {
  kind: "mcp-approval",
  value: "mcp-approval",
  line: "Wants to call slack · post_message",
  action: { label: "Approve", href: `/tasks/${ID}/mcp-approval/approve`, method: "POST" },
};

const blockedOn: NeedsYou = {
  kind: "blocked-on",
  value: "blocked-on:9f8e7d6c escalated",
  line: "Waiting on Schema change, which is escalated",
  blocker: { id: DEP, id8: "9f8e7d6c", status: "escalated" },
  action: { label: "Open", href: `/app#/board/${DEP}`, method: "GET" },
};

const mergeAfter: NeedsYou = {
  kind: "merge-after",
  value: "merge-after:9f8e7d6c",
  line: "Merge Schema change first",
  blocker: { id: DEP, id8: "9f8e7d6c", status: "review" },
  action: { label: "Merge 9f8e7d6c", href: `/tasks/${DEP}/merge`, method: "POST" },
};

const render = (t: TaskCard) => renderToStaticMarkup(<TaskRow task={t} lane="needs-you" />);

describe("needsYouReason", () => {
  test("prefers the server's needsYou.line", () => {
    expect(needsYouReason(card({ status: "escalated", needsYou: escalated }))).toBe(escalated.line);
    expect(needsYouReason(card({ status: "review", pendingMcpApproval: { server: "slack", tool: "post_message" }, needsYou: mcp }))).toBe(mcp.line);
  });

  test("falls back to the status words without it (older server)", () => {
    expect(needsYouReason(card({ status: "escalated" }))).toBe("Reviewer escalated it");
    expect(needsYouReason(card({ status: "review", pendingMcpApproval: { server: "slack", tool: "post" } }))).toBe("Approve slack · post");
  });
});

describe("laneOf with needsYou", () => {
  test("an inbox card the server marks blocked-on needs you; one without needsYou stays queued", () => {
    const start = startOfLocalDay(Date.now());
    expect(laneOf(card({ status: "inbox", needsYou: blockedOn }), start)).toBe("needs-you");
    expect(laneOf(card({ status: "inbox" }), start)).toBeNull();
    expect(laneOf(card({ status: "inbox", needsYou: blockedOn, archivedAt: "2026-10-01T00:00:00Z" }), start)).toBeNull();
  });
});

describe("needsYouView", () => {
  test("escalated: line, full reason, Retry posting to the escalation retry endpoint", () => {
    const v = needsYouView(card({ status: "escalated", needsYou: escalated }));
    expect(v.line).toBe(escalated.line);
    expect(v.reason).toBe(escalated.reason);
    expect(v.action).toEqual({ label: "Retry", href: `/tasks/${ID}/escalation/retry`, method: "POST" });
    expect(v.round).toBeUndefined();
    expect(v.blocker).toBeUndefined();
  });

  test("grant-tools: reason, round N and the grants", () => {
    const v = needsYouView(card({ status: "escalated", needsYou: grantTools }));
    expect(v.reason).toBe("It needs git to rebase.");
    expect(v.round).toBe("round 2");
    expect(v.grants).toEqual(["Bash(git:*)", "WebFetch"]);
    expect(v.action?.label).toBe("Grant and retry");
  });

  test("reasonSource none shows the text as-is", () => {
    const v = needsYouView(card({ status: "escalated", needsYou: { ...escalated, reason: "No reason recorded", reasonSource: "none" } }));
    expect(v.reason).toBe("No reason recorded");
    expect(v.reasonLong).toBe(false);
  });

  test("a long or many-line reason gets the toggle; a short one does not", () => {
    expect(needsYouView(card({ status: "escalated", needsYou: escalated })).reasonLong).toBe(false);
    expect(needsYouView(card({ status: "escalated", needsYou: { ...escalated, reason: "x".repeat(201) } })).reasonLong).toBe(true);
    expect(needsYouView(card({ status: "escalated", needsYou: { ...escalated, reason: "a\nb\nc\nd" } })).reasonLong).toBe(true);
  });

  test("merge and mcp-approval: their one POST button, no reason", () => {
    const m = needsYouView(card({ needsYou: merge }));
    expect(m.action).toEqual({ label: "Merge", href: `/tasks/${ID}/merge`, method: "POST" });
    expect(m.reason).toBeUndefined();
    const a = needsYouView(card({ pendingMcpApproval: { server: "slack", tool: "post_message" }, needsYou: mcp }));
    expect(a.action).toEqual({ label: "Approve", href: `/tasks/${ID}/mcp-approval/approve`, method: "POST" });
  });

  test("blocked-on and merge-after: the blocker's id8 and status", () => {
    expect(needsYouView(card({ status: "inbox", needsYou: blockedOn })).blocker).toBe("9f8e7d6c · escalated");
    expect(needsYouView(card({ needsYou: mergeAfter })).blocker).toBe("9f8e7d6c · review");
  });

  test("a reason on another kind is not shown", () => {
    expect(needsYouView(card({ needsYou: { ...merge, reason: "stray" } })).reason).toBeUndefined();
  });

  test("no needsYou: the fallback line and nothing else", () => {
    expect(needsYouView(card({ status: "escalated" }))).toEqual({ line: "Reviewer escalated it", reasonLong: false });
  });
});

describe("TaskRow in Needs you", () => {
  test("escalated shows the reason text and a Retry button outside the link", () => {
    const html = render(card({ status: "escalated", needsYou: escalated }));
    expect(html).toContain(escalated.line);
    expect(html).toContain("Round 1: missing tests.");
    expect(html).toMatch(/<\/a><div class="task-needs">[\s\S]*<button[^>]*>Retry<\/button>/);
    // The button is never inside the anchor.
    expect(html.slice(html.indexOf("<a"), html.indexOf("</a>"))).not.toContain("<button");
  });

  test("merge shows Merge; mcp-approval shows Approve", () => {
    expect(render(card({ needsYou: merge }))).toMatch(/<button[^>]*>Merge<\/button>/);
    expect(render(card({ pendingMcpApproval: { server: "slack", tool: "post_message" }, needsYou: mcp }))).toMatch(/<button[^>]*>Approve<\/button>/);
  });

  test("grant-tools lists the grants and the round", () => {
    const html = render(card({ status: "escalated", needsYou: grantTools }));
    expect(html).toContain("Bash(git:*), WebFetch");
    expect(html).toContain("round 2");
    expect(html).toMatch(/<button[^>]*>Grant and retry<\/button>/);
  });

  test("blocked-on shows the blocker and its GET action as a link", () => {
    const html = render(card({ status: "inbox", needsYou: blockedOn }));
    expect(html).toContain("Blocked by 9f8e7d6c · escalated");
    expect(html).toMatch(new RegExp(`<a class="btn btn-small" href="/app#/board/${DEP}"[^>]*>Open</a>`));
    expect(html).not.toContain("<button");
  });

  test("a long reason is clipped behind Show more", () => {
    const html = render(card({ status: "escalated", needsYou: { ...escalated, reason: "y".repeat(300) } }));
    expect(html).toContain("task-reason is-clipped");
    expect(html).toContain("Show more");
  });

  test("no needsYou renders as before: one link with the status words", () => {
    const html = render(card({ status: "escalated" }));
    expect(html).toBe(
      `<li class="task-item"><a class="task-row lane-needs-you" href="#/board/${ID}"><span class="task-dot" aria-hidden="true"></span><span class="task-text"><span class="task-title">Fix the thing</span><span class="task-sub">Reviewer escalated it</span></span></a></li>`,
    );
  });

  test("other lanes ignore needsYou", () => {
    const html = renderToStaticMarkup(<TaskRow task={card({ status: "running", needsYou: merge })} lane="running" />);
    expect(html).not.toContain("task-needs");
    expect(html).not.toContain(merge.line);
  });
});

describe("postAction", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs the href and throws the server's error on a 409", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "merge conflict in src/x.ts" }), { status: 409 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(postAction(`/tasks/${ID}/merge`)).rejects.toThrow("merge conflict in src/x.ts");
    expect(fetchMock).toHaveBeenCalledWith(`/tasks/${ID}/merge`, { method: "POST" });
  });
});
