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

/** What arrives on `/events`. The app only needs the type to decide to
 *  refetch; the payloads are left loose. */
export interface BoardEvent {
  type: string;
  [key: string]: unknown;
}
