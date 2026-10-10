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

/** What arrives on `/events`. The app only needs the type to decide to
 *  refetch; the payloads are left loose. */
export interface BoardEvent {
  type: string;
  [key: string]: unknown;
}
