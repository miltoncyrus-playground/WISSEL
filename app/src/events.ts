// One EventSource('/events') for the whole app (docs/SDD-wissel-app.md
// §3.1). Every screen subscribes here instead of opening its own, so a
// phone holds one connection however many screens are listening. The
// connection opens with the first subscriber and closes with the last;
// EventSource reconnects by itself after a drop.

import type { BoardEvent } from "./types";

export type ConnectionState = "connecting" | "open" | "closed";

/** The parts of EventSource the hub uses, so tests can pass a fake. */
export interface EventSourceLike {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  readonly readyState: number;
  close(): void;
}

export interface EventHub {
  subscribe(listener: (event: BoardEvent) => void): () => void;
  onState(listener: (state: ConnectionState) => void): () => void;
  state(): ConnectionState;
}

/** EventSource.readyState CLOSED: the browser gave up reconnecting. */
const CLOSED = 2;

export function createEventHub(open: () => EventSourceLike): EventHub {
  const listeners = new Set<(event: BoardEvent) => void>();
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
      let event: BoardEvent;
      try {
        event = JSON.parse(String(ev.data)) as BoardEvent;
      } catch {
        return;
      }
      if (!event || typeof event.type !== "string") return;
      for (const l of [...listeners]) l(event);
    };
    source = es;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!source) connect();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && source) {
          source.close();
          source = null;
          setState("closed");
        }
      };
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    state: () => current,
  };
}

/** The app's one hub, on the real `/events`. */
export const events: EventHub = createEventHub(() => new EventSource("/events"));
