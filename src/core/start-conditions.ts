// Start conditions and overlap warnings, docs/SDD-coordinator.md §4.8.
// `TaskCard.waitsFor` holds a card until every condition holds, as
// `dependsOn` does; `pr-merged` and `path-on-main` ask a checker that runs
// `gh`/`git` through a CommandRunner (a fake in tests). `findOverlaps`
// warns when another open card or PR names the same files a card does.

import type { CommandRunner } from "../executors/claude-cli.ts";
import type { StartCondition, TaskCard } from "./types.ts";

export interface StartConditionChecker {
  /** Whether PR `number` of the repository at `repo` (a local path) has merged. */
  prMerged(repo: string, number: number): Promise<boolean>;
  /** Whether `path` exists on the main branch of the repository at `repo`. */
  pathOnMain(repo: string, path: string): Promise<boolean>;
}

export const WAITS_FOR_SHAPE = 'waitsFor must be a list of { kind: "card-done", cardId } | { kind: "pr-merged", repo, number } | { kind: "path-on-main", repo, path }';

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Shape check for `waitsFor` at `POST /tasks`, `PATCH /tasks/:id` and
 *  `POST /tasks/:id/waits-for`. Extra keys are dropped; an empty list is
 *  stored as none. */
export function validateWaitsFor(value: unknown): { ok: true; waitsFor: StartCondition[] | undefined } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, waitsFor: undefined };
  if (!Array.isArray(value)) return { ok: false, error: WAITS_FOR_SHAPE };
  const out: StartCondition[] = [];
  for (const c of value as Record<string, unknown>[]) {
    if (c === null || typeof c !== "object") return { ok: false, error: WAITS_FOR_SHAPE };
    if (c.kind === "card-done" && nonEmpty(c.cardId)) out.push({ kind: "card-done", cardId: c.cardId });
    else if (c.kind === "pr-merged" && nonEmpty(c.repo) && Number.isInteger(c.number) && (c.number as number) >= 1) out.push({ kind: "pr-merged", repo: c.repo, number: c.number as number });
    else if (c.kind === "path-on-main" && nonEmpty(c.repo) && nonEmpty(c.path)) out.push({ kind: "path-on-main", repo: c.repo, path: c.path });
    else return { ok: false, error: WAITS_FOR_SHAPE };
  }
  return { ok: true, waitsFor: out.length > 0 ? out : undefined };
}

/** The first condition that doesn't hold yet, or undefined when all do.
 *  Stops at the first miss so a sweep doesn't spend a `gh` call per
 *  condition on a card that is held anyway. Without a checker, a
 *  `pr-merged` or `path-on-main` condition can't be verified and holds;
 *  a checker that throws holds too, rather than starting the card early. */
export async function firstUnmetStartCondition(
  conditions: StartCondition[],
  deps: { cardDone: (cardId: string) => boolean; checker?: StartConditionChecker },
): Promise<StartCondition | undefined> {
  for (const c of conditions) {
    let holds = false;
    try {
      if (c.kind === "card-done") holds = deps.cardDone(c.cardId);
      else if (deps.checker) holds = c.kind === "pr-merged" ? await deps.checker.prMerged(c.repo, c.number) : await deps.checker.pathOnMain(c.repo, c.path);
    } catch (e) {
      console.warn(`start-conditions: ${c.kind} check failed, holding: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!holds) return c;
  }
  return undefined;
}

/** The production checker: `gh pr view` for the PR state and `git
 *  ls-tree` on `mainRef` for the path, both read-only, both run in the
 *  repository's own directory so `gh` picks the repo from its remote. */
export function createCommandStartConditionChecker(runner: CommandRunner, mainRef = "origin/main"): StartConditionChecker {
  return {
    async prMerged(repo, number) {
      const res = await runner(["gh", "pr", "view", String(number), "--json", "state"], { cwd: repo });
      if (res.exitCode !== 0) return false;
      return (JSON.parse(res.stdout) as { state?: string }).state === "MERGED";
    },
    async pathOnMain(repo, path) {
      const res = await runner(["git", "ls-tree", "--name-only", mainRef, "--", path], { cwd: repo });
      return res.exitCode === 0 && res.stdout.trim() !== "";
    },
  };
}

/** The file paths a card's text names, in order of first mention: a
 *  token with a directory separator, or a bare file name with a short
 *  lowercase extension (README.md). URLs and prose abbreviations such as
 *  "e.g." are left out. */
export function filesNamedIn(text: string): string[] {
  const seen = new Set<string>();
  const stripped = text.replace(/\S+:\/\/\S+/g, " ");
  for (const raw of stripped.match(/[\w./-]+/g) ?? []) {
    const token = raw.replace(/^\.\//, "").replace(/[.-]+$/, "");
    const slashed = token.includes("/") && !token.endsWith("/") && /\w/.test(token);
    const named = !token.includes("/") && /^[\w-]+\.[a-z][a-z0-9]{1,4}$/.test(token);
    if (slashed || named) seen.add(token);
  }
  return [...seen];
}

export interface OverlapWarning {
  file: string;
  taskId: string;
  title: string;
  /** The other card's PR number, when it has one (§3.3). */
  pr?: number;
}

const OPEN_STATUSES = new Set<TaskCard["status"]>(["inbox", "ready", "running", "dispatched", "review", "pending-review", "escalated"]);

/** Every file `task` names that another open card (or the PR it carries)
 *  in the same repo also names. A warning, never a block (§4.8). */
export function findOverlaps(task: TaskCard, others: TaskCard[]): OverlapWarning[] {
  const mine = new Set(filesNamedIn(`${task.title}\n${task.body}`));
  if (mine.size === 0) return [];
  const warnings: OverlapWarning[] = [];
  for (const o of others) {
    if (o.id === task.id || o.archivedAt || o.supersededBy || !OPEN_STATUSES.has(o.status)) continue;
    if (task.repo && o.repo && o.repo !== task.repo) continue;
    for (const file of filesNamedIn(`${o.title}\n${o.body}`)) {
      if (mine.has(file)) warnings.push({ file, taskId: o.id, title: o.title, ...(o.pr ? { pr: o.pr.number } : {}) });
    }
  }
  return warnings;
}
