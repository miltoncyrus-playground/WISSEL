import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { isForward, loadChatConfig, moveComment, slackAdapter, ticketStage, transitionFor, workCards } from "../src/services/tracker-rules.ts";
import type { TicketProvider } from "../src/services/ticket-provider.ts";
import type { TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.10, phase 3 card 18: the ticket follows the
// workstream's cards, through the gate, and writes only with writeBack;
// a Slack adapter posts to the workstream's own chat.

const card = (id: string, over: Partial<TaskCard>): TaskCard => ({ id, title: id, body: "", labels: [], status: "inbox", workstreamId: "ws1", ...over });
const pr = (n: number, lifecycle: "landed" | "ready" | "merged" | "closed") => ({ number: n, url: `https://github.com/o/r/pull/${n}`, head: "a".repeat(40), watch: { lifecycle } as never });

describe("the rules", () => {
  test("no stage before a card starts; in progress; in review once every card is an open PR; done once all merged", () => {
    expect(ticketStage([card("a", {})])).toBeUndefined();
    expect(ticketStage([card("a", { status: "running" }), card("b", {})])).toBe("in progress");
    expect(ticketStage([card("a", { status: "done", pr: pr(1, "landed") }), card("b", { status: "done", pr: pr(2, "ready") })])).toBe("in review");
    expect(ticketStage([card("a", { status: "done", pr: pr(1, "merged") }), card("b", { status: "done", pr: pr(2, "landed") })])).toBe("in review");
    expect(ticketStage([card("a", { status: "done", pr: pr(1, "merged") }), card("b", { status: "done", pr: pr(2, "merged") })])).toBe("done");
    expect(ticketStage([card("a", { status: "done", pr: pr(1, "closed") })])).toBe("in progress");
  });

  test("decision, merge-forward, review and conflict cards, and other workstreams, don't count; the ticket only moves forward", () => {
    const all = [card("a", {}), card("d", { labels: ["decision"] }), card("m", { labels: ["merge-forward"] }), card("r", { labels: ["review"] }), card("x", { workstreamId: "ws2" }), card("old", { supersededBy: "a" })];
    expect(workCards(all, "ws1").map((c) => c.id)).toEqual(["a"]);
    expect(isForward(undefined, "in progress")).toBe(true);
    expect(isForward("in review", "in progress")).toBe(false);
    expect(isForward("in review", "done")).toBe(true);
  });

  test("the move's comment names the merged PRs", () => {
    expect(moveComment("done", [card("a", { pr: pr(1, "merged") })])).toBe('Wissel moved this to "done". Every card\'s PR is merged. Merged: #1 https://github.com/o/r/pull/1.');
  });

  test("transitionFor matches the stage by name or target status, ignoring case and spacing", async () => {
    const provider = { transitions: async () => [{ id: "11", name: "Start progress", to: "In Progress" }, { id: "21", name: "Review", to: "In Review" }] } as unknown as TicketProvider;
    expect(await transitionFor(provider, "ABC-1", "in progress")).toBe("11");
    expect(await transitionFor(provider, "ABC-1", "in review")).toBe("21");
    expect(await transitionFor(provider, "ABC-1", "done")).toBeUndefined();
  });
});

describe("chat", () => {
  test("the token is read from the named variable at each post; channels must be Slack ones; Slack errors surface", async () => {
    const sent: Array<{ url: string; auth: string; body: string }> = [];
    const env: Record<string, string | undefined> = {};
    const fetchFn = async (url: string, init: { headers: Record<string, string>; body: string }) => (sent.push({ url, auth: init.headers.Authorization!, body: init.body }), { ok: true, status: 200, json: async () => (JSON.parse(init.body).channel === "#broken" ? { ok: false, error: "channel_not_found" } : { ok: true, ts: "1.2" }) });
    const slack = slackAdapter({ kind: "slack", tokenEnv: "TEAM_SLACK_BOT" }, env, fetchFn as never);
    await expect(slack.post("slack:#team", "hi")).rejects.toThrow("TEAM_SLACK_BOT is not set");
    env.TEAM_SLACK_BOT = "xoxb-test";
    expect(await slack.post("slack:#team", "hi")).toEqual({ ts: "1.2" });
    expect(sent[0]).toEqual({ url: "https://slack.com/api/chat.postMessage", auth: "Bearer xoxb-test", body: JSON.stringify({ channel: "#team", text: "hi", unfurl_links: false }) });
    await expect(slack.post("https://evil.example", "x")).rejects.toThrow("is not a Slack channel");
    await expect(slack.post("#broken", "x")).rejects.toThrow("slack: channel_not_found");
  });

  test("integrations.yaml chat: takes the variable's name, never a token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wissel-chat-"));
    try {
      writeFileSync(join(dir, "a.yaml"), "chat:\n  kind: slack\n  tokenEnv: TEAM_SLACK_BOT\n");
      expect(await loadChatConfig(join(dir, "a.yaml"))).toEqual({ config: { kind: "slack", tokenEnv: "TEAM_SLACK_BOT" } });
      writeFileSync(join(dir, "b.yaml"), "chat:\n  kind: slack\n  tokenEnv: xoxb-123-abc\n");
      expect((await loadChatConfig(join(dir, "b.yaml"))).reason).toContain("NAME of an environment variable");
      expect((await loadChatConfig(join(dir, "none.yaml"))).config).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("through the gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wissel-tracker-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function setup(writeBack: boolean, ticket: string | null = "SHOP-12") {
    const moves: string[] = [];
    const provider = {
      id: "jira",
      writeBack,
      lookup: async () => ({}),
      transitions: async () => [{ id: "11", name: "In Progress", to: "In Progress" }, { id: "31", name: "Done", to: "Done" }],
      transition: async (key: string, id: string) => void moves.push(`${key} ${id}`),
      comment: async (key: string, text: string) => void moves.push(`${key} comment: ${text.slice(0, 30)}`),
    } as unknown as TicketProvider;
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]), tickets: { provider } });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const repo = join(dir, "shop");
    mkdirSync(repo);
    Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
    const projectId = (await call("POST", "/projects/local", { path: repo })).body.id as string;
    const ws = (await call("POST", "/workstreams", { name: "Checkout", ...(ticket ? { ticket } : {}), projects: [{ projectId, role: "decide" }] })).body.id as string;
    return { board, call, ws, repo, moves, projectId };
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  test("with writeBack on, the first started card moves the ticket to in progress, once, with a comment", async () => {
    const { board, ws, repo, moves } = await setup(true);
    const c = await board.create({ title: "Add retries", body: "", labels: [], repo, workstreamId: ws });
    await board.move(c.id, "running");
    await settle();
    await board.move(c.id, "review");
    await settle();
    expect(moves).toEqual(["SHOP-12 11", 'SHOP-12 comment: Wissel moved this to "in progr']);
  });

  test("with writeBack off, the move is decided and refused by its performer: nothing is written", async () => {
    const { board, call, ws, repo, moves } = await setup(false);
    const c = await board.create({ title: "Add retries", body: "", labels: [], repo, workstreamId: ws });
    await board.move(c.id, "running");
    await settle();
    expect(moves).toEqual([]);
    const log = (await call("GET", `/workstreams/${ws}/gate-log`)).body as unknown as Array<{ action: { kind: string }; verdict: string }>;
    expect(log.map((r) => [r.action.kind, r.verdict])).toEqual([["ticket.transition", "allow"]]);
  });

  test("with a tracker set up, a workstream without a ticket can't start its first card", async () => {
    const { call, ws, projectId } = await setup(true, null);
    const r = await call("POST", `/workstreams/${ws}/actions`, { action: { kind: "card.start", projectId, payload: { card: { title: "x", body: "", labels: [] } } } });
    expect(r.body).toMatchObject({ status: "failed", error: 'workstream "Checkout" needs a ticket before its first card' });
  });
});
