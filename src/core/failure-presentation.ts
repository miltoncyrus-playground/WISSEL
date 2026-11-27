// One function from a failure to what a person is told
// (docs/SDD-board-ui-for-teams.md §4.10 — that table is the spec).
//
// The mechanisms behind each failure already exist; this is only the
// presentation. Nothing here changes when a failure happens, retries, or
// moves a card. Every sentence states what happened and what comes next,
// carries the specifics the caller has, and never asks the reader to
// interpret a status name: each one passes `findInternalVocabulary`.
//
// Pure and dependency-free (bar the vocabulary module), so the board's
// scripts and the app can both load it.

import { findInternalVocabulary } from "./user-vocabulary.ts";

export const FailureCause = {
  MergeGateFailed: "merge-gate-failed",
  NoHarnessFree: "no-harness-free",
  SessionLimit: "session-limit",
  SandboxRefused: "sandbox-refused",
  MergeConflict: "merge-conflict",
  ReviewRoundCap: "review-round-cap",
  NothingMatched: "nothing-matched",
  Unknown: "unknown",
} as const;
export type FailureCause = (typeof FailureCause)[keyof typeof FailureCause];

/** What the caller knows about a failure. Every field past `taskId` is
 *  optional: a sentence uses what it is given and stays true without it. */
export type Failure =
  | { cause: "merge-gate-failed"; taskId: string; command?: string; lastLines?: string }
  | { cause: "no-harness-free"; taskId: string; account?: string; signedOut?: boolean }
  | { cause: "session-limit"; taskId?: string; resetsAt?: string; account?: string; limit?: "session" | "spend" }
  | { cause: "sandbox-refused"; taskId: string; commands?: string[] }
  | { cause: "merge-conflict"; taskId: string; target?: string; files?: string[] }
  | { cause: "review-round-cap"; taskId: string; rounds?: number }
  | { cause: "nothing-matched"; taskId: string; project?: string }
  | { cause: string; taskId?: string; message?: string };

export interface FailureAction {
  label: string;
  href: string;
  method: "GET" | "POST";
}

export interface Presentation {
  cause: FailureCause;
  /** One plain sentence: what happened, then the next step. */
  sentence: string;
  /** The endpoint and label that answers it, where one exists. */
  action?: FailureAction;
}

export interface PresentOptions {
  /** IANA zone for reset times; the runtime's own zone when unset. */
  timeZone?: string;
}

/** How many trailing lines of command output a sentence quotes. */
export const LAST_LINES = 5;

function taskPath(id: string, rest: string): string {
  return `/tasks/${encodeURIComponent(id)}/${rest}`;
}

function openWork(id: string): FailureAction {
  return { label: "Open", href: `/app#/board/${encodeURIComponent(id)}`, method: "GET" };
}

function lastLines(text: string | undefined, n = LAST_LINES): string | undefined {
  const lines = (text ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  return lines.length ? lines.slice(-n).join("\n") : undefined;
}

function code(s: string): string {
  return "`" + s.replace(/`/g, "'") + "`";
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function hhmm(iso: string | undefined, timeZone?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(d);
}

function has<K extends string>(f: Failure, cause: K): f is Extract<Failure, { cause: K }> {
  return f.cause === cause;
}

/** What a person is told about `failure`. Never throws: a cause it does
 *  not know gets a sentence and no action. */
export function present(failure: Failure, opts: PresentOptions = {}): Presentation {
  try {
    return presentKnown(failure, opts) ?? presentUnknown(failure);
  } catch {
    return presentUnknown(failure);
  }
}

function presentKnown(f: Failure, opts: PresentOptions): Presentation | undefined {
  if (has(f, FailureCause.MergeGateFailed)) {
    const what = f.command ? `${code(f.command)} failed` : "The project's checks failed";
    const tail = lastLines(f.lastLines);
    return {
      cause: FailureCause.MergeGateFailed,
      sentence: `${what}, so nothing was merged; send it back and a fresh attempt gets the output.${tail ? `\n${tail}` : ""}`,
      action: { label: "Send it back for a fix", href: taskPath(f.taskId, "escalation/retry"), method: "POST" },
    };
  }

  if (has(f, FailureCause.NoHarnessFree)) {
    const who = f.account ? `The account ${f.account}` : "The account";
    const state = f.signedOut === true ? "is signed out" : f.signedOut === false ? "is busy" : "is busy or signed out";
    return {
      cause: FailureCause.NoHarnessFree,
      sentence: `${who} ${state}, so this has not started; it starts when the account is free, or use another account now.`,
      // POST /tasks/:id/harness takes `{ harness }`: the screen asks which
      // account before it sends.
      action: { label: "Use another account", href: taskPath(f.taskId, "harness"), method: "POST" },
    };
  }

  if (has(f, FailureCause.SessionLimit)) {
    const at = hhmm(f.resetsAt, opts.timeZone);
    const which = f.limit === "spend" ? "spend limit" : "usage limit";
    const whose = f.account ? `${f.account}'s ${which}` : `The account's ${which}`;
    return {
      cause: FailureCause.SessionLimit,
      sentence: at
        ? `${whose} is reached; it resumes on its own at ${at}, or raise the limit to continue sooner.`
        : `${whose} is reached; it resumes on its own when the limit resets, or raise the limit to continue sooner.`,
    };
  }

  if (has(f, FailureCause.SandboxRefused)) {
    const cmds = (f.commands ?? []).filter((c) => c.trim().length > 0);
    return {
      cause: FailureCause.SandboxRefused,
      sentence: cmds.length
        ? `It needs to run ${list(cmds.map(code))}, which it was not allowed; allow it and it starts again.`
        : "It needed to run a command it was not allowed; allow it and it starts again.",
      ...(cmds.length ? { action: { label: "Allow and retry", href: taskPath(f.taskId, "escalation/grant-and-retry"), method: "POST" as const } } : {}),
    };
  }

  if (has(f, FailureCause.MergeConflict)) {
    const target = f.target ? code(f.target) : "The branch it lands on";
    const files = (f.files ?? []).filter((x) => x.trim().length > 0);
    return {
      cause: FailureCause.MergeConflict,
      sentence: `${target} moved and nothing was merged; ${files.length ? `the conflict is in ${list(files.map(code))}` : "the changes conflict"}, and it needs resolving before it can land.`,
      action: { label: "Resolve it", href: openWork(f.taskId).href, method: "GET" },
    };
  }

  if (has(f, FailureCause.ReviewRoundCap)) {
    const rounds = f.rounds && f.rounds > 0 ? `${f.rounds} review rounds` : "Several review rounds";
    return {
      cause: FailureCause.ReviewRoundCap,
      sentence: `After ${rounds.charAt(0).toLowerCase()}${rounds.slice(1)} the reviewer and the author still disagree, so it has stopped; a person should look.`,
      action: openWork(f.taskId),
    };
  }

  if (has(f, FailureCause.NothingMatched)) {
    const where = f.project ? `in ${f.project}` : "here";
    return {
      cause: FailureCause.NothingMatched,
      sentence: `Nothing ${where} can do this, so it has not started; add an agent that can, or pick another project.`,
      action: openWork(f.taskId),
    };
  }

  return undefined;
}

function presentUnknown(f: Failure): Presentation {
  const raw = "message" in f && typeof f.message === "string" ? f.message.trim().replace(/\s+/g, " ") : "";
  // Only quote the caller's message if it says nothing in machine terms.
  const usable = raw && findInternalVocabulary(raw).length === 0 ? raw : "";
  return {
    cause: FailureCause.Unknown,
    sentence: usable
      ? `It stopped: ${usable.replace(/[.\s]+$/, "")}. Open it to see the agent's output.`
      : "It stopped for a reason Wissel could not name; open it to see the agent's output.",
  };
}
