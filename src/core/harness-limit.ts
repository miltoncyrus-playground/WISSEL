// When an account stops working for money or sign-in reasons, say whose
// account it is (docs/SDD-identity-and-permissions.md §4.7). During the
// pilot a spend limit on one person's account stopped a whole host, and
// a credit balance was reported in chat because nothing knew whose
// balance it was. This turns each of those into one telemetry event that
// names the harness and its owning principal. The coordinator's event
// inbox (docs/SDD-coordinator.md §4.1) reads it from there once it
// exists.
import type { Harness, TaskResult } from "./types.ts";

export type HarnessLimitKind = "session-limit" | "balance" | "signed-out" | "untrusted-workspace";

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
  /** The folder claude refused to trust, for "untrusted-workspace". */
  folder?: string;
}

// Matched against a failed run's summary, which carries the CLI's own
// error text. Kept narrow: a false match only adds an event, a missed
// one leaves things as they were before this existed.
const BALANCE = /credit balance is too low|insufficient (?:credit|balance|funds)|billing (?:limit|hard limit) reached|out of usage credits|credits_required/i;
// claude refuses a folder its account hasn't trusted (2.1.x: "this
// workspace has not been trusted").
const UNTRUSTED = /workspace has not been trusted|accept the trust dialog/i;
const SIGNED_OUT = /please run \/login|oauth token (?:has )?expired|session (?:has )?expired|invalid api key|authentication_error|not logged in/i;

/** Which account limit a run hit, if any. A rescheduled 429 is a
 *  session limit; otherwise the failure text decides. */
export function harnessLimitOf(result: Pick<TaskResult, "ok" | "summary" | "retryAfter">): HarnessLimitKind | undefined {
  if (result.retryAfter) return "session-limit";
  if (result.ok) return undefined;
  if (BALANCE.test(result.summary)) return "balance";
  if (SIGNED_OUT.test(result.summary)) return "signed-out";
  if (UNTRUSTED.test(result.summary)) return "untrusted-workspace";
  return undefined;
}

/** The folder an untrusted-workspace message names. */
export function untrustedFolderOf(summary: string): string | undefined {
  return /projects\["([^"]+)"\]/.exec(summary)?.[1];
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
    ...(kind === "untrusted-workspace" && untrustedFolderOf(result.summary) ? { folder: untrustedFolderOf(result.summary)! } : {}),
  };
}

/** The one owner task an account problem raises (not a session limit,
 *  which retries by itself): what's wrong with whose account, and the
 *  exact steps. `configDir` is the harness's CLAUDE_CONFIG_DIR, if set. */
export function harnessLimitTask(e: HarnessLimitEvent, configDir?: string): { title: string; why: string; steps: string[] } | undefined {
  const env = configDir ? `CLAUDE_CONFIG_DIR=${configDir} ` : "";
  const card = `card ${e.taskId.slice(0, 8)}`;
  if (e.kind === "balance") {
    return {
      title: `Account ${e.harnessId} is out of usage credits`,
      why: `Runs on the ${e.harnessId} account fail before doing anything (first seen on ${card}). Every card on this account will fail the same way until it has credits or runs on a model it can use.`,
      steps: ["Add usage credits at https://claude.ai/settings/usage, or pin the account to a model it can use (Setup > Harnesses > Model)", "Retry the cards that failed"],
    };
  }
  if (e.kind === "signed-out") {
    return {
      title: `Account ${e.harnessId} is signed out`,
      why: `Runs on the ${e.harnessId} account fail because its sign-in expired (first seen on ${card}).`,
      steps: [`Sign in again: ${env}claude, then /login`, "Retry the cards that failed"],
    };
  }
  if (e.kind === "untrusted-workspace") {
    const folder = e.folder ?? "the card's folder";
    return {
      title: `Account ${e.harnessId} doesn't trust ${folder}`,
      why: `claude refuses to run in ${folder} on the ${e.harnessId} account until the folder is trusted (first seen on ${card}).`,
      steps: [`Run: cd ${folder} && ${env}claude, accept the trust dialog, then /exit`, "Retry the cards that failed"],
    };
  }
  return undefined;
}

/** The line the server log prints, naming whose account it is. */
export function describeHarnessLimit(e: HarnessLimitEvent): string {
  const whose = e.ownerPrincipalId ? `${e.ownerPrincipalId}'s account ${e.harnessId}` : `account ${e.harnessId} (no owner named)`;
  const what = e.kind === "session-limit" ? `hit a session limit${e.retryAfter ? ` until ${e.retryAfter}` : ""}` : e.kind === "balance" ? "is out of credit" : e.kind === "untrusted-workspace" ? `doesn't trust ${e.folder ?? "the card's folder"}` : "is signed out";
  return `${whose} ${what} (card ${e.taskId}, authorized by ${e.principalId})`;
}
