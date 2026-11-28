// When a member is disabled, their cards stop and ask
// (docs/SDD-identity-and-permissions.md §6, §11 question 5; the owner's
// choice, 2026-11-28: "stop and ask").
//
// Disabling revokes their sessions and tokens at once (identity.ts). Here:
// every card they authorized that hasn't started is held (the `held`
// start condition, never met), and one owner task lists those cards and
// the ones still running. A running card finishes, as §8 says; it isn't
// killed mid-write. The owner then re-authorizes each card to keep
// (POST /tasks/:id/reauthorize: it runs on their authority from then on,
// and is released) or drops it.
import type { Board } from "./board.ts";
import { holdCard } from "./plan-hold.ts";
import type { TaskCard } from "../core/types.ts";

export interface LeaverOutcome {
  held: TaskCard[];
  running: TaskCard[];
}

/** Holds every unstarted card `principalId` authorized; lists the running ones. */
export async function stopCardsOf(board: Board, principalId: string, now: Date): Promise<LeaverOutcome> {
  const theirs = (await board.list()).filter((c) => c.authorizedByPrincipalId === principalId && !c.archivedAt && !c.supersededBy);
  const held: TaskCard[] = [];
  for (const c of theirs.filter((x) => (x.status === "inbox" || x.status === "ready") && !x.routedTo && x.pipelineId === undefined)) {
    const r = await holdCard(board, c, now);
    if (r.ok) held.push(r.card);
  }
  return { held, running: theirs.filter((c) => c.status === "running" || c.status === "dispatched") };
}

/** The owner task's text, or undefined when they authorized nothing open. */
export function leaverTask(handle: string, out: LeaverOutcome): { title: string; why: string; steps: string[] } | undefined {
  if (out.held.length === 0 && out.running.length === 0) return undefined;
  const line = (c: TaskCard) => `${c.key ? `${c.key} ` : ""}"${c.title}" (${c.id.slice(0, 8)})`;
  return {
    title: `Cards ${handle} authorized wait for you`,
    why: [
      `${handle} was disabled, so the cards they authorized stop and ask.`,
      out.held.length ? `Held, not started: ${out.held.map(line).join(", ")}.` : "",
      out.running.length ? `Still running, and will finish: ${out.running.map(line).join(", ")}.` : "",
    ].filter(Boolean).join(" "),
    steps: ["Re-authorize each card to keep (Re-authorize on the card), so it runs on your authority", "Drop the others (Discard or Archive)"],
  };
}
