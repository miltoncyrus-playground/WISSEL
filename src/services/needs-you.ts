import type { NeedsYou, TaskCard, TaskResult } from "../core/types.ts";
import type { Board } from "./board.ts";
import { cardHref } from "./feed.ts";

/**
 * What a card that needs Milton wants, and the one button that resolves
 * it (TaskCard.needsYou). deriveNeedsYou is pure: same card and context,
 * same answer. needsYouFor gathers that context from the Board (worktree
 * presence and fallback reasons off the latest results) for GET /tasks.
 *
 * Precedence, first match wins:
 *   mcp-approval  review + pendingMcpApproval
 *   grant-tools   escalated + suggestedGrants
 *   escalated     escalated
 *   merge-after   review + worktree + a dependency not done yet
 *   merge         review + worktree
 *   blocked-on    inbox/ready + a dependency that is missing or needs Milton itself
 *   review        review (no worktree)
 *   failed
 *   no-match
 */

export interface NeedsYouContext {
  byId: ReadonlyMap<string, TaskCard>;
  hasWorktree(id: string): boolean;
  /** escalated: the reason to show when escalationContext is empty.
   *  failed: the failure text appended to the line. */
  fallbackReason?: { text: string; source: "reviewer" | "implementer" };
}

const LINE_MAX = 160;
/** A dependency in one of these states can't move without Milton. */
const STUCK_STATUSES: ReadonlySet<TaskCard["status"]> = new Set(["failed", "escalated", "no-match", "review"]);

function id8(id: string): string {
  return id.slice(0, 8);
}

function taskPath(id: string, rest: string): string {
  return `/tasks/${encodeURIComponent(id)}/${rest}`;
}

function open(id: string): NeedsYou["action"] {
  return { label: "Open", href: cardHref(id), method: "GET" };
}

/** The last non-empty paragraph of `text` on one line, clipped. */
export function lastParagraph(text: string, max = LINE_MAX): string {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
  const last = paras[paras.length - 1] ?? "";
  return last.length > max ? `${last.slice(0, max - 1)}…` : last;
}

function reasonFor(task: TaskCard, ctx: NeedsYouContext): Pick<NeedsYou, "reason" | "reasonSource"> {
  const own = task.escalationContext?.trim();
  if (own) return { reason: own, reasonSource: "escalation" };
  const fb = ctx.fallbackReason?.text.trim();
  if (fb) return { reason: fb, reasonSource: ctx.fallbackReason!.source };
  return { reason: "No reason recorded", reasonSource: "none" };
}

export function deriveNeedsYou(task: TaskCard, ctx: NeedsYouContext): NeedsYou | undefined {
  if (task.archivedAt || task.supersededBy) return undefined;
  const deps = task.dependsOn ?? [];

  if (task.status === "review" && task.pendingMcpApproval) {
    const { server, tool } = task.pendingMcpApproval;
    return {
      kind: "mcp-approval",
      value: "mcp-approval",
      line: `Wants to call ${server} · ${tool}`,
      action: { label: "Approve", href: taskPath(task.id, "mcp-approval/approve"), method: "POST" },
    };
  }

  if (task.status === "escalated") {
    const rounds = (task.pushbackCount ?? 0) + 1;
    const why = reasonFor(task, ctx);
    const grants = task.suggestedGrants ?? [];
    if (grants.length > 0) {
      return {
        kind: "grant-tools",
        value: "grant-tools",
        line: `Needs ${grants.join(", ")} to continue (round ${rounds})`,
        ...why,
        rounds,
        grants: [...grants],
        action: { label: "Grant and retry", href: taskPath(task.id, "escalation/grant-and-retry"), method: "POST" },
      };
    }
    return {
      kind: "escalated",
      value: "escalated",
      line: `Escalated after ${rounds} ${rounds === 1 ? "round" : "rounds"}: ${lastParagraph(why.reason!)}`,
      ...why,
      rounds,
      action: { label: "Retry", href: taskPath(task.id, "escalation/retry"), method: "POST" },
    };
  }

  if (task.status === "review" && ctx.hasWorktree(task.id)) {
    for (const depId of deps) {
      const dep = ctx.byId.get(depId);
      if (dep?.status === "done") continue;
      const short = id8(depId);
      return {
        kind: "merge-after",
        value: `merge-after:${short}`,
        line: `Merge ${dep?.title || short} first`,
        blocker: { id: depId, id8: short, status: dep?.status ?? "missing" },
        action: ctx.hasWorktree(depId)
          ? { label: `Merge ${short}`, href: taskPath(depId, "merge"), method: "POST" }
          : open(depId),
      };
    }
    return {
      kind: "merge",
      value: "merge",
      line: "Ready to merge",
      action: { label: "Merge", href: taskPath(task.id, "merge"), method: "POST" },
    };
  }

  if (task.status === "inbox" || task.status === "ready") {
    for (const depId of deps) {
      const dep = ctx.byId.get(depId);
      if (dep && !STUCK_STATUSES.has(dep.status)) continue;
      const short = id8(depId);
      const status = dep?.status ?? "missing";
      return {
        kind: "blocked-on",
        value: `blocked-on:${short} ${status}`,
        line: `Waiting on ${dep?.title || short}, which is ${status}`,
        blocker: { id: depId, id8: short, status },
        action: open(depId),
      };
    }
    return undefined;
  }

  if (task.status === "review") {
    return { kind: "review", value: "review", line: "Ready for your review", action: open(task.id) };
  }

  if (task.status === "failed") {
    const fb = ctx.fallbackReason?.text.trim();
    return {
      kind: "failed",
      value: "failed",
      line: fb ? `Failed: ${lastParagraph(fb)}` : "Failed",
      action: { label: "Retry", href: taskPath(task.id, "run"), method: "POST" },
    };
  }

  if (task.status === "no-match") {
    return { kind: "no-match", value: "no-match", line: "No agent matched", action: open(task.id) };
  }

  return undefined;
}

/** Statuses whose latest result needsYouFor reads. */
const RESULT_STATUSES: ReadonlySet<TaskCard["status"]> = new Set(["review", "escalated", "failed"]);

function nonEmpty(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/** The newest reviewer feedback in the card's review lineage (the card
 *  itself included), else the card's own result summary. */
async function escalationFallback(
  board: Pick<Board, "getResult" | "getLineage">,
  task: TaskCard,
  results: ReadonlyMap<string, TaskResult | undefined>,
): Promise<NeedsYouContext["fallbackReason"]> {
  const lineage = await board.getLineage(task.reviewLineageId ?? task.id);
  const ids = lineage.map((c) => c.id).reverse();
  if (!ids.includes(task.id)) ids.unshift(task.id);
  for (const id of ids) {
    const r = results.has(id) ? results.get(id) : await board.getResult(id);
    const feedback = nonEmpty(r?.reviewFeedback);
    if (feedback) return { text: feedback, source: "reviewer" };
  }
  const summary = nonEmpty(results.get(task.id)?.summary);
  return summary ? { text: summary, source: "implementer" } : undefined;
}

/** needsYou for every card in `tasks` that needs Milton, keyed by id.
 *  `tasks` doubles as the dependency lookup, so pass the whole board
 *  when the caller filtered what it returns. */
export async function needsYouFor(
  board: Pick<Board, "getResult" | "getLineage">,
  tasks: TaskCard[],
): Promise<Map<string, NeedsYou>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results = new Map<string, TaskResult | undefined>();
  const wanted = tasks.filter((t) => !t.archivedAt && RESULT_STATUSES.has(t.status));
  await Promise.all(wanted.map(async (t) => results.set(t.id, await board.getResult(t.id))));
  const hasWorktree = (id: string) => results.get(id)?.worktree !== undefined;

  const out = new Map<string, NeedsYou>();
  for (const task of tasks) {
    let fallbackReason: NeedsYouContext["fallbackReason"];
    if (!task.archivedAt && !task.supersededBy) {
      if (task.status === "escalated" && !nonEmpty(task.escalationContext)) {
        fallbackReason = await escalationFallback(board, task, results);
      } else if (task.status === "failed") {
        const summary = nonEmpty(results.get(task.id)?.summary);
        if (summary) fallbackReason = { text: summary, source: "implementer" };
      }
    }
    const ny = deriveNeedsYou(task, { byId, hasWorktree, fallbackReason });
    if (ny) out.set(task.id, ny);
  }
  return out;
}

/** "needs-you: escalated=1 merge=2", kinds sorted; "needs-you: none" when empty. */
export function needsYouLogLine(all: ReadonlyMap<string, NeedsYou>): string {
  const counts = new Map<string, number>();
  for (const ny of all.values()) counts.set(ny.kind, (counts.get(ny.kind) ?? 0) + 1);
  if (counts.size === 0) return "needs-you: none";
  return `needs-you: ${[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}=${n}`).join(" ")}`;
}
