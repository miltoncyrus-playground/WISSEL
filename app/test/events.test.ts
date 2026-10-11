import { describe, expect, test } from "vitest";
import { createEventHub, type EventSourceLike } from "../src/events";
import type { AskEvent, BoardEvent } from "../src/types";

class FakeSource implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  readyState = 0;
  closed = false;
  private named: ((ev: MessageEvent) => unknown)[] = [];
  addEventListener(_type: "ask", listener: (ev: MessageEvent) => unknown) {
    this.named.push(listener);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  /** A named `ask` event, as the server sends Ask's thinking/replied. */
  emitAsk(data: string) {
    for (const l of this.named) l({ data } as MessageEvent);
  }
}

function setup() {
  const opened: FakeSource[] = [];
  const hub = createEventHub(() => {
    const s = new FakeSource();
    opened.push(s);
    return s;
  });
  return { hub, opened };
}

describe("createEventHub", () => {
  test("opens one connection however many subscribe, and fans out to all", () => {
    const { hub, opened } = setup();
    const a: BoardEvent[] = [];
    const b: BoardEvent[] = [];
    hub.subscribe((e) => a.push(e));
    hub.subscribe((e) => b.push(e));
    expect(opened).toHaveLength(1);
    opened[0]!.emit(JSON.stringify({ type: "task.moved" }));
    expect(a.map((e) => e.type)).toEqual(["task.moved"]);
    expect(b.map((e) => e.type)).toEqual(["task.moved"]);
  });

  test("does not connect until someone subscribes", () => {
    const { hub, opened } = setup();
    expect(opened).toHaveLength(0);
    expect(hub.state()).toBe("closed");
  });

  test("closes with the last subscriber and reopens with the next", () => {
    const { hub, opened } = setup();
    const off1 = hub.subscribe(() => {});
    const off2 = hub.subscribe(() => {});
    off1();
    expect(opened[0]!.closed).toBe(false);
    off2();
    expect(opened[0]!.closed).toBe(true);
    expect(hub.state()).toBe("closed");
    hub.subscribe(() => {});
    expect(opened).toHaveLength(2);
  });

  test("ignores malformed messages and the comment-only keepalive", () => {
    const { hub, opened } = setup();
    const got: BoardEvent[] = [];
    hub.subscribe((e) => got.push(e));
    opened[0]!.emit("not json");
    opened[0]!.emit("null");
    opened[0]!.emit(JSON.stringify({ nope: 1 }));
    opened[0]!.emit(JSON.stringify({ type: "task.created" }));
    expect(got.map((e) => e.type)).toEqual(["task.created"]);
  });

  test("reports connection state: connecting, open, reconnecting, closed", () => {
    const { hub, opened } = setup();
    const states: string[] = [];
    hub.onState((s) => states.push(s));
    hub.subscribe(() => {});
    const s = opened[0]!;
    s.readyState = 1;
    s.onopen?.({} as Event);
    s.readyState = 0;
    s.onerror?.({} as Event);
    s.readyState = 2;
    s.onerror?.({} as Event);
    expect(states).toEqual(["connecting", "open", "connecting", "closed"]);
  });

  test("a listener that unsubscribes mid-dispatch does not break the others", () => {
    const { hub, opened } = setup();
    const got: string[] = [];
    const off = hub.subscribe(() => {
      got.push("first");
      off();
    });
    hub.subscribe(() => got.push("second"));
    opened[0]!.emit(JSON.stringify({ type: "x" }));
    expect(got).toEqual(["first", "second"]);
  });

  test("Ask's named events go only to subscribeAsk, board messages only to subscribe, on one connection", () => {
    const { hub, opened } = setup();
    const board: string[] = [];
    const ask: AskEvent[] = [];
    hub.subscribe((e) => board.push(e.type));
    hub.subscribeAsk((e) => ask.push(e));
    expect(opened).toHaveLength(1);
    opened[0]!.emitAsk(JSON.stringify({ type: "ask.thinking", conversationId: "c", messageId: "m" }));
    opened[0]!.emitAsk("not json");
    opened[0]!.emit(JSON.stringify({ type: "task.created" }));
    expect(board).toEqual(["task.created"]);
    expect(ask).toEqual([{ type: "ask.thinking", conversationId: "c", messageId: "m" }]);
  });

  test("an Ask listener alone opens the connection and keeps it until it leaves", () => {
    const { hub, opened } = setup();
    const offAsk = hub.subscribeAsk(() => {});
    expect(opened).toHaveLength(1);
    const off = hub.subscribe(() => {});
    off();
    expect(opened[0]!.closed).toBe(false);
    offAsk();
    expect(opened[0]!.closed).toBe(true);
  });
});
