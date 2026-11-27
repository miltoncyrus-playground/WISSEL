// The app's user mode (docs/SDD-board-ui-for-teams.md §4.2, §4.10;
// docs/cards/ui-vocabulary-pass.md card 4). The mode is read once, at
// the app's root (App.tsx), and passed down through UiModeContext.
//
// Both modules come from src/core — one table, one presentation — and
// operator mode, the default, gets back exactly the text it showed
// before: every helper here is the identity in operator mode.
import { createContext, useContext } from "react";
import { label, uiMode, type UiMode } from "../../src/core/user-vocabulary.ts";
import { present, type Failure, type Presentation } from "../../src/core/failure-presentation.ts";
import type { NeedsYou, TaskCard } from "./types";

export type { UiMode };

/** The reviewer-round cap (MAX_PUSHBACKS in src/core/orchestrator.ts). */
const ROUND_CAP = 5;

/** Reads the mode the way the board does (card 1's uiMode): `?mode=` in
 *  the URL (`/app?mode=user#/board`), else the stored `wissel.uiMode`,
 *  else operator. Called once, at the root. */
export function readUiMode(): UiMode {
  if (typeof window === "undefined") return "operator";
  let storage: Pick<Storage, "getItem"> | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return uiMode(window.location.href, storage);
}

export const UiModeContext = createContext<UiMode>("operator");

export function useUiMode(): UiMode {
  return useContext(UiModeContext);
}

/** `label()` with the context's mode, capitalised when asked. */
export function term(name: string, mode: UiMode, capital = false): string {
  const s = label(name, mode);
  return capital ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** User mode's words for a status, so no one has to interpret one. */
const USER_STATUS: Record<TaskCard["status"], string> = {
  inbox: "waiting to start",
  ready: "waiting to start",
  running: "in progress",
  dispatched: "in progress",
  review: "ready for your review",
  "pending-review": label("pending-review", "user"),
  done: "done",
  failed: "stopped",
  "no-match": label("no-match", "user"),
  escalated: label("escalated", "user"),
};

/** A status as a person reads it: the status itself in operator mode. */
export function statusText(status: TaskCard["status"] | "missing", mode: UiMode): string {
  if (mode !== "user") return status;
  if (status === "missing") return "gone";
  return USER_STATUS[status] ?? status;
}

function projectName(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  const parts = repo.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || undefined;
}

/** The failure a card stands for, as present() takes it, or null when it
 *  is not a failure (a review, an approval, a blocked dependency). */
export function failureOf(t: TaskCard): Failure | null {
  const ny: NeedsYou | undefined = t.needsYou;
  // The app's TaskCard carries the refused commands on needsYou only.
  if (ny?.kind === "grant-tools") return { cause: "sandbox-refused", taskId: t.id, commands: ny.grants ?? [] };
  if (t.status === "escalated" || ny?.kind === "escalated") {
    const rounds = ny?.rounds ?? (typeof t.pushbackCount === "number" ? t.pushbackCount + 1 : undefined);
    if (rounds !== undefined && rounds >= ROUND_CAP) return { cause: "review-round-cap", taskId: t.id, rounds };
    return { cause: "escalated", taskId: t.id };
  }
  if (t.status === "no-match") return { cause: "nothing-matched", taskId: t.id, project: projectName(t.repo) };
  if (t.status === "failed") return { cause: "failed", taskId: t.id };
  return null;
}

/** What user mode tells a person about a failed card; null in operator
 *  mode and for a card that is not a failure. */
export function presentationOf(t: TaskCard, mode: UiMode): Presentation | null {
  if (mode !== "user") return null;
  const f = failureOf(t);
  return f ? present(f) : null;
}
