/**
 * Where a ticket's details come from. A provider answers "what is
 * ABC-123?" and, when its config allows it, writes back (a comment, a
 * status change). Jira is the first one (src/services/jira-provider.ts);
 * the interface is small on purpose so another tracker can follow.
 *
 * Deterministic code: plain HTTP to the tracker, no LLM. Credentials are
 * read from the environment variables the config names, never from the
 * config itself.
 */

export interface Ticket {
  key: string;
  summary: string;
  /** The tracker's own status name ("In Progress"). */
  status: string;
  /** The tracker's coarse bucket: "new", "indeterminate" or "done". */
  statusCategory?: string;
  assignee?: string;
  url: string;
}

export interface TicketTransition {
  id: string;
  name: string;
  /** The status it moves the ticket to. */
  to: string;
}

export interface TicketProvider {
  readonly id: string;
  /** Whether comment and transition are allowed. Reads never need it. */
  readonly writeBack: boolean;
  /** The tickets found for `keys`; a key the tracker doesn't know, or the
   *  provider isn't allowed to read, is left out. Throws TicketError. */
  lookup(keys: readonly string[]): Promise<Record<string, Ticket>>;
  transitions(key: string): Promise<TicketTransition[]>;
  comment(key: string, text: string): Promise<void>;
  transition(key: string, transitionId: string): Promise<void>;
}

/** A tracker call that failed. The message is safe to show: it never
 *  carries a credential. */
export class TicketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d{1,9}$/;

/** Wraps a provider so repeated lookups inside `ttlMs` don't hit the
 *  tracker again. A write drops that ticket's entry so the next read is
 *  fresh. */
export function withLookupCache(inner: TicketProvider, ttlMs = 60_000, now: () => number = Date.now): TicketProvider {
  const cache = new Map<string, { at: number; ticket: Ticket | null }>();
  return {
    id: inner.id,
    writeBack: inner.writeBack,
    async lookup(keys) {
      const out: Record<string, Ticket> = {};
      const missing: string[] = [];
      for (const key of keys) {
        const hit = cache.get(key);
        if (hit && now() - hit.at < ttlMs) {
          if (hit.ticket) out[key] = hit.ticket;
        } else missing.push(key);
      }
      if (missing.length > 0) {
        const found = await inner.lookup(missing);
        for (const key of missing) {
          const ticket = found[key] ?? null;
          cache.set(key, { at: now(), ticket });
          if (ticket) out[key] = ticket;
        }
      }
      return out;
    },
    transitions: (key) => inner.transitions(key),
    async comment(key, text) {
      await inner.comment(key, text);
      cache.delete(key);
    },
    async transition(key, transitionId) {
      await inner.transition(key, transitionId);
      cache.delete(key);
    },
  };
}
