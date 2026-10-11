// The Ask screen's logic (docs/SDD-wissel-app.md §3.4), pure: chips for
// what a reply did, their live status off /tasks, quick replies, the cost
// line, and the chat the screen keeps open across reloads. AskScreen.tsx
// only draws what this returns.

import { needsYouReason, type LaneId } from "./lanes";
import { trackOf } from "./podcasts";
import type { Track } from "./player";
import type { AskResult, ChatMessage, PipelineDef, PodcastEpisode, TaskCard, TaskStatus } from "./types";

/** A step agent that makes audio: a pipeline with one is a podcast.
 *  Same name as AUDIO_AGENT in src/services/news-run-checks.ts. */
export const AUDIO_AGENT = "podcast-audio";

/** The longest message the server takes (MAX_MESSAGE_LENGTH in
 *  src/services/concierge.ts). */
export const MAX_MESSAGE_LENGTH = 4000;

export type ChipTone = LaneId | "queued" | "gone";

/** A card or run a reply made or pointed at, as the board has it now. */
export interface Chip {
  key: string;
  taskId: string;
  kind: "card" | "run";
  label: string;
  /** "Running", "Done", "Needs you: Failed"... */
  statusText: string;
  tone: ChipTone;
  /** A podcast run with audio: playable in the mini-player. */
  track?: Track;
}

const STATUS_WORDS: Record<TaskStatus, string> = {
  inbox: "Queued",
  ready: "Queued",
  running: "Running",
  dispatched: "Running",
  review: "Needs you",
  done: "Done",
  failed: "Needs you",
  "no-match": "Needs you",
  "pending-review": "In review",
  escalated: "Needs you",
};

/** The chip's colour, the same reading of a status as the Board tab's
 *  lanes, except that queued and older done cards still get a chip. */
export function toneOf(t: TaskCard): ChipTone {
  if (t.status === "running" || t.status === "dispatched") return "running";
  if (t.status === "done") return "done-today";
  if (t.status === "pending-review") return "review";
  if (t.status === "review" || t.status === "escalated" || t.status === "failed" || t.status === "no-match") return "needs-you";
  return "queued";
}

export function statusTextOf(t: TaskCard): string {
  const word = STATUS_WORDS[t.status] ?? t.status;
  if (word !== "Needs you") return word;
  const why = needsYouReason(t);
  return why === t.status ? word : `${word}: ${why}`;
}

/** The chips for one assistant message: one per action that worked, in
 *  order, each card at most once. A card no longer on the board (deleted
 *  or archived away) shows as "Gone", or "Loading" while `/tasks` has not
 *  answered yet. Failed actions have no chip; the reply text already
 *  says what did not work. */
export function chipsOf(
  message: Pick<ChatMessage, "actions">,
  tasks: readonly TaskCard[],
  episodes: readonly PodcastEpisode[] = [],
  boardLoaded = true,
): Chip[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: Chip[] = [];
  for (const a of message.actions) {
    if (!a.ok) continue;
    const taskId = a.type === "run_pipeline" ? a.runId : a.taskId;
    if (seen.has(taskId)) continue;
    seen.add(taskId);
    const task = byId.get(taskId);
    const fallback = a.type === "create_task" ? a.title : a.type === "run_pipeline" ? a.name : taskId.slice(0, 8);
    const episode = a.type === "run_pipeline" ? episodes.find((e) => e.runId === a.runId) : undefined;
    out.push({
      key: `${a.type}:${taskId}`,
      taskId,
      kind: a.type === "run_pipeline" ? "run" : "card",
      label: a.type === "run_pipeline" ? a.name : task?.title || fallback,
      statusText: task ? statusTextOf(task) : boardLoaded ? "Gone" : "Loading",
      tone: task ? toneOf(task) : boardLoaded ? "gone" : "queued",
      ...(episode ? { track: trackOf(episode) } : {}),
    });
  }
  return out;
}

export type QuickReply = { label: string; text: string } | { label: string; href: string };

/** At most this many "Run <podcast>" replies. */
const PODCAST_REPLIES = 2;

export function isPodcastPipeline(p: PipelineDef): boolean {
  return p.graph?.steps.some((s) => s.agentId === AUDIO_AGENT) ?? false;
}

/** The chips under the composer, from code: run a podcast (by its real
 *  name), two questions Milton asks often, and the board. Show board is
 *  a link, not a message: no model call to open a page. */
export function quickReplies(pipelines: readonly PipelineDef[]): QuickReply[] {
  const podcasts = pipelines.filter(isPodcastPipeline).slice(0, PODCAST_REPLIES);
  return [
    ...podcasts.map((p) => ({ label: `Run ${p.name}`, text: `Run the ${p.name} pipeline` })),
    { label: "What did I do this week?", text: "What did I do this week?" },
    { label: "What is running?", text: "What is running?" },
    { label: "Show board", href: "#/board" },
  ];
}

/** "$0.012" under a reply; "" when the cost is unknown. */
export function costText(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return "";
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** Enter sends; Shift-Enter (or Alt, Ctrl, Cmd) makes a new line, and
 *  Enter while an IME is composing is left to the IME. */
export function isSendKey(e: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing;
}

/** What the composer may send: trimmed, non-empty, within the limit. */
export function sendable(text: string): string | null {
  const t = text.trim();
  return t && t.length <= MAX_MESSAGE_LENGTH ? t : null;
}

/** A message shown before the server has it, so the bubble appears at
 *  once. Its id starts with "pending-". */
export function pendingMessage(text: string, conversationId: string, at: string): ChatMessage {
  return { id: `pending-${at}`, conversationId, role: "user", text, actions: [], dropped: [], at };
}

/** The pending message replaced by the server's pair. Anything already
 *  there with the same id (a refetch got there first) is not repeated. */
export function settle(messages: readonly ChatMessage[], pendingId: string, result: AskResult): ChatMessage[] {
  const incoming = [result.user, result.assistant];
  const ids = new Set(incoming.map((m) => m.id));
  return [...messages.filter((m) => m.id !== pendingId && !ids.has(m.id)), ...incoming];
}

const CONVERSATION_KEY = "wissel.app.askConversation";

/** The chat Ask reopens after a reload, if any. */
export function loadConversationId(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string | null {
  try {
    const v = storage?.getItem(CONVERSATION_KEY);
    return v && /^[\w-]{1,100}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function saveConversationId(id: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = globalThis.localStorage): void {
  try {
    if (id) storage?.setItem(CONVERSATION_KEY, id);
    else storage?.removeItem(CONVERSATION_KEY);
  } catch {
    // Full or blocked: the next reload starts a fresh chat.
  }
}
