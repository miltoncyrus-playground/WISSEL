// One EventSource('/events') for the whole app (docs/SDD-wissel-app.md
// §3.1). Every screen subscribes here instead of opening its own, so a
// phone holds one connection however many screens are listening. The
// connection opens with the first subscriber and closes with the last;
// EventSource reconnects by itself after a drop.
//
// Board events are plain messages. Ask's "thinking" and "replied"
// (§3.4) come as a named `ask` event on the same connection, which only
// subscribeAsk listeners get: no board refetch fires for them.

import type { AskEvent, BoardEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

/** The parts of EventSource the hub uses, so tests can pass a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  readonly readyState: number;
  addEventListener(type: "ask", listener: (ev: MessageEvent) => unknown): void;
  close(): void;
}

export interface EventHub {
  subscribe(listener: (event: BoardEvent) => void): () => void;
  /** Ask's named events. Holds the connection open like subscribe. */
  subscribeAsk(listener: (event: AskEvent) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  state(): ConnectionState;
}

/** EventSource.readyState CLOSED: the browser gave up reconnecting. */
const CLOSED = 2;

/** An event's JSON, or null for anything malformed or without a type. */
function parseEvent<T extends { type: string }>(data: unknown): T | null {
  try {
    const event = JSON.parse(String(data)) as T | null;
    return event && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}

export function createEventHub(open: () => EventSourceLike): EventHub {
  const listeners = new Set<(event: BoardEvent) => void>();
  const askListeners = new Set<(event: AskEvent) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();
  let source: EventSourceLike | null = null;
  let current: ConnectionState = "closed";

  const setState = (next: ConnectionState) => {
    if (next === current) return;
    current = next;
    for (const l of stateListeners) l(next);
  };

  const connect = () => {
    setState("connecting");
    const es = open();
    es.onopen = () => setState("open");
    es.onerror = () => setState(es.readyState === CLOSED ? "closed" : "connecting");
    es.onmessage = (ev) => {
      const event = parseEvent<BoardEvent>(ev.data);
      if (event) for (const l of [...listeners]) l(event);
    };
    es.addEventListener("ask", (ev) => {
      const event = parseEvent<AskEvent>(ev.data);
      if (event) for (const l of [...askListeners]) l(event);
    });
    source = es;
  };

  /** Adds a listener; the returned function removes it and closes the
   *  connection when no listener of either kind is left. */
  function add<T>(set: Set<T>, listener: T): () => void {
    set.add(listener);
    if (!source) connect();
    return () => {
      set.delete(listener);
      if (listeners.size + askListeners.size === 0 && source) {
        source.close();
        source = null;
        setState("closed");
      }
    };
  }

  return {
    subscribe: (listener) => add(listeners, listener),
    subscribeAsk: (listener) => add(askListeners, listener),
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    state: () => current,
  };
}

/** The app's one hub, on the real `/events`. */
export const events: EventHub = createEventHub(() => new EventSource("/events"));
