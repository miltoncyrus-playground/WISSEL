// Plans that start unless held (docs/SDD-coordinator.md §4.14).
//
// The cards a plan-batch decision proposes are created with a start time
// a few minutes out (WISSEL_PLAN_HOLD_MINUTES, default 10), so the owner
// sees them in the coordinator window before any of them runs. Hold puts
// a `held` start condition on a card, which the sweep never treats as
// met. Release takes it off and clears the start time, so the card
// starts on the next sweep.
import type { Board } from "./board.ts";
import { notBeforeRefusal } from "./board-actions.ts";
import type { TaskCard } from "../core/types.ts";

export const DEFAULT_PLAN_HOLD_MINUTES = 10;

/** Minutes a planned card waits before it starts. 0 starts it at once. */
export function planHoldMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WISSEL_PLAN_HOLD_MINUTES?.trim();
  if (!raw) return DEFAULT_PLAN_HOLD_MINUTES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 24 * 60 ? n : DEFAULT_PLAN_HOLD_MINUTES;
}

/** The start time for a planned card, or undefined to start at once. */
export function planStartsAt(now: Date, minutes: number): string | undefined {
  return minutes > 0 ? new Date(now.getTime() + minutes * 60_000).toISOString() : undefined;
}

export function isHeld(card: Pick<TaskCard, "waitsFor">): boolean {
  return (card.waitsFor ?? []).some((c) => c.kind === "held");
}

export type HoldOutcome = { ok: true; card: TaskCard } | { ok: false; status: 409; error: string };

/** Holds a card that hasn't started yet. Holding a held card is a no-op. */
export async function holdCard(board: Board, card: TaskCard, now: Date): Promise<HoldOutcome> {
  const refused = notBeforeRefusal(card);
  if (refused) return { ok: false, status: 409, error: refused.replace("a start time only applies", "only a card that hasn't started can be held").replace("to give it a start time", "to hold it") };
  if (isHeld(card)) return { ok: true, card };
  return { ok: true, card: await board.updateFields(card.id, { waitsFor: [...(card.waitsFor ?? []), { kind: "held", at: now.toISOString() }] }) };
}

/** Releases a held card: it starts on the next sweep, once its other
 *  conditions hold. */
export async function releaseCard(board: Board, card: TaskCard): Promise<HoldOutcome> {
  if (!isHeld(card)) return { ok: false, status: 409, error: "this card isn't held" };
  const refused = notBeforeRefusal(card);
  if (refused) return { ok: false, status: 409, error: refused };
  await board.updateFields(card.id, { waitsFor: (card.waitsFor ?? []).filter((c) => c.kind !== "held") });
  return { ok: true, card: await board.setNotBefore(card.id, undefined) };
}

export interface PlannedView {
  id: string;
  key?: string;
  title: string;
  /** When it starts by itself; unset when it is held or already due. */
  startsAt?: string;
  held: boolean;
}

/** The workstream's cards that haven't started: what Hold acts on. */
export function plannedCards(cards: TaskCard[], workstreamId: string, now: Date): PlannedView[] {
  return cards
    .filter((c) => c.workstreamId === workstreamId && !c.archivedAt && !c.routedTo && !c.pipelineId && (c.status === "inbox" || c.status === "ready"))
    .map((c) => {
      const held = isHeld(c);
      const due = c.notBefore && Date.parse(c.notBefore) > now.getTime() ? c.notBefore : undefined;
      return { id: c.id, ...(c.key ? { key: c.key } : {}), title: c.title, held, ...(!held && due ? { startsAt: due } : {}) };
    });
}
