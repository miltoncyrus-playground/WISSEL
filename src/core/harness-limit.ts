// When an account stops working for money or sign-in reasons, say whose
// account it is (docs/SDD-identity-and-permissions.md §4.7). During the
// pilot a spend limit on one person's account stopped a whole host, and
// a credit balance was reported in chat because nothing knew whose
// balance it was. This turns each of those into one telemetry event that
// names the harness and its owning principal. The coordinator's event
// inbox (docs/SDD-coordinator.md §4.1) reads it from there once it
// exists.
import type { Harness, TaskResult } from "./types.ts";

export type HarnessLimitKind = "session-limit" | "balance" | "signed-out";

export interface HarnessLimitEvent {
  type: "harness.limit";
  kind: HarnessLimitKind;
  harnessId: string;
  /** Undefined when the harness names no owner. */
  ownerPrincipalId?: string;
  /** Who authorized the card that hit it. */
  principalId: string;
  taskId: string;
  retryAfter?: string;
}

// Matched against a failed run's summary, which carries the CLI's own
// error text. Kept narrow: a false match only adds an event, a missed
// one leaves things as they were before this existed.
const BALANCE = /credit balance is too low|insufficient (?:credit|balance|funds)|billing (?:limit|hard limit) reached/i;
const SIGNED_OUT = /please run \/login|oauth token (?:has )?expired|session (?:has )?expired|invalid api key|authentication_error|not logged in/i;

/** Which account limit a run hit, if any. A rescheduled 429 is a
 *  session limit; otherwise the failure text decides. */
export function harnessLimitOf(result: Pick<TaskResult, "ok" | "summary" | "retryAfter">): HarnessLimitKind | undefined {
  if (result.retryAfter) return "session-limit";
  if (result.ok) return undefined;
  if (BALANCE.test(result.summary)) return "balance";
  if (SIGNED_OUT.test(result.summary)) return "signed-out";
  return undefined;
}

/** The event for a run on `harness`, or undefined when it hit no limit. */
export function harnessLimitEvent(result: TaskResult, harness: Harness | undefined, principalId: string): HarnessLimitEvent | undefined {
  if (!harness) return undefined;
  const kind = harnessLimitOf(result);
  if (!kind) return undefined;
  return {
    type: "harness.limit",
    kind,
    harnessId: harness.id,
    ...(harness.ownerPrincipalId !== undefined ? { ownerPrincipalId: harness.ownerPrincipalId } : {}),
    principalId,
    taskId: result.taskId,
    ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
  };
}

/** The line the server log prints, naming whose account it is. */
export function describeHarnessLimit(e: HarnessLimitEvent): string {
  const whose = e.ownerPrincipalId ? `${e.ownerPrincipalId}'s account ${e.harnessId}` : `account ${e.harnessId} (no owner named)`;
  const what = e.kind === "session-limit" ? `hit a session limit${e.retryAfter ? ` until ${e.retryAfter}` : ""}` : e.kind === "balance" ? "is out of credit" : "is signed out";
  return `${whose} ${what} (card ${e.taskId}, authorized by ${e.principalId})`;
}
