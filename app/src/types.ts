// The slices of the server's types the app reads. Mirrors
// src/core/types.ts (TaskCard, PipelineDef) and src/services/board.ts
// (BoardEvent); only the fields the app uses, all optional ones kept
// optional. The repo's test/app-shell.test.ts checks the status list
// matches the board's.

export const TASK_STATUSES = [
  "inbox",
  "ready",
  "running",
  "dispatched",
  "review",
  "done",
  "failed",
  "no-match",
  "pending-review",
  "escalated",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskCard {
  id: string;
  title: string;
  body: string;
  labels: string[];
  repo?: string;
  status: TaskStatus;
  routedTo?: string;
  harness?: string;
  pendingMcpApproval?: { server: string; tool: string };
  pushbackCount?: number;
  supersededBy?: string;
  doneAt?: string;
  archivedAt?: string;
  pipelineId?: string;
  pipelineRunId?: string;
  pipelineStepId?: string;
}

export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  /** Only the step agents: Ask's quick replies find the podcasts by
   *  their `podcast-audio` step. */
  graph?: { steps: { agentId: string }[] };
}

/** GET /feed's items. Mirrors src/services/feed.ts (FeedItem, FeedPage);
 *  test/app-shell.test.ts checks FEED_KINDS matches. */
export const FEED_KINDS = ["landed", "needs-you", "podcast", "checks", "spend"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export type FeedShow = "ai" | "world" | "retro" | "other";

export interface FeedLink {
  label: string;
  href: string;
  method?: "POST";
}

export interface FeedItem {
  id: string;
  kind: FeedKind;
  at: string;
  title: string;
  detail: string;
  links: FeedLink[];
  taskId?: string;
  runId?: string;
  undated?: boolean;
  show?: FeedShow;
  audioUrl?: string;
  durationSeconds?: number;
  pipelineName?: string;
  pass?: boolean;
}

export interface FeedPage {
  items: FeedItem[];
  next: string | null;
}

/** GET /podcasts. Mirrors src/services/podcasts.ts (PodcastEpisode,
 *  PodcastQuickRead); test/app-shell.test.ts checks the field names. */
export interface PodcastQuickRead {
  items: unknown[];
  gatherSources: string[] | null;
  explain: { stories: unknown[] } | null;
}

export interface PodcastEpisode {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  show: FeedShow;
  at: string;
  title: string;
  durationSeconds?: number;
  audioUrl: string;
  quickRead: PodcastQuickRead | null;
}

/** GET /agents, as far as the app reads it (src/core/types.ts AgentDef). */
export interface AgentInfo {
  id: string;
  name: string;
  persona?: { color?: string; glyph?: string };
}

/** GET /wrapped. Mirrors src/services/wrapped.ts (Wrapped) and
 *  src/services/streaks.ts (Streak); test/app-shell.test.ts checks the
 *  field names. */
export interface WrappedStreak {
  current: number;
  best: number;
  today: boolean;
  lastDay: string | null;
  week: boolean[];
}

export interface Wrapped {
  period: { input: string; from: string; to: string; days: number };
  cardsMerged: number;
  commits: number;
  agentRuns: number;
  spendUsd: number;
  topAgent: { id: string; runs: number; spendUsd: number } | null;
  pipelinesAdded: { id: string; name: string }[];
  streak: WrappedStreak;
  lesson: { title: string; text: string; runId: string; date?: string } | null;
}

/** What arrives on `/events`. The app only needs the type to decide to
 *  refetch; the payloads are left loose. */
export interface BoardEvent {
  type: string;
  [key: string]: unknown;
}

/** Ask's chats (docs/SDD-wissel-app.md §3.4). Mirrors
 *  src/services/conversations.ts (Conversation, ChatMessage,
 *  ExecutedAction), src/services/concierge-actions.ts (DroppedAction)
 *  and src/services/concierge.ts (AskEvent, AskResult). */
export type ExecutedAction =
  | { type: "create_task"; ok: true; taskId: string; title: string }
  | { type: "run_pipeline"; ok: true; runId: string; name: string; pipelineId: string }
  | { type: "show_task"; ok: true; taskId: string }
  | { type: "create_task" | "run_pipeline" | "show_task"; ok: false; error: string; title?: string; name?: string };

export interface DroppedAction {
  type: string;
  reason: string;
  disallowed: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  actions: ExecutedAction[];
  dropped: DroppedAction[];
  at: string;
  costUsd?: number;
}

export interface AskResult {
  conversation: Conversation;
  user: ChatMessage;
  assistant: ChatMessage;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

/** The named `ask` event on `/events`. */
export type AskEvent =
  | { type: "ask.thinking"; conversationId: string; messageId: string }
  | { type: "ask.replied"; conversationId: string; messageId: string };
