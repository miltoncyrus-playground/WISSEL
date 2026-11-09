import type { Database } from "bun:sqlite";
import type { Project, TaskCard } from "../core/types.ts";
import type { Board, BoardEvent } from "./board.ts";
import type { ActionHandlers, CoordinatorExecutor, ExecutableAction } from "./coordinator-executor.ts";
import type { InboxHandler, NewInboxEvent } from "./inbox.ts";
import { ticketKeyOf } from "./ticket-refs.ts";
import type { TicketProvider } from "./ticket-provider.ts";
import { STAGE_ORDER, providerWriter, stageOfTicket, syncTicket, ticketStage, type StageNames, type TicketStage, type TicketWrite } from "./tracker-rules.ts";
import type { Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * Ticket handlers and tracker sync (docs/SDD-coordinator.md §4.3, §4.10).
 *
 * `ticketHandlers` are the executor's `ticket.transition` and
 * `ticket.comment`: they write through the configured TicketProvider
 * only when its config says `writeBack: true`; otherwise they throw a
 * "tracker is read-only" error, so the executor records a failed entry
 * and never a silent success. A transition takes its stage from the
 * cards sharing the ticket key (tracker-rules' ticketStage), so the
 * driver's "done" on pr.merged and the trigger here agree; syncTicket
 * makes the repeat idempotent (an already-moved ticket writes nothing).
 *
 * `createTrackerSync` adds the trigger: on board events the cards'
 * stage is computed and, when the ticket should move, a
 * `ticket.transition` with the source-stable id `tracker:<key>:<stage>`
 * goes to the executor, so the gate, quiet hours, Shadow and the duty
 * switches all apply. A slow poll, run only when a provider exists,
 * reads the tickets Wissel has written; one whose stage differs from
 * what we last wrote or saw was moved by someone else: it becomes a
 * `tracker.moved` inbox event and is not written again until it is
 * back at the stage Wissel set.
 */
export interface TrackerRecord {
  key: string;
  workstreamId: string;
  projectId: string;
  /** The stage Wissel last wrote. */
  written?: TicketStage;
  /** The stage, and the tracker's status name, last seen. */
  observed?: TicketStage;
  status?: string;
  /** Someone else moved the ticket: hands off until it is back at `written`. */
  foreign: boolean;
  at: string;
}

export interface TrackerMemory {
  get(key: string): TrackerRecord | undefined;
  set(key: string, patch: Partial<Omit<TrackerRecord, "key">>): TrackerRecord;
  /** Every ticket Wissel has written. */
  written(): TrackerRecord[];
}

type Row = Omit<TrackerRecord, "written" | "observed" | "status" | "foreign"> & { written: string | null; observed: string | null; status: string | null; movedOutside: number };
const rowToRecord = (r: Row): TrackerRecord => ({
  key: r.key, workstreamId: r.workstreamId, projectId: r.projectId, foreign: r.movedOutside === 1, at: r.at,
  ...(r.written === null ? {} : { written: r.written as TicketStage }), ...(r.observed === null ? {} : { observed: r.observed as TicketStage }), ...(r.status === null ? {} : { status: r.status }),
});

/** Shares the board's connection, like SqliteOutboundQueue. */
export class SqliteTrackerMemory implements TrackerMemory {
  constructor(private db: Database, private now: () => string = () => new Date().toISOString()) {
    this.db.run(`CREATE TABLE IF NOT EXISTS tracker_sync (key TEXT PRIMARY KEY, workstreamId TEXT NOT NULL, projectId TEXT NOT NULL, written TEXT, observed TEXT, status TEXT, movedOutside INTEGER NOT NULL, at TEXT NOT NULL)`);
  }
  get(key: string): TrackerRecord | undefined {
    const row = this.db.query<Row, [string]>(`SELECT * FROM tracker_sync WHERE key = ?`).get(key);
    return row ? rowToRecord(row) : undefined;
  }
  set(key: string, patch: Partial<Omit<TrackerRecord, "key">>): TrackerRecord {
    const r: TrackerRecord = { key, workstreamId: "", projectId: "", foreign: false, ...this.get(key), ...patch, at: this.now() };
    this.db.query(`INSERT OR REPLACE INTO tracker_sync (key, workstreamId, projectId, written, observed, status, movedOutside, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, r.workstreamId, r.projectId, r.written ?? null, r.observed ?? null, r.status ?? null, r.foreign ? 1 : 0, r.at);
    return r;
  }
  written(): TrackerRecord[] {
    return this.db.query<Row, []>(`SELECT * FROM tracker_sync WHERE written IS NOT NULL ORDER BY key`).all().map(rowToRecord);
  }
}

export interface TicketHandlerDeps {
  memory: TrackerMemory;
  /** The configured provider, read per call; undefined when integrations.yaml is missing or unusable. */
  provider: () => TicketProvider | undefined;
  board: Pick<Board, "list">;
  workstreams: Pick<WorkstreamStore, "get" | "list">;
  projects: { list(): Promise<Project[]> };
  names?: StageNames;
}

const str = (v: unknown, name: string): string => (typeof v === "string" && v.trim() !== "" ? v : (() => { throw new Error(`${name} must be a non-empty string`); })());
const isStage = (v: unknown): v is TicketStage => typeof v === "string" && (STAGE_ORDER as readonly string[]).includes(v);
const rank = (s: TicketStage | undefined): number => (s ? STAGE_ORDER.indexOf(s) : -1);

/** The provider when it may write; otherwise the clear error the executor records. */
function writable(provider: TicketProvider | undefined): TicketProvider {
  if (!provider) throw new Error("tracker is read-only: no ticket tracker is set up (integrations.yaml)");
  if (!provider.writeBack) throw new Error(`tracker is read-only: write-back is off for ${provider.id} (set writeBack: true in integrations.yaml)`);
  return provider;
}

interface Index { projects: Project[]; workstreams: Workstream[] }
/** The ticket a card is about: a key in its title or branch, else its workstream's. */
function keyOf(card: TaskCard, idx: Index): string | undefined {
  const project = card.repo ? idx.projects.find((p) => p.path === card.repo) : undefined;
  return ticketKeyOf([card.title, card.pr?.head], project?.ticketPatterns) ?? idx.workstreams.find((w) => w.id === card.workstreamId)?.ticket;
}
/** The card's workstream (its own, else the one whose project owns its repo) and project entry. */
function scopeOf(card: TaskCard, idx: Index): { workstreamId: string; projectId: string } | undefined {
  const owner = card.repo ? idx.projects.find((p) => p.path === card.repo) : undefined;
  const ws = (card.workstreamId ? idx.workstreams.find((w) => w.id === card.workstreamId) : undefined) ?? (owner && idx.workstreams.find((w) => w.projects.some((e) => e.projectId === owner.id)));
  const entry = ws && ((owner && ws.projects.find((e) => e.projectId === owner.id)) ?? ws.projects[0]);
  return ws && entry ? { workstreamId: ws.id, projectId: entry.projectId } : undefined;
}
async function indexOf(deps: Pick<TicketHandlerDeps, "projects" | "workstreams">): Promise<Index> {
  return { projects: await deps.projects.list(), workstreams: await deps.workstreams.list() };
}
/** The live cards sharing `key`. */
const cardsFor = (key: string, cards: TaskCard[], idx: Index): TaskCard[] => cards.filter((c) => !c.archivedAt && keyOf(c, idx) === key);

export function ticketHandlers(deps: TicketHandlerDeps): ActionHandlers {
  return {
    "ticket.comment": async (a) => {
      const provider = writable(deps.provider());
      const key = str(a.payload?.key, "key");
      await providerWriter(provider)({ kind: "ticket.comment", key, text: str(a.payload?.text, "text") });
      return { key, written: true };
    },
    "ticket.transition": async (a) => {
      const provider = writable(deps.provider());
      const key = str(a.payload?.key, "key");
      const known = deps.memory.get(key);
      if (known?.foreign) throw new Error(`${key} was moved to ${known.status ?? "another status"} outside Wissel; it is not overwritten`);
      const cards = cardsFor(key, await deps.board.list(), await indexOf(deps));
      const stage = cards.length === 0 && isStage(a.payload?.to) ? a.payload.to : undefined;
      if (cards.length === 0 && !stage) throw new Error(`no card on the board is about ${key} and "to" names no stage`);
      const result = await syncTicket({ ticket: key, cards, names: deps.names, stage }, provider);
      if (result.failed) throw new Error(result.reason);
      const scope = { workstreamId: a.workstreamId, projectId: a.projectId };
      const moved = result.writes.find((w): w is Extract<TicketWrite, { kind: "ticket.transition" }> => w.kind === "ticket.transition");
      if (result.written) deps.memory.set(key, { ...scope, written: result.to, observed: result.to, status: moved?.to, foreign: false });
      else if (result.from) deps.memory.set(key, { ...scope, observed: result.from, foreign: false });
      return result;
    },
  };
}

export interface TrackerSyncDeps extends TicketHandlerDeps {
  executor: Pick<CoordinatorExecutor, "execute">;
  /** Where a tracker.moved event goes: the inbox dispatcher's ingest. */
  inbox: (event: NewInboxEvent) => Promise<unknown>;
  logger?: (message: string) => void;
}

const TRIGGER_EVENTS: ReadonlySet<BoardEvent["type"]> = new Set(["task.created", "task.moved", "task.updated"]);
export const TRACKER_POLL_MS = 5 * 60_000;

export function createTrackerSync(deps: TrackerSyncDeps) {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const handlers = ticketHandlers(deps);
  /** Stages proposed in this process, so a stage goes to the executor once (Shadow's would-entries, a refused or failed move). */
  const proposed = new Set<string>();

  async function onBoardEvent(evt: BoardEvent): Promise<void> {
    if (!TRIGGER_EVENTS.has(evt.type) || !("task" in evt)) return;
    const idx = await indexOf(deps);
    const key = keyOf(evt.task, idx);
    const scope = key && scopeOf(evt.task, idx);
    if (!key || !scope) return;
    const known = deps.memory.get(key);
    if (known?.foreign) return;
    const to = ticketStage(cardsFor(key, await deps.board.list(), idx));
    if (rank(to) <= Math.max(rank(known?.written), rank(known?.observed), 0)) return;
    const id = `tracker:${key}:${to}`;
    if (proposed.has(id)) return;
    proposed.add(id);
    const outcome = await deps.executor.execute({ id, kind: "ticket.transition", ...scope, payload: { key, to, taskId: evt.task.id } });
    log(`tracker ${key}: move to ${to} ${outcome.outcome}${outcome.outcome === "failed" ? ` (${outcome.error})` : ""}`);
  }

  /** Reads every ticket Wissel has written; one that moved under us is flagged and raised once per status seen. */
  async function poll(): Promise<void> {
    const provider = deps.provider();
    const records = deps.memory.written();
    if (!provider || records.length === 0) return;
    const found = await provider.lookup(records.map((r) => r.key));
    for (const r of records) {
      const ticket = found[r.key];
      if (!ticket) continue;
      const stage = stageOfTicket(ticket, deps.names);
      if (stage === r.written) {
        if (r.foreign || r.observed !== stage) deps.memory.set(r.key, { observed: stage, status: ticket.status, foreign: false });
        continue;
      }
      if (r.foreign && r.status === ticket.status) continue;
      deps.memory.set(r.key, { observed: stage, status: ticket.status, foreign: true });
      await deps.inbox({ id: `tracker:${r.key}:moved:${ticket.status}`, source: "tracker", kind: "tracker.moved", workstreamId: r.workstreamId, payload: { key: r.key, status: ticket.status, stage, wrote: r.written } });
    }
  }

  /** The inbox side of a manual move: a gated status line on the channel; the tracker's text is quoted, never obeyed. */
  const inboxHandlers: Record<string, InboxHandler> = {
    "tracker.moved": async (event) => {
      const p = (typeof event.payload === "object" && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      const key = typeof p.key === "string" ? p.key : undefined;
      const known = key ? deps.memory.get(key) : undefined;
      if (!key || !known) return;
      const text = `${key} was moved to ${String(p.status ?? "?")} outside Wissel (Wissel last set ${known.written ?? "nothing"}); it is left as it is`;
      const action: ExecutableAction = { id: `${event.id}#0`, kind: "channel.post", post: "status", workstreamId: known.workstreamId, projectId: known.projectId, payload: { message: { from: "wissel", about: { ticket: key }, kind: "status", text } } };
      await deps.executor.execute(action);
    },
  };

  const subscribe = (events: { on(name: "event", fn: (evt: BoardEvent) => void): unknown; off(name: "event", fn: (evt: BoardEvent) => void): unknown }): (() => void) => {
    const listener = (evt: BoardEvent): void => void onBoardEvent(evt).catch((e) => log(`tracker sync: ${e instanceof Error ? e.message : String(e)}`));
    events.on("event", listener);
    return () => void events.off("event", listener);
  };

  const startPoll = (intervalMs = TRACKER_POLL_MS): { stop: () => void } => {
    const handle = setInterval(() => void poll().catch((e) => log(`tracker poll: ${e instanceof Error ? e.message : String(e)}`)), intervalMs);
    handle.unref?.();
    return { stop: () => clearInterval(handle) };
  };

  return { handlers, inboxHandlers, memory: deps.memory, onBoardEvent, poll, subscribe, startPoll };
}
