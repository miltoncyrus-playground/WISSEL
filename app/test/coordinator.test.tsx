import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { eventLine, type WindowData } from "../src/coordinator";
import { isEmbedded, parseRoute, routeHash } from "../src/routes";
import { WorkstreamList, WorkstreamWindow, type WindowActions, type WindowTab } from "../src/screens/CoordinatorScreen";

// docs/SDD-coordinator.md §4.14, phase 4 card 22 (and 12b): the window's
// header and tabs, from one workstream's data.

const data: WindowData = {
  ws: {
    id: "ws1",
    name: "Checkout",
    ticket: "SHOP-12",
    projects: [{ projectId: "p1", role: "follow", decider: "Dana", decideAlone: [], mustAsk: [], never: [] }],
    channel: { adapter: "claude-docs", target: "https://claude.ai/artifact/x" },
    quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Madrid" },
  },
  plans: [
    { id: "k1", key: "A5", title: "Add the export", startsAt: "2026-11-28T09:40:00Z", held: false },
    { id: "k2", title: "Split the form", held: true },
  ],
  decisions: [{ id: "d1", text: "Use UTC", alternative: "Local time", by: "wissel", status: "taken", at: "2026-11-28T09:00:00Z" }],
  ownerTasks: [{ id: "o1", title: "Rotate the key", why: "It expires Friday.", steps: ["Rotate it", "Update the secret"], status: "open", check: ["true"] }],
  inbox: [
    { id: "e1", source: "owner", kind: "owner.message", payload: { text: "Pause tonight" }, receivedAt: "2026-11-28T08:15:00Z", untrusted: false },
    { id: "e2", source: "code-host", kind: "pr.ready", payload: { number: 9 }, receivedAt: "2026-11-28T08:20:00Z", untrusted: true },
  ],
  duties: [{ duty: "claims", owner: "external" }],
  channel: [{ id: "c1", message: { kind: "claim", text: "Taking A4" }, status: "posted", queuedAt: "x" }],
  gateLog: [{ id: "g1", action: { kind: "channel.post", message: "claim" }, verdict: "allow", rule: "shadow", mode: "shadow", at: "x" }],
  shadow: true,
};
const noop: WindowActions = { onTab: () => {}, onFlip: () => {}, onDone: () => {}, onSend: () => {}, onRole: () => {}, onDuty: () => {}, onShadow: () => {}, onStatus: () => {}, onRestart: () => {}, onHold: () => {}, onRelease: () => {} };
const render = (tab: WindowTab) => renderToStaticMarkup(<WorkstreamWindow data={data} tab={tab} projectName={() => "shop"} actions={noop} />);

describe("routes", () => {
  test("#/coordinator is the list, #/coordinator/<id> one window; it isn't a tab", () => {
    expect(parseRoute("#/coordinator")).toEqual({ screen: "coordinator", known: true });
    expect(parseRoute("#/coordinator/ws%201")).toEqual({ screen: "coordinator", workstreamId: "ws 1", known: true });
    expect(parseRoute("#/coordinator/a/b")).toEqual({ screen: "coordinator", known: false });
    expect(routeHash({ screen: "coordinator", workstreamId: "ws 1" })).toBe("#/coordinator/ws%201");
  });

  test("?embed=1 is the app inside the board's coordinator dock", () => {
    expect(isEmbedded("?embed=1")).toBe(true);
    expect(isEmbedded("?embed=0")).toBe(false);
    expect(isEmbedded("")).toBe(false);
  });
});

describe("the window", () => {
  test("the header: name, ticket, Shadow, each project's role and decider, channel and quiet hours", () => {
    const html = render("conversation");
    expect(html).toContain("Checkout");
    expect(html).toContain("SHOP-12");
    expect(html).toContain("Shadow: recording only");
    expect(html).toContain("shop: <strong>follow</strong> (decider: Dana)");
    expect(html).toContain("Quiet 22:00 to 07:00 (Europe/Madrid)");
    expect(html.match(/role="tab"/g)).toHaveLength(4);
  });

  test("Conversation: owner tasks with tick-box steps and a Done that runs the check; the inbox in words; a message box", () => {
    const html = render("conversation");
    expect(html).toContain("Rotate the key");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("Done (runs its check)");
    expect(html).toContain("You: Pause tonight");
    expect(html).toContain("PR #9: ready");
    expect(html).toContain("Message the coordinator");
    expect(html).toContain('aria-label="Quick actions"');
    expect(html).toContain("Status now");
    expect(html).toContain("Restart when idle");
  });

  test("planned cards: when each starts, Hold, and Release for a held one", () => {
    const html = render("conversation");
    expect(html).toContain('aria-label="Planned cards"');
    expect(html).toContain("A5: Add the export");
    expect(html).toContain("starts at 09:40");
    expect(html).toContain('aria-label="Hold: Add the export"');
    expect(html).toContain("held");
    expect(html).toContain('aria-label="Release: Split the form"');
  });

  test("the status line shows what Status now returned", () => {
    const html = renderToStaticMarkup(<WorkstreamWindow data={data} tab="conversation" projectName={() => "shop"} actions={noop} status={"Digest for Checkout\nCards: 2 live"} />);
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain("Digest for Checkout");
  });

  test("Decisions has Flip; Log shows the channel and the gate; Settings has roles, duties and Shadow", () => {
    expect(render("decisions")).toContain('aria-label="Flip: Use UTC"');
    const log = render("log");
    expect(log).toContain("claim: Taking A4 · posted");
    expect(log).toContain("channel.post (claim): allow (shadow) · shadow");
    const settings = render("settings");
    expect(settings).toContain('aria-label="Role of shop"');
    expect(settings).toContain("claims: external coordinator");
    expect(settings).toContain("Hand to Wissel");
    expect(settings).toContain("Turn Shadow off");
  });

  test("the list links each workstream's window, and says how to start one when there are none", () => {
    expect(renderToStaticMarkup(<WorkstreamList workstreams={[data.ws]} />)).toContain('href="#/coordinator/ws1"');
    expect(renderToStaticMarkup(<WorkstreamList workstreams={[]} />)).toContain("No workstreams yet");
  });

  test("eventLine reads each kind plainly", () => {
    expect(eventLine({ id: "x", source: "channel", kind: "channel.entry", payload: { author: "Dana", text: "Go" }, receivedAt: "", untrusted: true })).toBe("Dana on the channel: Go");
    expect(eventLine({ id: "x", source: "board", kind: "card.review", payload: { key: "A4" }, receivedAt: "", untrusted: false })).toBe("A4 is review");
    expect(eventLine({ id: "x", source: "code-host", kind: "pr.checks-failing", payload: { number: 3 }, receivedAt: "", untrusted: true })).toBe("PR #3: checks failing");
  });
});
