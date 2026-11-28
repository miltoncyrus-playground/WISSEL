import { describe, expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { boardInboxEvent, InboxDispatcher, InboxStore, prInboxEvents, type InboxEvent } from "../src/services/inbox.ts";
import type { TaskCard } from "../src/core/types.ts";

// docs/SDD-coordinator.md §4.1, phase 3 card 13: one persisted queue,
// source-stable ids so nothing is handled twice, the server's own
// timestamps, and a dispatcher by kind.

const at = (iso: string) => () => new Date(iso);

describe("the store", () => {
  test("an id is added once; the time is the server's; channel, tracker and code-host payloads are marked untrusted", () => {
    const store = new InboxStore(new SqliteBoard().db, at("2026-11-27T12:00:00Z"));
    expect(store.add({ id: "channel:entry-1", source: "channel", kind: "channel.decision", payload: { text: "go", receivedAt: "1999-01-01" } })).toBe(true);
    expect(store.add({ id: "channel:entry-1", source: "channel", kind: "channel.decision", payload: { text: "changed" } })).toBe(false);
    const e = store.get("channel:entry-1")!;
    expect(e).toMatchObject({ receivedAt: "2026-11-27T12:00:00.000Z", payload: { text: "go" }, untrusted: true, attempts: 0 });
    store.add({ id: "owner:1", source: "owner", kind: "owner.message", workstreamId: "ws1", payload: {} });
    expect(store.get("owner:1")!.untrusted).toBe(false);
    expect(store.list({ workstreamId: "ws1" }).map((x) => x.id)).toEqual(["owner:1"]);
    expect(store.list({ unhandled: true })).toHaveLength(2);
  });
});

describe("the dispatcher", () => {
  test("oldest first, by kind or prefix; no handler is unrouted; a throw is retried once, then failed", async () => {
    let n = 0;
    const store = new InboxStore(new SqliteBoard().db, () => new Date(Date.UTC(2026, 10, 27, 12, 0, n++)));
    const seen: string[] = [];
    let flaky = 0;
    const d = new InboxDispatcher(
      store,
      {
        "card.review": async (e) => void seen.push(`review ${e.id}`),
        "pr.*": async (e) => void seen.push(`pr ${e.id}`),
        "card.failed": async () => {
          if (flaky++ === 0) throw new Error("first try fails");
        },
        "card.escalated": async () => {
          throw new Error("always fails");
        },
      },
      () => {},
    );
    store.add({ id: "a", source: "board", kind: "card.review", payload: {} });
    store.add({ id: "b", source: "code-host", kind: "pr.merged", payload: {} });
    store.add({ id: "c", source: "owner", kind: "owner.message", payload: {} });
    store.add({ id: "d", source: "board", kind: "card.failed", payload: {} });
    store.add({ id: "e", source: "board", kind: "card.escalated", payload: {} });
    await d.drain();
    expect(seen).toEqual(["review a", "pr b"]);
    const out = (id: string) => {
      const x = store.get(id)! as InboxEvent;
      return [x.outcome, x.handler, x.attempts, x.error ?? null];
    };
    expect(out("c")).toEqual(["unrouted", "none", 1, null]);
    expect(out("d")).toEqual(["handled", "card.failed", 2, null]);
    expect(out("e")).toEqual(["failed", "card.escalated", 2, "always fails"]);
    expect(store.list({ unhandled: true })).toEqual([]);
    expect(d.push({ id: "a", source: "board", kind: "card.review", payload: {} })).toBe(false);
  });
});

describe("sources", () => {
  const card = (over: Partial<TaskCard>): TaskCard => ({ id: "t1", title: "Add retries", body: "", labels: [], status: "review", key: "A4", workstreamId: "ws1", round: 2, ...over });

  test("a board move to running, review, failed or escalated is an event, stable per card, status and round; anything else isn't", () => {
    expect(boardInboxEvent({ type: "task.moved", task: card({}) })).toEqual({ id: "board:t1:review:2", source: "board", kind: "card.review", workstreamId: "ws1", payload: { taskId: "t1", title: "Add retries", key: "A4", status: "review" } });
    expect(boardInboxEvent({ type: "task.moved", task: card({ status: "escalated" }) })!.id).toBe("board:t1:escalated:2");
    expect(boardInboxEvent({ type: "task.moved", task: card({ status: "running" }) })!.kind).toBe("card.running");
    expect(boardInboxEvent({ type: "task.moved", task: card({ status: "done" }) })).toBeUndefined();
    expect(boardInboxEvent({ type: "task.created", task: card({}) })).toBeUndefined();
  });

  test("a PR change is one event per thing that happened, keyed on the head", () => {
    const base = { type: "pr.changed" as const, taskId: "t1", number: 9, changes: ["x"], headSha: "abc" };
    expect(prInboxEvents({ ...base, lifecycle: "landed", mergeable: "dirty", checks: "failing" }, "ws1").map((e) => [e.id, e.kind, e.workstreamId])).toEqual([
      ["pr:t1:9:abc:checks:failing", "pr.checks-failing", "ws1"],
      ["pr:t1:9:abc:dirty", "pr.dirty", "ws1"],
    ]);
    expect(prInboxEvents({ ...base, lifecycle: "ready", mergeable: "clean", checks: "passing" }).map((e) => e.kind)).toEqual(["pr.checks-passing", "pr.ready"]);
    expect(prInboxEvents({ ...base, lifecycle: "landed", mergeable: "clean", checks: "pending" })).toEqual([]);
  });
});

describe("in the app", () => {
  test("a card reaching review lands in the inbox once; the owner can post a message; GET filters by workstream", async () => {
    const board = new SqliteBoard();
    const app = createApp(board, Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app(new Request(`http://x${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }));
      return { status: r.status, body: (await r.json()) as unknown };
    };
    const t = await board.create({ title: "Add retries", body: "", labels: [], repo: "/r" });
    await board.move(t.id, "review");
    await board.move(t.id, "running");
    await board.move(t.id, "review");
    await new Promise((r) => setTimeout(r, 10));
    const events = (await call("GET", "/inbox")).body as InboxEvent[];
    expect(events.map((e) => [e.kind, e.outcome]).sort()).toEqual([
      ["card.review", "unrouted"],
      ["card.running", "handled"],
    ]);
    const msg = await call("POST", "/inbox", { text: "Pause new cards tonight." });
    expect(msg).toMatchObject({ status: 201, body: { source: "owner", kind: "owner.message", payload: { text: "Pause new cards tonight." } } });
    expect((await call("POST", "/inbox", { text: " " })).status).toBe(400);
    expect((await call("POST", "/inbox", { text: "x", workstreamId: "nope" })).status).toBe(400);
    await new Promise((r) => setTimeout(r, 10));
    expect(((await call("GET", "/inbox?unhandled=1")).body as unknown[]).length).toBe(0);
  });
});
