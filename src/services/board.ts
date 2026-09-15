import type { RoutingDecision, TaskCard, TaskResult } from "../core/types.ts";

/**
 * The board is the single source of truth. Everything else is a client
 * of this, including the frontend. Nothing talks to tmux directly.
 */
export interface Board {
  list(filter?: Partial<Pick<TaskCard, "status" | "repo">>): Promise<TaskCard[]>;
  get(id: string): Promise<TaskCard | undefined>;
  create(card: Omit<TaskCard, "id" | "status">): Promise<TaskCard>;
  move(id: string, status: TaskCard["status"]): Promise<TaskCard>;
  recordDecision(decision: RoutingDecision): Promise<void>;
  recordResult(result: TaskResult): Promise<void>;
  /** Manual override. Every one of these is a labelled router eval case. */
  recordOverride(taskId: string, routerPick: string, humanPick: string): Promise<void>;
}
