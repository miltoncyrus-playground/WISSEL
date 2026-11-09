import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { TaskCard } from "../core/types.ts";
import { describeAction, type Ask, type SqliteAsks } from "./asks.ts";
import type { Board } from "./board.ts";
import type { About, ChannelEntry, SqliteChannelLog } from "./channel.ts";
import type { ChatMessage, Conversation, PendingView, SqliteConversationStore, WindowExecuted } from "./conversations.ts";
import type { Decision, SqliteDecisionStore } from "./decision-cards.ts";
import type { OutboundEntry } from "./coordinator-executor.ts";
import type { OwnerTask, OwnerTaskStore } from "./owner-tasks.ts";
import { isWindowAction, pendingView, REFUSAL_TEXT, type SqlitePendingActionStore, type WindowAction } from "./pending-actions.ts";
import type { ProjectRole, Workstream, WorkstreamStore } from "./workstreams.ts";

/**
 * The coordinator window's backend (docs/SDD-coordinator.md §4.14): one
 * document per workstream (GET /workstreams/:id/window) and a
 * workstream-scoped conversation on the concierge's stores
 * (conversations.ts, pending-actions.ts). The quick actions are code, no
 * model call. A policy change (pause or resume new cards, restart when
 * idle) is shown as the change and waits as a pending action for the
 * owner's Confirm, through the window's own route; the Ask route refuses
 * it. "Log it on the channel" is on by default: a status entry from the
 * owner goes to the channel log for an answer, and for a change when it
 * happens. No UI here.
 */
export const QUICK_ACTIONS = ["status-now", "waiting-on-me", "pause-new-cards", "resume-new-cards", "restart-when-idle"] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];
const QUICK_TEXT: Record<QuickAction, string> = { "status-now": "Status now", "waiting-on-me": "What is waiting on me", "pause-new-cards": "Pause new cards", "resume-new-cards": "Resume new cards", "restart-when-idle": "Restart when idle" };
const POLICY: Record<"pause-new-cards" | "resume-new-cards" | "restart-when-idle", WindowAction["type"]> = { "pause-new-cards": "window.pause-new-cards", "resume-new-cards": "window.resume-new-cards", "restart-when-idle": "window.restart-when-idle" };
/** Counted as live against the cap, as the digest counts them. */
const LIVE: ReadonlySet<TaskCard["status"]> = new Set(["running", "dispatched"]);

export type WindowItem =
  | { kind: "status"; at: string; from: string; text: string }
  | { kind: "decision"; decision: Decision; flip: boolean }
  | { kind: "owner-task"; task: OwnerTask; hasCheck: boolean }
  | { kind: "ask"; ask: Ask }
  | { kind: "plan"; card: { id: string; key?: string; title: string; status: TaskCard["status"] }; held?: string };

export interface WindowHeader {
  workstream: { id: string; name: string; ticket?: string };
  /** `pendingRole`: a confirmed change waiting for an arm in flight (role-changes.ts, §4.13). */
  roles: { projectId: string; role: ProjectRole; decider?: string; pendingRole?: ProjectRole }[];
  live: { dispatchHold?: string; restartPending: boolean; running: number };
  cards: { live: number; cap: number | null };
  channelLastWrittenAt?: string;
  quietHours?: { start: string; end: string; timezone: string; quiet: boolean };
  outbound: { queued: number; flushAt?: string };
}

export interface WindowDocument {
  header: WindowHeader;
  items: WindowItem[];
  decisions: Decision[];
  log: ChannelEntry[];
  /** Approved, rejected and expired asks, oldest first: the Log tab shows who answered and how. */
  resolvedAsks: Ask[];
  conversation?: { conversation: Conversation; messages: ChatMessage[] };
}

export type WindowMessageInput = { action?: QuickAction; text?: string; log: boolean };
export interface WindowMessageResult { conversation: Conversation; user: ChatMessage; assistant: ChatMessage }
export type ConfirmOutcome = { ok: true; value: { pending: PendingView; message: ChatMessage } } | { ok: false; status: 404 | 409; error: string };

export interface WindowDeps {
  db: Database;
  board: Pick<Board, "list">;
  workstreams: Pick<WorkstreamStore, "get">;
  ownerTasks: Pick<OwnerTaskStore, "list">;
  decisions: Pick<SqliteDecisionStore, "list">;
  channelLog: Pick<SqliteChannelLog, "list" | "adapter">;
  /** Open asks (asks.ts) show as items and count in "what is waiting on me". */
  asks?: Pick<SqliteAsks, "list">;
  conversations: SqliteConversationStore;
  pending: SqlitePendingActionStore;
  /** The executor's quiet-hours view (GET /workstreams/:id/outbound). */
  outbound: (workstreamId: string) => Promise<{ quiet: boolean; flushAt?: string; queued: OutboundEntry[] }>;
  live: () => Promise<{ dispatchHold?: string; restartPending: boolean }>;
  /** Role changes held until an arm settles (role-changes.ts); absent means none can be. */
  pendingRoles?: (workstreamId: string) => { projectId: string; change: { role: ProjectRole } }[];
  holdDispatch: (reason: string) => void;
  releaseDispatch: () => void;
  requestRestart: () => { ok: true } | { ok: false; error: string };
  maxConcurrentTasks?: number;
  now?: () => Date;
  /** Every owner message, once stored: the inbox takes it as an owner.message event (channel-sinks.ts, §4.1). */
  onOwnerMessage?: (ws: Workstream, message: ChatMessage, input: WindowMessageInput) => Promise<unknown> | void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The body of POST /workstreams/:id/window/messages: `action` or `text` (one of them), `log` on unless false. */
export function validateWindowMessage(body: unknown): { ok: true; input: WindowMessageInput } | { ok: false; error: string } {
  if (!isRecord(body)) return { ok: false, error: "body must be an object with action or text" };
  const stray = Object.keys(body).find((k) => !["action", "text", "log"].includes(k));
  if (stray) return { ok: false, error: `unknown field ${stray}` };
  if ((body.action === undefined) === (body.text === undefined)) return { ok: false, error: "give either action or text" };
  if (body.log !== undefined && typeof body.log !== "boolean") return { ok: false, error: "log must be true or false" };
  const log = body.log !== false;
  if (body.action !== undefined) {
    if (typeof body.action !== "string" || !(QUICK_ACTIONS as readonly string[]).includes(body.action)) return { ok: false, error: `action must be one of ${QUICK_ACTIONS.join(", ")}` };
    return { ok: true, input: { action: body.action as QuickAction, log } };
  }
  if (typeof body.text !== "string" || body.text.trim() === "") return { ok: false, error: "text must be a non-empty string" };
  return { ok: true, input: { text: body.text.trim(), log } };
}

/** Free text onto a quick action by its words; undefined when none fits. */
function quickActionOf(text: string): QuickAction | undefined {
  const t = text.toLowerCase();
  if (/restart/.test(t)) return "restart-when-idle";
  if (/resume|unpause/.test(t)) return "resume-new-cards";
  if (/pause/.test(t)) return "pause-new-cards";
  if (/wait/.test(t)) return "waiting-on-me";
  if (/status/.test(t)) return "status-now";
  return undefined;
}

export function createCoordinatorWindow(deps: WindowDeps) {
  const now = deps.now ?? (() => new Date());
  deps.db.run(`CREATE TABLE IF NOT EXISTS window_conversations (workstreamId TEXT PRIMARY KEY, conversationId TEXT NOT NULL)`);
  const conversationIdOf = (wsId: string): string | undefined => deps.db.query<{ conversationId: string }, [string]>(`SELECT conversationId FROM window_conversations WHERE workstreamId = ?`).get(wsId)?.conversationId;
  const about = (ws: Workstream): About => (ws.ticket ? { ticket: ws.ticket } : { card: ws.id });
  const withPending = (m: ChatMessage): ChatMessage => {
    const pending = m.role === "assistant" ? deps.pending.forMessage(m.id).map((p) => pendingView(p, now())) : [];
    return pending.length ? { ...m, pending } : m;
  };

  async function must(wsId: string): Promise<Workstream> {
    const ws = await deps.workstreams.get(wsId);
    if (!ws) throw new Error(`workstream not found: ${wsId}`);
    return ws;
  }

  async function build(ws: Workstream) {
    const [cards, tasks, outbound, live] = await Promise.all([deps.board.list(), deps.ownerTasks.list(), deps.outbound(ws.id), deps.live()]);
    const ours = cards.filter((c) => c.workstreamId === ws.id && !c.archivedAt);
    const ourIds = new Set(ours.map((c) => c.id));
    const open = tasks.filter((t) => t.status === "open" && (t.blocks.length === 0 || t.blocks.some((id) => ourIds.has(id))));
    const log = deps.channelLog.list(ws.id);
    const decisions = deps.decisions.list(ws.id);
    const allAsks = deps.asks?.list(ws.id) ?? [];
    const asks = allAsks.filter((a) => a.status === "open");
    const resolvedAsks = allAsks.filter((a) => a.status !== "open").sort((a, b) => (a.resolvedAt ?? "").localeCompare(b.resolvedAt ?? ""));
    const header: WindowHeader = {
      workstream: { id: ws.id, name: ws.name, ...(ws.ticket ? { ticket: ws.ticket } : {}) },
      roles: ws.projects.map((p) => {
        const held = deps.pendingRoles?.(ws.id).find((r) => r.projectId === p.projectId);
        return { projectId: p.projectId, role: p.role, ...(p.decider ? { decider: p.decider } : {}), ...(held ? { pendingRole: held.change.role } : {}) };
      }),
      live: { ...live, running: cards.filter((c) => c.status === "running").length },
      cards: { live: ours.filter((c) => LIVE.has(c.status)).length, cap: deps.maxConcurrentTasks ?? null },
      ...(log.length ? { channelLastWrittenAt: log[log.length - 1]!.at } : {}),
      ...(ws.quietHours ? { quietHours: { ...ws.quietHours, quiet: outbound.quiet } } : {}),
      outbound: { queued: outbound.queued.length, ...(outbound.flushAt ? { flushAt: outbound.flushAt } : {}) },
    };
    const items: WindowItem[] = [
      ...log.flatMap((e): WindowItem[] => (e.message.kind === "status" ? [{ kind: "status", at: e.at, from: e.message.from, text: e.message.text }] : [])),
      ...decisions.map((decision): WindowItem => ({ kind: "decision", decision, flip: decision.status === "taken" })),
      ...open.map((task): WindowItem => ({ kind: "owner-task", task, hasCheck: Boolean(task.check?.length) })),
      ...asks.map((ask): WindowItem => ({ kind: "ask", ask })),
      ...ours.filter((c) => c.status === "inbox").map((c): WindowItem => {
        const holder = open.find((t) => t.blocks.includes(c.id));
        const held = holder ? `owner task: ${holder.title}` : live.dispatchHold;
        return { kind: "plan", card: { id: c.id, ...(c.key ? { key: c.key } : {}), title: c.title, status: c.status }, ...(held ? { held } : {}) };
      }),
    ];
    return { header, items, decisions, log, open, asks, resolvedAsks };
  }

  const statusText = (ws: Workstream, b: Awaited<ReturnType<typeof build>>): string => {
    const h = b.header;
    const flippable = b.decisions.filter((d) => d.status === "taken").length;
    return [
      `Status now for ${ws.name}:`,
      `Roles: ${h.roles.map((r) => `${r.projectId} ${r.role}${r.decider ? ` (${r.decider})` : ""}${r.pendingRole ? `, ${r.pendingRole} once the arm settles` : ""}`).join(", ") || "no projects"}`,
      `Cards: ${h.cards.live} live${h.cards.cap === null ? ", no cap" : ` of cap ${h.cards.cap}`}; ${h.live.running} running on the board; new cards ${h.live.dispatchHold ? `paused: ${h.live.dispatchHold}` : "start"}${h.live.restartPending ? "; restart pending" : ""}`,
      `Owner tasks: ${b.open.length} open owner task${b.open.length === 1 ? "" : "s"}${b.open.length ? `: ${b.open.map((t) => t.title).join("; ")}` : ""}`,
      `Asks: ${b.asks.length} open`,
      `Decisions: ${b.decisions.length} recorded, ${flippable} can be flipped`,
      `Channel: ${h.channelLastWrittenAt ? `last written ${h.channelLastWrittenAt}` : "never written"}`,
      `Quiet hours: ${h.quietHours ? `${h.quietHours.start} to ${h.quietHours.end} ${h.quietHours.timezone}, ${h.quietHours.quiet ? `on now, ${h.outbound.queued} queued${h.outbound.flushAt ? `, flush at ${h.outbound.flushAt}` : ""}` : "off now"}` : "none"}`,
    ].join("\n");
  };

  const waitingText = (conversationId: string | undefined, b: Awaited<ReturnType<typeof build>>): string => {
    const lines = [
      ...b.open.map((t) => `- Owner task: ${t.title} (${t.why})${t.steps.length ? ` steps: ${t.steps.join("; ")}` : ""}${t.check?.length ? "; Done runs its check" : ""}`),
      ...b.decisions.filter((d) => d.status === "taken").map((d) => `- Decision taken: ${d.text} (flip to: ${d.alternative})`),
      ...b.asks.map((a) => `- Ask: ${describeAction(a.action)} (${a.verdict === "ask-decider" ? "the decider was asked on the channel" : "asked you"}, rule ${a.rule}); approve or reject with POST /workstreams/${a.workstreamId}/asks/${a.id}/approve or /reject`),
      ...(conversationId ? deps.conversations.messages(conversationId).flatMap((m) => deps.pending.forMessage(m.id)).filter((p) => pendingView(p, now()).state === "open").map((p) => `- Waiting for your Confirm: ${p.lines.join("; ")}`) : []),
    ];
    return lines.length ? `Waiting on you:\n${lines.join("\n")}` : "Nothing is waiting on you.";
  };

  /** The change a policy action makes, shown before Confirm, and its Confirm line. */
  const change = (ws: Workstream, type: WindowAction["type"], b: Awaited<ReturnType<typeof build>>): { text: string; line: string } => {
    const hold = b.header.live.dispatchHold;
    switch (type) {
      case "window.pause-new-cards":
        return { text: `Change: new cards stop starting on ${ws.name}; running ones continue. Now: new cards ${hold ? `are already paused (${hold})` : "start"}.`, line: `Pause new cards on ${ws.name}` };
      case "window.resume-new-cards":
        return { text: `Change: new cards start again on ${ws.name}. Now: ${hold ? `paused (${hold})` : "new cards start"}.`, line: `Resume new cards on ${ws.name}` };
      case "window.restart-when-idle":
        return { text: `Change: wissel restarts once the ${b.header.live.running} running card${b.header.live.running === 1 ? "" : "s"} finish; no new card starts until then. Now: ${b.header.live.restartPending ? "a restart is already pending" : "no restart pending"}.`, line: "Restart wissel when idle" };
    }
  };

  /** Runs a confirmed change: the same functions the admin routes call. */
  const run = (ws: Workstream, a: WindowAction): WindowExecuted => {
    const base = { type: a.type, window: true as const, confirmedBy: "confirm" as const };
    if (a.type === "window.pause-new-cards") {
      deps.holdDispatch(`paused from the coordinator window of ${ws.name}`);
      return { ...base, ok: true, text: `Paused new cards on ${ws.name}; running ones continue.` };
    }
    if (a.type === "window.resume-new-cards") {
      deps.releaseDispatch();
      return { ...base, ok: true, text: `New cards start again on ${ws.name}.` };
    }
    const r = deps.requestRestart();
    return r.ok ? { ...base, ok: true, text: "Wissel restarts once the running cards finish." } : { ...base, ok: false, error: r.error, text: `Did not request a restart: ${r.error}.` };
  };

  return {
    async document(wsId: string): Promise<WindowDocument | undefined> {
      const ws = await deps.workstreams.get(wsId);
      if (!ws) return undefined;
      const { header, items, decisions, log, resolvedAsks } = await build(ws);
      const cid = conversationIdOf(ws.id);
      const conversation = cid ? deps.conversations.get(cid) : undefined;
      return { header, items, decisions, log, resolvedAsks, ...(conversation ? { conversation: { conversation, messages: deps.conversations.messages(conversation.id).map(withPending) } } : {}) };
    },

    async message(wsId: string, input: WindowMessageInput): Promise<WindowMessageResult> {
      const ws = await must(wsId);
      const at = now().toISOString();
      let cid = conversationIdOf(ws.id);
      if (!cid || !deps.conversations.get(cid)) {
        cid = deps.conversations.create(`Coordinator window: ${ws.name}`, at).id;
        deps.db.query(`INSERT OR REPLACE INTO window_conversations (workstreamId, conversationId) VALUES (?, ?)`).run(ws.id, cid);
      }
      const action = input.action ?? quickActionOf(input.text!);
      const user = deps.conversations.add({ conversationId: cid, role: "user", text: input.action ? QUICK_TEXT[input.action] : input.text!, actions: [], dropped: [], at });
      await deps.onOwnerMessage?.(ws, user, { ...input, ...(action ? { action } : {}) });
      const b = await build(ws);
      const assistantId = randomUUID();
      let reply: string;
      if (action === "status-now" || action === "waiting-on-me") {
        reply = action === "status-now" ? statusText(ws, b) : waitingText(cid, b);
        if (input.log) await deps.channelLog.adapter(ws.id).post({ kind: "status", from: "owner", about: about(ws), text: `${user.text}: ${reply}` });
      } else if (action) {
        const type = POLICY[action];
        const c = change(ws, type, b);
        deps.pending.create({ conversationId: cid, messageId: assistantId, kind: "confirm", actions: [{ type, tier: "B", workstreamId: ws.id, log: input.log }], lines: [c.line] }, now());
        reply = `${c.text}\n\nWaiting for your Confirm:\n- ${c.line}`;
      } else {
        reply = `I did not understand that. The window takes these quick actions: ${QUICK_ACTIONS.join(", ")}.`;
      }
      const assistant = deps.conversations.add({ id: assistantId, conversationId: cid, role: "assistant", text: reply, actions: [], dropped: [], at: now().toISOString() });
      return { conversation: deps.conversations.get(cid)!, user, assistant: withPending(assistant) };
    },

    /** The window's Confirm or Cancel: the pending action must be this workstream's; a Confirm runs the change and, if asked, logs it. */
    async confirm(wsId: string, pendingId: string, resolution: "confirm" | "cancel"): Promise<ConfirmOutcome> {
      const ws = await must(wsId);
      const cid = conversationIdOf(ws.id);
      const p = deps.pending.get(pendingId);
      if (!p || !cid) return { ok: false, status: 404, error: REFUSAL_TEXT["not-found"] };
      const window = p.actions.filter(isWindowAction);
      if (window.length !== p.actions.length || window.some((a) => a.workstreamId !== ws.id)) return { ok: false, status: 409, error: "that action belongs to another window or chat" };
      const used = resolution === "confirm" ? deps.pending.take(pendingId, cid, now()) : deps.pending.cancel(pendingId, cid, now());
      if (!used.ok) return { ok: false, status: used.reason === "not-found" ? 404 : 409, error: REFUSAL_TEXT[used.reason] };
      let message = deps.conversations.message(p.messageId);
      if (!message) return { ok: false, status: 404, error: `message not found: ${p.messageId}` };
      if (resolution === "confirm") {
        const executed = window.map((a) => run(ws, a));
        for (const [i, e] of executed.entries()) if (e.ok && window[i]!.log) await deps.channelLog.adapter(ws.id).post({ kind: "status", from: "owner", about: about(ws), text: e.text });
        deps.pending.finish(p.id, executed);
        message = deps.conversations.appendActions(p.messageId, executed, now().toISOString());
      }
      return { ok: true, value: { pending: pendingView(deps.pending.get(p.id)!, now()), message: withPending(message) } };
    },
  };
}

export type CoordinatorWindow = ReturnType<typeof createCoordinatorWindow>;
