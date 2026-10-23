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
  /** The branch the card is built on and lands on. */
  mergeTarget?: string;
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
  /** "Start at" (docs/SDD-schedules.md §4): ISO UTC; the sweep leaves
   *  the card alone until then. */
  notBefore?: string;
  /** The schedule that made it, when one did. */
  scheduleId?: string;
  /** What the card wants from Milton and its one button. Derived by the
   *  server on GET /tasks; absent from older servers. */
  needsYou?: NeedsYou;
}

/** Mirrors src/core/types.ts NeedsYouKind; test/app-shell.test.ts
 *  checks it matches. */
export type NeedsYouKind = "mcp-approval" | "grant-tools" | "escalated" | "merge-after" | "merge" | "blocked-on" | "review" | "failed" | "no-match";

/** Mirrors src/core/types.ts NeedsYou (src/services/needs-you.ts
 *  derives it). */
export interface NeedsYou {
  kind: NeedsYouKind;
  value: string;
  /** One human line for the Needs you row. */
  line: string;
  /** escalated/grant-tools: the full reason text. */
  reason?: string;
  reasonSource?: "escalation" | "reviewer" | "implementer" | "none";
  /** escalated/grant-tools: reviewer rounds so far. */
  rounds?: number;
  /** grant-tools: the tools it asks for. */
  grants?: string[];
  blocker?: { id: string; id8: string; status: TaskStatus | "missing" };
  action: { label: string; href: string; method: "GET" | "POST" };
}

/** GET /schedules (docs/SDD-schedules.md §3.5). Mirrors
 *  src/services/board-actions.ts's ScheduleView: ScheduleDef plus its
 *  cadence in words and its last run card's status. */
export interface Schedule {
  id: string;
  name: string;
  kind: "pipeline" | "task";
  pipelineId?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** ISO UTC; absent while disabled. */
  nextRunAt?: string;
  lastRunAt?: string;
  lastOutcome?: "started" | "skipped-overlap" | "skipped-stale" | "error";
  lastError?: string;
  lastRunId?: string;
  cadence: string;
  lastRunStatus: TaskStatus | null;
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

/** Ask's chats (docs/SDD-wissel-app.md §3.4, §3.7). Mirrors
 *  src/services/conversations.ts (Conversation, ChatMessage,
 *  ExecutedAction, ControlExecuted, ControlTarget, PendingView),
 *  src/services/concierge-actions.ts (DroppedAction) and
 *  src/services/concierge.ts (AskEvent, AskResult, PendingResult). */
export interface ControlTarget {
  kind: "card" | "harness" | "mcp-server" | "pipeline" | "project" | "schedule";
  id: string;
  label: string;
}

/** A board control Ask ran (or refused) on one target. */
export interface ControlExecuted {
  type: string;
  control: true;
  ok: boolean;
  tier: "A" | "B";
  confirmedBy: "tier-a" | "confirm" | "undo";
  target: ControlTarget;
  text: string;
  error?: string;
  undoId?: string;
}

export type ExecutedAction =
  | { type: "create_task"; ok: true; taskId: string; title: string }
  | { type: "run_pipeline"; ok: true; runId: string; name: string; pipelineId: string }
  | { type: "show_task"; ok: true; taskId: string }
  | { type: "create_task" | "run_pipeline" | "show_task"; ok: false; error: string; title?: string; name?: string }
  | ControlExecuted;

/** A Tier B action or an Undo, waiting for its tap. */
export interface PendingView {
  id: string;
  kind: "confirm" | "undo";
  lines: string[];
  state: "open" | "confirmed" | "cancelled" | "expired";
  expiresAt: string;
}

export interface DroppedAction {
  type: string;
  reason: string;
  disallowed: boolean;
  never?: true;
  question?: string;
  text?: string;
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
  pending?: PendingView[];
}

export interface AskResult {
  conversation: Conversation;
  user: ChatMessage;
  assistant: ChatMessage;
}

/** POST /ask/actions/:id/confirm|cancel. */
export interface PendingResult {
  pending: PendingView;
  message: ChatMessage;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ChatMessage[];
}

/** The named `ask` event on `/events`. */
export type AskEvent =
  | { type: "ask.thinking"; conversationId: string; messageId: string }
  | { type: "ask.replied"; conversationId: string; messageId: string }
  /** A reply ran control actions at once (Tier A, §3.7). */
  | { type: "ask.action"; conversationId: string; messageId: string }
  /** A reply left an action waiting for a Confirm tap. */
  | { type: "ask.pending"; conversationId: string; messageId: string; pendingId: string }
  /** A pending action was confirmed, cancelled, or (kind undo) undone. */
  | { type: "ask.confirmed"; conversationId: string; messageId: string; pendingId: string; resolution: "confirmed" | "cancelled" };

/** GET /projects: the slice the app reads. Mirrors src/core/types.ts
 *  Project. */
export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  /** Regular expression sources that find a ticket key in a title or
   *  branch name. Unset: any `PROJ-123`-shaped key. */
  ticketPatterns?: string[];
}

/** GET /projects/:id/git. Mirrors src/services/project-git.ts. */
export interface ProjectGit {
  status: {
    branch: string;
    detached: boolean;
    dirty: boolean;
    changedFiles: number;
    hasUpstream: boolean;
    ahead?: number;
    behind?: number;
    latestCommit?: { shortSha: string; message: string; date: string; author: string };
  };
  branches: { name: string; local: boolean; remote: boolean; current: boolean; shortSha: string; date: string; subject: string; references: string[] }[];
  worktrees: { path: string; branch?: string; cardId?: string }[];
  tickets: { key: string | null; branches: string[]; worktrees: string[]; cards: { id: string; title: string; status: TaskStatus }[] }[];
  truncated: boolean;
}
