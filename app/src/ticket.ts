// The ticket key in a card title or branch name. Mirrors
// src/services/ticket-refs.ts (the server groups branches with the same
// rule); a project's own patterns (`ticketPatterns`) replace the
// default, a pattern that does not compile is skipped.

import type { ProjectInfo, TaskCard } from "./types";

const DEFAULT_PATTERN = "\\b[A-Z][A-Z0-9]+-\\d+\\b";

export function ticketKey(texts: readonly (string | undefined)[], patterns?: readonly string[]): string | undefined {
  const sources = patterns && patterns.length > 0 ? patterns : [DEFAULT_PATTERN];
  for (const text of texts) {
    if (!text) continue;
    for (const source of sources) {
      try {
        const m = new RegExp(source).exec(text);
        if (m && m[0] !== "") return m[0];
      } catch {
        // A bad pattern finds nothing.
      }
    }
  }
  return undefined;
}

/** The project a card's `repo` names, by path (trailing slash ignored). */
export function projectOf(task: Pick<TaskCard, "repo">, projects: readonly ProjectInfo[]): ProjectInfo | undefined {
  if (!task.repo) return undefined;
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return projects.find((p) => trim(p.path) === trim(task.repo!));
}

/** The card's ticket key under its project's patterns: title first,
 *  then the branch it lands on. */
export function cardTicket(task: Pick<TaskCard, "repo" | "title" | "mergeTarget">, projects: readonly ProjectInfo[]): string | undefined {
  return ticketKey([task.title, task.mergeTarget], projectOf(task, projects)?.ticketPatterns);
}
