import type { Database } from "bun:sqlite";
import type { EventEmitter } from "node:events";
import type { AgentDef, Project, TaskCard } from "../core/types.ts";
import type { Board, BoardEvent } from "./board.ts";
import type { CoordinatorExecutor } from "./coordinator-executor.ts";
import {
  DECISION_CARD_KINDS, DECISION_CARD_LABEL, DecisionCards, decisionAgentError, type CardContext, type DecisionCardKind, type OpenDecisionCard, type OpenDecisionCardStore, type SqliteDecisionStore,
} from "./decision-cards.ts";
import type { InboxEvent, InboxHandler } from "./inbox.ts";
import type { NewOwnerTask, OwnerTask } from "./owner-tasks.ts";
import type { ProjectRole, WorkstreamStore } from "./workstreams.ts";

/**
 * Decision cards on the real board (docs/SDD-coordinator.md §4.4). The
 * runtime gives DecisionCards its deps: a card is created on the board,
 * labelled DECISION_CARD_LABEL, with no repo and the project's harness
 * (or `claude`), and only after the route for its labels is an agent
 * decisionAgentError accepts: readonly tier, no bash, write, web or MCP.
 * The board's events close the loop: a decision card reaching done or
 * review has its final text read from its result and parsed, never run;
 * one that failed is an invalid output, so the retry-once-then-owner-task
 * path runs. The open set is a table next to the decisions, reloaded on
 * startup, so a restart orphans no card. Both the inbox dispatcher (an
 * event kind named after a decision kind) and the driver (triage-red,
 * decide-default) open cards here.
 */
export interface DecisionRuntimeDeps {
  db: Database;
  board: Pick<Board, "create" | "get" | "getResult"> & { events: EventEmitter };
  workstreams: Pick<WorkstreamStore, "get">;
  projects: { list(): Promise<Project[]> };
  executor: Pick<CoordinatorExecutor, "execute">;
  ownerTasks: { create(task: NewOwnerTask): Promise<OwnerTask> };
  decisions: SqliteDecisionStore;
  /** The agent the router would pick for the card (undefined: no confident route). */
  routeAgent: (card: Omit<TaskCard, "id" | "status">) => Promise<(Pick<AgentDef, "id" | "tier" | "toolAccess"> & { mcpAccess?: AgentDef["mcpAccess"] }) | undefined>;
  logger?: { warn(message: string): void };
}

export interface DecisionRuntime {
  cards: DecisionCards;
  /** The driver's openDecisionCard: a kind chosen by the handler. */
  open: (kind: DecisionCardKind, event: InboxEvent, ctx: { projectId: string; decision?: string }) => Promise<string>;
  /** The dispatcher's openDecisionCard: the event kind is the decision kind; the project is the workstream's first. */
  openForEvent: InboxHandler;
  openCardIds(): string[];
  /** Resolves once every completion the board has signalled so far has run. */
  idle(): Promise<void>;
  /** Stops listening to the board. */
  stop(): void;
}

type OpenRow = { cardId: string; kind: DecisionCardKind; event: string; ctx: string; attempt: number };

/** The open set, one row per card, sharing the board's connection. */
export class SqliteOpenDecisionCards implements OpenDecisionCardStore {
  constructor(private db: Database) {
    this.db.run(`CREATE TABLE IF NOT EXISTS decision_cards_open (cardId TEXT PRIMARY KEY, kind TEXT NOT NULL, event TEXT NOT NULL, ctx TEXT NOT NULL, attempt INTEGER NOT NULL, openedAt TEXT NOT NULL)`);
  }
  set(cardId: string, open: OpenDecisionCard): void {
    this.db.query(`INSERT OR REPLACE INTO decision_cards_open (cardId, kind, event, ctx, attempt, openedAt) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(cardId, open.kind, JSON.stringify(open.event), JSON.stringify(open.ctx), open.attempt, new Date().toISOString());
  }
  delete(cardId: string): void {
    this.db.query(`DELETE FROM decision_cards_open WHERE cardId = ?`).run(cardId);
  }
  entries(): [string, OpenDecisionCard][] {
    return this.db.query<OpenRow, []>(`SELECT cardId, kind, event, ctx, attempt FROM decision_cards_open ORDER BY rowid ASC`).all()
      .map((r) => [r.cardId, { kind: r.kind, event: JSON.parse(r.event) as InboxEvent, ctx: JSON.parse(r.ctx) as CardContext, attempt: r.attempt }]);
  }
}

const isKind = (k: string): k is DecisionCardKind => (DECISION_CARD_KINDS as readonly string[]).includes(k);
/** The statuses a run ends in; pending-review and escalated never happen to a readonly card without a verdict. */
const FINAL: ReadonlySet<TaskCard["status"]> = new Set(["done", "review", "failed"]);

export function createDecisionRuntime(deps: DecisionRuntimeDeps): DecisionRuntime {
  const log = deps.logger ?? console;

  const roleFor = async (workstreamId: string, projectId: string): Promise<ProjectRole> =>
    (await deps.workstreams.get(workstreamId))?.projects.find((p) => p.projectId === projectId)?.role ?? "follow";

  /** Refuses the card unless its route passes decisionAgentError; then creates it with the project's harness. */
  const startCard = async (card: Omit<TaskCard, "id" | "status">, ctx: CardContext): Promise<{ id: string }> => {
    const agent = await deps.routeAgent(card);
    if (!agent) throw new Error(`no agent routes decision card "${card.title}" (labels ${card.labels.join(", ")})`);
    const error = decisionAgentError(agent);
    if (error) throw new Error(`decision card "${card.title}" would route to ${agent.id}: ${error}`);
    const project = (await deps.projects.list()).find((p) => p.id === ctx.projectId);
    const { repo: _repo, ...rest } = card; // never a repo: the card reads its body, nothing else
    return deps.board.create({ ...rest, harnessOverride: project?.harness ?? "claude" });
  };

  const cards = new DecisionCards({
    startCard, openCards: new SqliteOpenDecisionCards(deps.db), executor: deps.executor, ownerTasks: deps.ownerTasks, decisions: deps.decisions, roleFor, logger: log,
    cardFor: (id) => deps.board.get(id),
    projectFor: async (id) => (await deps.projects.list()).find((p) => p.id === id),
  });

  // Completions run one after another, in board order, and `idle` awaits the chain.
  let chain: Promise<void> = Promise.resolve();
  const onFinal = async (task: TaskCard): Promise<void> => {
    // A failed run left no answer: an empty text fails every schema, so the retry/owner-task path runs.
    const text = task.status === "failed" ? "" : ((await deps.board.getResult(task.id))?.summary ?? "");
    const r = await cards.complete(task.id, text);
    if (r.outcome === "retried") log.warn(`decision card ${task.id} re-opened as ${r.cardId}: ${r.error}`);
    if (r.outcome === "owner-task") log.warn(`decision card ${task.id} raised owner task ${r.task.id}: ${r.error}`);
  };
  const listener = (evt: BoardEvent): void => {
    if (evt.type !== "task.moved" || !FINAL.has(evt.task.status) || !evt.task.labels.includes(DECISION_CARD_LABEL) || !cards.openIds().includes(evt.task.id)) return;
    chain = chain.then(() => onFinal(evt.task)).catch((e: unknown) => log.warn(`decision card ${evt.task.id}: completion failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  deps.board.events.on("event", listener);

  return {
    cards,
    open: (kind, event, ctx) => cards.open(kind, event, ctx),
    openForEvent: async (event) => {
      if (!isKind(event.kind)) throw new Error(`inbox event ${event.id}: ${event.kind} is not a decision card kind`);
      const projectId = event.workstreamId ? (await deps.workstreams.get(event.workstreamId))?.projects[0]?.projectId : undefined;
      if (!projectId) throw new Error(`inbox event ${event.id}: no workstream project to open a ${event.kind} card for`);
      await cards.open(event.kind, event, { projectId });
    },
    openCardIds: () => cards.openIds(),
    idle: () => chain,
    stop: () => void deps.board.events.off("event", listener),
  };
}
