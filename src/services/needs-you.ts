import type { NeedsYou, TaskCard, TaskResult } from "../core/types.ts";
import type { Board } from "./board.ts";
import { cardHref } from "./feed.ts";

/**
 * What a card that needs Milton wants, and the one button that resolves
 * it (TaskCard.needsYou). deriveNeedsYou is pure: same card and context,
 * same answer. needsYouFor gathers that context from the Board (worktree
 * presence, reviewer approval, whether the worktree changed anything,
 * fallback reasons off the latest results) for GET /tasks.
 *
 * Every answer has a lane. `human` is a decision only Milton can make,
 * and always says why in full and what to do as a checklist. `next-step`
 * is finished work waiting on one mechanical step: no reading needed.
 *
 * Precedence, first match wins:
 *   mcp-approval  review + pendingMcpApproval                     human
 *   grant-tools   escalated + suggestedGrants                     human
 *   escalated     escalated                                       human
 *   report        review + worktree that changed nothing          PASS: next-step, else human
 *   merge-after   review + worktree + a dependency not done yet   next-step
 *   merge         review + worktree                               approved: next-step, else human
 *   blocked-on    inbox/ready + a dependency that is stuck        missing: human, else next-step
 *   review        review (no worktree)                            human
 *   failed                                                        human
 *   no-match                                                      human
 */

export interface NeedsYouContext {
  byId: ReadonlyMap<string, TaskCard>;
  hasWorktree(id: string): boolean;
  /** escalated: the reason to show when escalationContext is empty.
   *  failed: the failure text appended to the line. */
  fallbackReason?: { text: string; source: "reviewer" | "implementer" };
  /** review + worktree: the newest reviewer verdict in the card's review
   *  lineage was "approve". */
  approved?: boolean;
  /** review + worktree: false when the worktree holds no change at all
   *  (nothing uncommitted, untracked or committed past its merge target),
   *  so merging would land nothing. undefined when unknown. */
  worktreeChanged?: boolean;
  /** review + worktree: the card's own result summary, for a report's
   *  "VERDICT: PASS|FAIL" line. */
  summary?: string;
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

/** A review report's verdict line ("VERDICT: FAIL 0 HIGH / 2 MED / 3 LOW"),
 *  as the review cards write it on the first line of their summary. */
export function reportVerdict(summary: string | undefined): { pass: boolean; counts: string } | undefined {
  const m = /^\s*VERDICT:\s*(PASS|FAIL)\b[\s:,-]*(.*)$/im.exec(summary ?? "");
  if (!m) return undefined;
  return { pass: m[1]!.toUpperCase() === "PASS", counts: m[2]!.trim() };
}

function reasonFor(task: TaskCard, ctx: NeedsYouContext): Pick<NeedsYou, "reason" | "reasonSource"> {
  const own = task.escalationContext?.trim();
  if (own) return { reason: own, reasonSource: "escalation" };
  const fb = ctx.fallbackReason?.text.trim();
  if (fb) return { reason: fb, reasonSource: ctx.fallbackReason!.source };
  return { reason: "No reason recorded", reasonSource: "none" };
}

function target(task: TaskCard): string {
  return task.mergeTarget || "its target branch";
}

export function deriveNeedsYou(task: TaskCard, ctx: NeedsYouContext): NeedsYou | undefined {
  if (task.archivedAt || task.supersededBy) return undefined;
  const deps = task.dependsOn ?? [];
  const agent = task.routedTo ?? "The agent";

  if (task.status === "review" && task.pendingMcpApproval) {
    const { server, tool } = task.pendingMcpApproval;
    return {
      kind: "mcp-approval",
      lane: "human",
      value: "mcp-approval",
      line: `Wants to call ${server} · ${tool}`,
      why: `${agent} stopped before calling ${server} · ${tool}. That tool needs your OK on every call, and nothing runs until you decide.`,
      checklist: [
        `Open the card and read what it wants ${server} · ${tool} for`,
        `Check the call fits this card and touches nothing it shouldn't`,
        `Approve it (a follow-up card runs with only that tool), or Deny`,
      ],
      action: { label: "Approve", href: taskPath(task.id, "mcp-approval/approve"), method: "POST" },
    };
  }

  if (task.status === "escalated") {
    const rounds = (task.pushbackCount ?? 0) + 1;
    const why = reasonFor(task, ctx);
    const grants = task.suggestedGrants ?? [];
    const roundsText = `${rounds} ${rounds === 1 ? "round" : "rounds"}`;
    if (grants.length > 0) {
      return {
        kind: "grant-tools",
        lane: "human",
        value: "grant-tools",
        line: `Needs ${grants.join(", ")} to continue (round ${rounds})`,
        why: `The reviewer sent this back after ${roundsText}: the work needs ${grants.join(", ")}, which the agent was refused. It can't get further without that permission. Reason: ${lastParagraph(why.reason!)}`,
        ...why,
        rounds,
        grants: [...grants],
        checklist: [
          "Read the reason below",
          `Check each tool is safe to grant for this repo: ${grants.join(", ")}`,
          "Grant and retry, or abandon the card",
        ],
        action: { label: "Grant and retry", href: taskPath(task.id, "escalation/grant-and-retry"), method: "POST" },
      };
    }
    return {
      kind: "escalated",
      lane: "human",
      value: "escalated",
      line: `Escalated after ${roundsText}: ${lastParagraph(why.reason!)}`,
      why: `The reviewer rejected this ${rounds === 1 ? "once" : `${rounds} times`}, and automatic retries have stopped. Another round only helps if something changes: the card, the agent, or what it is allowed to do.`,
      ...why,
      rounds,
      checklist: [
        "Read the reviewer's last reason",
        "Decide whether the card asks for the right thing, and edit it if not",
        "Retry for another round, or abandon the card",
      ],
      action: { label: "Retry", href: taskPath(task.id, "escalation/retry"), method: "POST" },
    };
  }

  if (task.status === "review" && ctx.hasWorktree(task.id) && ctx.worktreeChanged === false) {
    const verdict = reportVerdict(ctx.summary);
    const close = { label: "Close", href: taskPath(task.id, "close"), method: "POST" as const };
    if (verdict?.pass) {
      return {
        kind: "report",
        lane: "next-step",
        value: "report:pass",
        line: `Review passed${verdict.counts ? ` (${verdict.counts})` : ""}, nothing to merge`,
        why: "A review report with a PASS verdict. Its worktree holds no change, so there is nothing to merge: close it.",
        action: close,
      };
    }
    const found = verdict ? `It reports FAIL${verdict.counts ? ` (${verdict.counts})` : ""}.` : "It has no PASS or FAIL verdict line.";
    return {
      kind: "report",
      lane: "human",
      value: verdict ? "report:fail" : "report",
      line: verdict ? `Review failed${verdict.counts ? `: ${verdict.counts}` : ""}` : "Report to read, nothing to merge",
      why: `This card made a report, not a change: its worktree is empty, so Merge would land nothing. ${found} Someone has to decide what happens to the findings.`,
      checklist: [
        "Read the findings in the card's result",
        "Decide: start a fix round for them, or accept the work as it is",
        "Close this card",
      ],
      action: open(task.id),
    };
  }

  if (task.status === "review" && ctx.hasWorktree(task.id)) {
    for (const depId of deps) {
      const dep = ctx.byId.get(depId);
      if (dep?.status === "done") continue;
      const short = id8(depId);
      const name = dep?.title || short;
      return {
        kind: "merge-after",
        lane: "next-step",
        value: `merge-after:${short}`,
        line: `Merge ${name} first`,
        why: `Finished, but it builds on ${name} (${dep?.status ?? "missing"}), which has to land first.`,
        blocker: { id: depId, id8: short, status: dep?.status ?? "missing" },
        action: ctx.hasWorktree(depId)
          ? { label: `Merge ${short}`, href: taskPath(depId, "merge"), method: "POST" }
          : open(depId),
      };
    }
    const merge = { label: "Merge", href: taskPath(task.id, "merge"), method: "POST" as const };
    if (ctx.approved) {
      return {
        kind: "merge",
        lane: "next-step",
        value: "merge",
        line: `Approved, ready to merge into ${target(task)}`,
        why: `The reviewer approved it. Merging into ${target(task)} is the only step left, and the merge gate runs the checks again.`,
        action: merge,
      };
    }
    return {
      kind: "merge",
      lane: "human",
      value: "merge:unreviewed",
      line: "Changes nobody has reviewed",
      why: `It finished with changes in its worktree, but no reviewer approved them: its agent has no reviewer hand-off, or an automatic merge stopped short. Nothing lands in ${target(task)} until someone checks it.`,
      checklist: ["Read the diff", "Check the card's checks and tests are green", "Merge, or Discard"],
      action: merge,
    };
  }

  if (task.status === "inbox" || task.status === "ready") {
    for (const depId of deps) {
      const dep = ctx.byId.get(depId);
      if (dep && !STUCK_STATUSES.has(dep.status)) continue;
      const short = id8(depId);
      const status: TaskCard["status"] | "missing" = dep?.status ?? "missing";
      const name = dep?.title || short;
      const blocker = { id: depId, id8: short, status };
      if (!dep) {
        return {
          kind: "blocked-on",
          lane: "human",
          value: `blocked-on:${short} ${status}`,
          line: `Waiting on ${short}, which no longer exists`,
          why: `It depends on card ${short}, which is gone from the board, so it will never start on its own.`,
          checklist: ["Check whether the work of the missing card is still needed", "Remove the dependency, or recreate that card and point this one at it"],
          blocker,
          action: open(task.id),
        };
      }
      return {
        kind: "blocked-on",
        lane: "next-step",
        value: `blocked-on:${short} ${status}`,
        line: `Waiting on ${name}, which is ${status}`,
        why: `It starts once ${name} is done. That card is ${status}; resolve it there and this one follows.`,
        blocker,
        action: open(depId),
      };
    }
    return undefined;
  }

  if (task.status === "review") {
    return {
      kind: "review",
      lane: "human",
      value: "review",
      line: "Result nobody has checked",
      why: `${agent} finished, but no reviewer is set up for it and there's no worktree to merge, so nobody has looked at the result.`,
      checklist: ["Read the result", "Move it to done if it's right, or send it back with a note"],
      action: open(task.id),
    };
  }

  if (task.status === "failed") {
    const fb = ctx.fallbackReason?.text.trim();
    return {
      kind: "failed",
      lane: "human",
      value: "failed",
      line: fb ? `Failed: ${lastParagraph(fb)}` : "Failed",
      why: `The run failed${fb ? `: ${lastParagraph(fb)}` : " with no message recorded"}. A failed card is never retried on its own.`,
      checklist: [
        "Read the failure in the card's output",
        "Fix the cause if it's outside the card (credentials, repo, harness)",
        "Retry, or delete the card",
      ],
      action: { label: "Retry", href: taskPath(task.id, "run"), method: "POST" },
    };
  }

  if (task.status === "no-match") {
    return {
      kind: "no-match",
      lane: "human",
      value: "no-match",
      line: "No agent matched",
      why: `No agent's tags matched this card's labels (${task.labels.join(", ") || "none"}), so nothing picked it up.`,
      checklist: ["Check the card's labels", "Pick an agent by hand, or relabel the card", "Run it"],
      action: open(task.id),
    };
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

/** Whether the newest reviewer verdict in the card's review lineage was
 *  "approve". Cards in the lineage are in creation order, so the last
 *  one with a verdict is the latest review. */
async function lineageApproved(
  board: Pick<Board, "getResult" | "getLineage">,
  task: TaskCard,
  results: ReadonlyMap<string, TaskResult | undefined>,
): Promise<boolean> {
  const lineage = await board.getLineage(task.reviewLineageId ?? task.id);
  for (const card of [...lineage].reverse()) {
    if (card.id === task.id) continue;
    const r = results.has(card.id) ? results.get(card.id) : await board.getResult(card.id);
    if (r?.verdict) return r.verdict === "approve";
  }
  return false;
}

export interface NeedsYouOptions {
  /** Whether the card's worktree holds any change: false means merging
   *  it would land nothing. undefined (or no checker) means unknown, and
   *  the card is treated as one with changes. */
  worktreeChanged?(task: TaskCard, worktree: NonNullable<TaskResult["worktree"]>): Promise<boolean | undefined>;
}

/** needsYou for every card in `tasks` that needs Milton, keyed by id.
 *  `tasks` doubles as the dependency lookup, so pass the whole board
 *  when the caller filtered what it returns. */
export async function needsYouFor(
  board: Pick<Board, "getResult" | "getLineage">,
  tasks: TaskCard[],
  opts: NeedsYouOptions = {},
): Promise<Map<string, NeedsYou>> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results = new Map<string, TaskResult | undefined>();
  const wanted = tasks.filter((t) => !t.archivedAt && RESULT_STATUSES.has(t.status));
  await Promise.all(wanted.map(async (t) => results.set(t.id, await board.getResult(t.id))));
  const hasWorktree = (id: string) => results.get(id)?.worktree !== undefined;

  const out = new Map<string, NeedsYou>();
  for (const task of tasks) {
    const extra: Partial<NeedsYouContext> = {};
    if (!task.archivedAt && !task.supersededBy) {
      if (task.status === "escalated" && !nonEmpty(task.escalationContext)) {
        extra.fallbackReason = await escalationFallback(board, task, results);
      } else if (task.status === "failed") {
        const summary = nonEmpty(results.get(task.id)?.summary);
        if (summary) extra.fallbackReason = { text: summary, source: "implementer" };
      } else if (task.status === "review" && !task.pendingMcpApproval && hasWorktree(task.id)) {
        const result = results.get(task.id)!;
        extra.summary = result.summary;
        extra.approved = await lineageApproved(board, task, results);
        if (opts.worktreeChanged) {
          try {
            extra.worktreeChanged = await opts.worktreeChanged(task, result.worktree!);
          } catch {
            extra.worktreeChanged = undefined;
          }
        }
      }
    }
    const ny = deriveNeedsYou(task, { byId, hasWorktree, ...extra });
    if (ny) out.set(task.id, ny);
  }
  return out;
}

/** "needs-you: escalated=1 merge=2 (human=1 next-step=2)", kinds sorted;
 *  "needs-you: none" when empty. */
export function needsYouLogLine(all: ReadonlyMap<string, NeedsYou>): string {
  const counts = new Map<string, number>();
  for (const ny of all.values()) counts.set(ny.kind, (counts.get(ny.kind) ?? 0) + 1);
  if (counts.size === 0) return "needs-you: none";
  let human = 0;
  for (const ny of all.values()) if (ny.lane === "human") human++;
  const kinds = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => `${k}=${n}`).join(" ");
  return `needs-you: ${kinds} (human=${human} next-step=${all.size - human})`;
}
