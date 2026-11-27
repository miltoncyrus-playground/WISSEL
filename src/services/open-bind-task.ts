// The owner task an open bind raises (docs/SDD-identity-and-permissions.md
// §4.1). It goes straight to `review` — a human's queue — so the router
// never picks it up, and it is raised before the orchestrator exists, so
// there is no tick between `create` (which always lands in `inbox`) and
// the move.
import { OPEN_BIND_TASK_TITLE, openBindTaskBody } from "../core/bind.ts";
import type { Board } from "./board.ts";
import type { TaskCard } from "../core/types.ts";

/** Creates the owner task unless an unfinished one is already on the
 *  board. Returns the task that now stands for the open bind. */
export async function raiseOpenBindTask(board: Board, hostname: string, port: number): Promise<{ task: TaskCard; created: boolean }> {
  const open = (await board.list()).find((t) => t.title === OPEN_BIND_TASK_TITLE && t.status !== "done" && !t.archivedAt);
  if (open) return { task: open, created: false };
  const created = await board.create({ title: OPEN_BIND_TASK_TITLE, body: openBindTaskBody(hostname, port), labels: ["owner", "security"] });
  return { task: await board.move(created.id, "review"), created: true };
}
