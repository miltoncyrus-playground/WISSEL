/**
 * Host actions (docs/SDD-coordinator.md §4.3, §4.5, §4.6, §4.7, §4.13):
 * the executor's outward handlers that touch the code host. pr.open
 * delivers a card's worktree as a pull request through the orchestrator's
 * own pull-request path and records TaskCard.pr; branch.push lands a fix
 * round's commits on an existing PR branch from a fresh host worktree,
 * with the base merged forward and both gates green, never force-pushed;
 * pr.arm turns auto-merge on only after re-reading the PR and finding its
 * head at the reviewed sha with green checks. Every git and gh call goes
 * through the merge context's `host` runner (tests fake it and use a bare
 * repository as origin). pushStillGreen and startFixRound are the
 * executor's callbacks for a queued push (§4.3): the same merge-and-gate
 * check without the push, and the driver's fix-round card.start.
 */

import { deliverPullRequest, type AutoMergeOutcome } from "../core/orchestrator.ts";
import type { Project, PrRef, PullRequestDelivery, TaskCard } from "../core/types.ts";
import type { Board } from "./board.ts";
import { fixRoundActions } from "./coordinator-driver.ts";
import type { ActionHandlers, ExecutableAction, ExecuteOutcome } from "./coordinator-executor.ts";
import { summarizeChecks } from "./github-status.ts";
import { pushToPullRequestBranch, type PrDeliveryResult } from "./pr-delivery.ts";
import type { ProjectSettings } from "./project-settings.ts";
import { ticketKeyOf } from "./ticket-refs.ts";
import type { MergeContext, TaskWorktree } from "./worktree.ts";

export interface HostActionDeps {
  board: Board;
  projects: { list(): Promise<Project[]> };
  settingsFor: (repo: string) => Promise<ProjectSettings | undefined>;
  /** The merge path's context: `runner` for git, `host` for push and gh, `gateFor` and `gateRunner` for the gates. */
  merge: MergeContext;
  /** The executor, so a fix round takes the gated card.start path like the driver's. */
  execute: (action: ExecutableAction) => Promise<ExecuteOutcome>;
  homeDir?: string;
  /** The console line the owner reads (§4.9: the channel is the board log plus the terminal). */
  log?: (line: string) => void;
}

export interface HostActions {
  handlers: ActionHandlers;
  pushStillGreen: (action: ExecutableAction) => Promise<{ green: boolean; reason?: string }>;
  startFixRound: (action: ExecutableAction, reason: string) => Promise<void>;
}

const str = (v: unknown, name: string): string => (typeof v === "string" && v.trim() !== "" ? v : (() => { throw new Error(`${name} must be a non-empty string`); })());

export function hostHandlers(deps: HostActionDeps): HostActions {
  const log = deps.log ?? ((line: string) => console.log(line));
  const host = deps.merge.host ?? deps.merge.runner;

  async function cardOf(action: ExecutableAction): Promise<TaskCard> {
    const id = str(action.payload?.taskId, "taskId");
    const card = await deps.board.get(id);
    if (!card) throw new Error(`unknown card ${id}`);
    if (!card.repo) throw new Error(`card ${id} has no repo`);
    return card;
  }

  /** The card's worktree and its project's pull-request delivery; a local-merge project has no PR to open or push to. */
  async function landingOf(card: TaskCard): Promise<{ worktree: TaskWorktree; delivery: PullRequestDelivery; settings: ProjectSettings | undefined }> {
    const worktree = (await deps.board.getResult(card.id))?.worktree;
    if (!worktree) throw new Error(`card ${card.id} has no worktree to deliver`);
    const settings = await deps.settingsFor(card.repo!);
    if (settings?.delivery?.mode !== "pull-request") throw new Error(`${card.repo}: delivery is not pull-request; nothing to deliver for ${card.id}`);
    return { worktree, delivery: settings.delivery, settings };
  }

  /** branch.push's work with or without the push itself. `branch` defaults to the card's PR head. */
  async function pushFixRound(action: ExecutableAction, dryRun: boolean): Promise<PrDeliveryResult> {
    const card = await cardOf(action);
    const { worktree, delivery, settings } = await landingOf(card);
    const branch = typeof action.payload?.branch === "string" && action.payload.branch !== "" ? action.payload.branch : card.pr?.head;
    if (!branch) throw new Error(`card ${card.id} has no PR branch to push to`);
    const mergeGate = await deps.merge.gateFor?.(card.repo!).catch(() => undefined);
    const ctx = { runner: deps.merge.runner, host, gateRunner: deps.merge.gateRunner, mergeGate, ticketPatterns: settings?.ticketPatterns, homeDir: deps.homeDir };
    const res = await pushToPullRequestBranch(card.repo!, worktree, card, branch, delivery, ctx, { dryRun });
    log(`push ${card.id}: ${res.outcome}: ${res.message}`);
    return res;
  }

  const startFixRound: HostActions["startFixRound"] = async (action, reason) => {
    const card = await cardOf(action);
    const project = (await deps.projects.list()).find((p) => p.path === card.repo);
    const ticket = ticketKeyOf([card.title, card.pr?.head], project?.ticketPatterns);
    for (const [i, draft] of fixRoundActions(project, card, reason, (card.round ?? 0) + 1, ticket).entries()) {
      await deps.execute({ ...draft, ...(action.id ? { id: `${action.id}#fix${i}` } : {}), workstreamId: action.workstreamId, projectId: action.projectId });
    }
  };

  const handlers: ActionHandlers = {
    "pr.open": async (action): Promise<{ outcome: AutoMergeOutcome; pr?: PrRef }> => {
      const card = await cardOf(action);
      const { worktree, delivery, settings } = await landingOf(card);
      const outcome = await deliverPullRequest(deps.board, card, worktree, delivery, settings?.ticketPatterns, deps.merge);
      const pr = (await deps.board.get(card.id))?.pr;
      return { outcome, ...(pr ? { pr } : {}) };
    },
    "branch.push": async (action) => {
      const res = await pushFixRound(action, false);
      if (res.outcome === "gate-failed") {
        // §4.3: a push that is not green becomes a fix round instead; the branch at origin is left as it was.
        await startFixRound(action, res.message);
        return { outcome: res.outcome, branch: res.branch, pushed: false, message: res.message, fixRound: true };
      }
      if (!res.ok) throw new Error(res.message);
      return { outcome: res.outcome, branch: res.branch, pushed: res.pushed, message: res.message };
    },
    "pr.arm": async (action) => {
      const card = await cardOf(action);
      const number = typeof action.payload?.pr === "number" ? action.payload.pr : card.pr?.number;
      if (!card.pr || number === undefined) throw new Error(`card ${card.id} has no pull request to arm`);
      const reviewed = card.pr.reviewedSha;
      if (!reviewed) throw new Error(`PR #${number} has no reviewed sha on card ${card.id}; a review must pass on its head first`);
      // §4.7: ready is tied to the reviewed head sha, so the PR is read again right before arming.
      const view = await host(["gh", "pr", "view", String(number), "--json", "headRefOid,baseRefName,state,statusCheckRollup"], { cwd: card.repo! });
      if (view.exitCode !== 0) throw new Error(`\`gh pr view ${number}\` failed: ${(view.stderr || view.stdout).trim()}`);
      let raw: { headRefOid?: string; baseRefName?: string; state?: string; statusCheckRollup?: unknown };
      try {
        raw = JSON.parse(view.stdout) as typeof raw;
      } catch {
        throw new Error(`\`gh pr view ${number}\` printed no JSON`);
      }
      if (raw.state !== undefined && raw.state !== "OPEN") throw new Error(`PR #${number} is ${raw.state.toLowerCase()}, not open; not armed`);
      if (action.base && raw.baseRefName && raw.baseRefName !== action.base) throw new Error(`PR #${number} targets ${raw.baseRefName}, not ${action.base}; not armed`);
      if (raw.headRefOid !== reviewed) throw new Error(`PR #${number} head ${raw.headRefOid ?? "unknown"} is not the reviewed ${reviewed}; it needs a new review before arming`);
      const checks = summarizeChecks(raw.statusCheckRollup);
      if (checks.state !== "passing") throw new Error(`PR #${number} checks are ${checks.state}${checks.failing.length ? ` (${checks.failing.join(", ")})` : ""} on ${reviewed}; not armed`);
      const armed = await host(["gh", "pr", "merge", String(number), "--auto", "--squash"], { cwd: card.repo! });
      if (armed.exitCode !== 0) throw new Error(`\`gh pr merge ${number} --auto --squash\` failed: ${(armed.stderr || armed.stdout).trim()}`);
      log(`arm ${card.id}: PR #${number} auto-merge on at ${reviewed}`);
      return { armed: true, number, sha: reviewed };
    },
  };

  return {
    handlers,
    pushStillGreen: async (action) => {
      try {
        const res = await pushFixRound(action, true);
        return res.ok ? { green: true } : { green: false, reason: res.message };
      } catch (e) {
        return { green: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    startFixRound,
  };
}
