/**
 * Tracker rules (docs/SDD-coordinator.md §4.10, tracker half; no chat).
 *
 * The ticket provider (ticket-provider.ts, jira-provider.ts,
 * integrations.yaml) already reads tickets and, with `writeBack: true`,
 * comments and transitions. This adds the coordinator's rules on top: a
 * workstream's ticket exists before its first card, is "in progress" at
 * the first card, "in review" when the last PR is open, and "done" when
 * its acceptance is merged, with one comment per move naming the merged
 * PRs.
 *
 * `ticketStage` and `stageOfTicket` are pure. `syncTicket` reads the
 * ticket, works out the move and hands every write to an injected
 * `TicketWriter`, so the executor can route them through the policy
 * gate as `ticket.transition` / `ticket.comment` actions (§4.3). The
 * ticket only ever moves forward: a ticket someone moved ahead is left
 * alone. With `writeBack: false` nothing is written and the would-be
 * move comes back for the shadow report (§4.13).
 */

import type { TaskCard } from "../core/types.ts";
import type { Ticket, TicketProvider, TicketTransition } from "./ticket-provider.ts";

export type TicketStage = "todo" | "in-progress" | "in-review" | "done";
export const STAGE_ORDER: readonly TicketStage[] = ["todo", "in-progress", "in-review", "done"];

/** The slice of a card the rules read. */
export type TrackerCard = Pick<TaskCard, "id" | "key" | "status" | "pr">;

/** A tracker write, in the shape the executor turns into an action.
 *  `transitionId` is absent when the move could not be resolved against
 *  the tracker (write-back off): a would-be move, not a runnable one. */
export type TicketWrite =
  | { kind: "ticket.transition"; key: string; transitionId?: string; to: string }
  | { kind: "ticket.comment"; key: string; text: string };
export type TicketWriter = (write: TicketWrite) => Promise<void>;

/** Tracker status names for each stage, matched case-insensitively
 *  against the ticket's status and a transition's target. An
 *  integration may add its own names. */
export type StageNames = Partial<Record<TicketStage, string[]>>;
const DEFAULT_NAMES: Record<TicketStage, string[]> = {
  todo: ["To Do", "Open", "Backlog", "New", "Selected for Development"],
  "in-progress": ["In Progress", "In Development", "Doing"],
  "in-review": ["In Review", "Review", "Code Review", "Reviewing", "In Code Review"],
  done: ["Done", "Closed", "Resolved", "Complete", "Completed"],
};
const CATEGORY_STAGE: Record<string, TicketStage> = { new: "todo", indeterminate: "in-progress", done: "done" };

export interface TrackerInput {
  /** The workstream's ticket key; absent means there is nothing to move. */
  ticket?: string;
  cards: readonly TrackerCard[];
  /** Card ids or keys whose merged PRs complete the workstream. Absent
   *  or empty: every card's PR must be merged. */
  acceptance?: readonly string[];
  names?: StageNames;
  /** The target stage when the caller already knows it (a ticket with no
   *  cards on the board); otherwise computed from the cards. */
  stage?: TicketStage;
}

export interface TicketSyncResult {
  ticket?: string;
  /** The stage the tracker shows and the stage the cards call for. */
  from?: TicketStage;
  to: TicketStage;
  /** Every write actually went through. */
  written: boolean;
  /** The writes made, or (not written) the writes that would be made. */
  writes: TicketWrite[];
  /** Why nothing, or not everything, was written. */
  reason?: string;
  /** The move could not be made (unknown ticket, no transition, a write
   *  threw), as opposed to there being nothing to move. */
  failed?: true;
}

const STARTED: ReadonlySet<TaskCard["status"]> = new Set(["running", "dispatched", "review", "done", "failed", "pending-review", "escalated"]);

const prMerged = (c: TrackerCard): boolean => c.pr?.lifecycle === "merged" || c.pr?.watch?.state === "merged";
const hasPr = (c: TrackerCard): boolean => c.pr !== undefined;

/** The stage a workstream's cards call for (§4.10): todo before the
 *  first card starts, in progress from then on, in review once every
 *  card has delivered a PR (the last PR is open), done once the
 *  acceptance cards' PRs are merged. Pure. */
export function ticketStage(cards: readonly TrackerCard[], acceptance?: readonly string[]): TicketStage {
  const started = cards.filter((c) => STARTED.has(c.status));
  if (started.length === 0) return "todo";
  if (!cards.every(hasPr)) return "in-progress";
  const accepted = acceptance && acceptance.length > 0 ? cards.filter((c) => acceptance.includes(c.id) || (c.key !== undefined && acceptance.includes(c.key))) : cards;
  if (accepted.length > 0 && accepted.every(prMerged)) return "done";
  return "in-review";
}

function namesFor(stage: TicketStage, names?: StageNames): string[] {
  return [...(names?.[stage] ?? []), ...DEFAULT_NAMES[stage]];
}

function stageOfName(name: string, names?: StageNames): TicketStage | undefined {
  const lower = name.trim().toLowerCase();
  return STAGE_ORDER.find((stage) => namesFor(stage, names).some((n) => n.toLowerCase() === lower));
}

/** The stage a ticket is at: its status name when recognised, else its
 *  tracker category, else todo. Pure. */
export function stageOfTicket(ticket: Ticket, names?: StageNames): TicketStage {
  return stageOfName(ticket.status, names) ?? CATEGORY_STAGE[ticket.statusCategory ?? ""] ?? "todo";
}

/** The transition that lands on `stage`, preferring the first configured name. */
function transitionTo(stage: TicketStage, transitions: readonly TicketTransition[], names?: StageNames): TicketTransition | undefined {
  for (const name of namesFor(stage, names)) {
    const hit = transitions.find((t) => t.to.trim().toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** The one comment per move: the new status and the PRs merged so far. */
export function moveComment(key: string, to: string, cards: readonly TrackerCard[]): string {
  const merged = cards
    .filter(prMerged)
    .sort((a, b) => a.pr!.number - b.pr!.number)
    .map((c) => `${c.key ?? c.id} #${c.pr!.number} ${c.pr!.url}`);
  return `Wissel moved ${key} to ${to}.\n${merged.length > 0 ? `Merged PRs: ${merged.join(", ")}` : "No PRs merged yet."}`;
}

/** Writes straight to the provider: the default when no gate sits in between. */
export const providerWriter = (provider: TicketProvider): TicketWriter => async (w) => {
  if (w.kind === "ticket.comment") return provider.comment(w.key, w.text);
  if (w.transitionId === undefined) throw new Error(`no transition id for ${w.key} to ${w.to}`);
  return provider.transition(w.key, w.transitionId);
};

/** Reads the ticket, compares its stage with what the cards call for
 *  and, when the cards are ahead, moves it forward through `write`:
 *  the transition first, then the comment. Nothing is written when the
 *  stages agree, the tracker is ahead, no transition reaches the stage,
 *  or write-back is off (the would-be writes come back instead). */
export async function syncTicket(input: TrackerInput, provider: TicketProvider, write: TicketWriter = providerWriter(provider)): Promise<TicketSyncResult> {
  const to = input.stage ?? ticketStage(input.cards, input.acceptance);
  const key = input.ticket;
  if (!key) return { to, written: false, writes: [], reason: "the workstream has no ticket" };
  const ticket = (await provider.lookup([key]))[key];
  if (!ticket) return { ticket: key, to, written: false, writes: [], reason: `the tracker does not know ${key}`, failed: true };
  const from = stageOfTicket(ticket, input.names);
  const base = { ticket: key, from, to };
  const gap = STAGE_ORDER.indexOf(to) - STAGE_ORDER.indexOf(from);
  if (gap === 0) return { ...base, written: false, writes: [], reason: `${key} is already ${ticket.status}` };
  if (gap < 0) return { ...base, written: false, writes: [], reason: `${key} is ahead of the cards (${ticket.status}); it is never moved back` };

  let transition: TicketTransition | undefined;
  if (provider.writeBack) {
    transition = transitionTo(to, await provider.transitions(key), input.names);
    if (!transition) return { ...base, written: false, writes: [], reason: `no transition from ${ticket.status} reaches ${namesFor(to, input.names)[0]}`, failed: true };
  }
  const toName = transition?.to ?? namesFor(to, input.names)[0]!;
  const writes: TicketWrite[] = [
    { kind: "ticket.transition", key, ...(transition ? { transitionId: transition.id } : {}), to: toName },
    { kind: "ticket.comment", key, text: moveComment(key, toName, input.cards) },
  ];
  if (!provider.writeBack) return { ...base, written: false, writes, reason: `write-back is off for ${provider.id}; would move ${key} to ${toName}` };
  for (const w of writes) {
    try {
      await write(w);
    } catch (e) {
      return { ...base, written: false, writes, reason: `${w.kind} on ${key} failed: ${e instanceof Error ? e.message : String(e)}`, failed: true };
    }
  }
  return { ...base, written: true, writes };
}
