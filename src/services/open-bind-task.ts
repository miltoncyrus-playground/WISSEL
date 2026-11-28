// The owner task an open bind raises (docs/SDD-identity-and-permissions.md
// §4.1). A real owner task (owner-tasks.ts): Needs a human shows why it
// matters and how to close it, with Done and Dismiss. Before this it was
// a plain card moved to `review`, which Needs you read as "a result
// nobody has checked". Raised before the orchestrator exists, as before.
import { OPEN_BIND_TASK_TITLE } from "../core/bind.ts";
import type { Board } from "./board.ts";
import type { OwnerTask, OwnerTaskStore } from "./owner-tasks.ts";

export function openBindTask(hostname: string, port: number): { title: string; why: string; steps: string[] } {
  return {
    title: OPEN_BIND_TASK_TITLE,
    why: `Wissel started with WISSEL_BIND=${hostname} and WISSEL_ALLOW_OPEN_BIND=1, so the board on port ${port} answers on more than this machine, with no sign-in: anyone who can reach it can create cards, run agents and merge their work.`,
    steps: [
      "Turn sign-in on: add Environment=WISSEL_AUTH=tokens to the service, restart, and open the one-time sign-in link it prints (docs/guide/sign-in-and-permissions.md)",
      "Or close it: remove WISSEL_BIND and WISSEL_ALLOW_OPEN_BIND from the service, then restart",
      "If it's open on purpose, Dismiss this: it comes back on the next start while the board is open",
    ],
  };
}

/** Raises the owner task unless one is open. Closes any old-style card
 *  with the same title (a plain card in review) that it replaces. */
export async function raiseOpenBindTask(store: OwnerTaskStore, board: Board, hostname: string, port: number): Promise<{ task: OwnerTask; created: boolean }> {
  const open = store.list("open").find((t) => t.title === OPEN_BIND_TASK_TITLE);
  const ownerCards = new Set(store.list().map((t) => t.cardId));
  for (const old of (await board.list()).filter((t) => t.title === OPEN_BIND_TASK_TITLE && t.status === "review" && !t.archivedAt && !ownerCards.has(t.id))) {
    await board.move(old.id, "done");
  }
  if (open) return { task: open, created: false };
  const r = await store.create({ ...openBindTask(hostname, port), blocks: [] });
  if (!r.ok) throw new Error(`open bind: owner task not raised: ${r.error}`);
  return { task: r.task, created: true };
}
