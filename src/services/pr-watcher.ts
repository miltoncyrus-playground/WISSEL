// The PR watcher (docs/SDD-coordinator.md §4.7, phase 2 card 9).
//
// Every card delivered as a pull request (TaskCard.pr, card 7) is looked
// at once a minute until its PR is merged or closed: its checks and the
// head they ran on, whether it can merge (clean, dirty, blocked, behind),
// whether auto-merge is armed, and its state. What it sees is kept on the
// card (`pr.watch`), so a card's life carries on past `done`: landed (PR
// open), ready (the reviewed head with every check green and nothing in
// the way), merged, or closed.
//
// Each change is one `pr.changed` telemetry event and one log line: the
// event inbox (§4.1) reads them once it exists, and a DIRTY PR is what
// starts merge-forward (card 10).
//
// Read-only: `gh pr view` with fixed argv, as the login `gh` has. It
// decides whether a PR may be armed (`armBlockedBy`) but never arms one.
// Arming writes to the code host, and that waits for roles and duties
// (§4.13), so a project whose role is `decide` turns it on.
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { PrLifecycle, PrWatch, TaskCard, TaskPullRequest } from "../core/types.ts";
import { parseGithubRemote, summarizeChecks } from "./github-status.ts";

export const PR_WATCH_INTERVAL_MS = 60_000;
const FIELDS = "number,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,autoMergeRequest,statusCheckRollup";

interface RawPr {
  number?: number;
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  headRefOid?: string;
  baseRefName?: string;
  autoMergeRequest?: unknown;
  statusCheckRollup?: unknown;
}

function mergeableOf(raw: RawPr): PrWatch["mergeable"] {
  const m = raw.mergeStateStatus ?? "";
  if (raw.mergeable === "CONFLICTING" || m === "DIRTY") return "dirty";
  if (m === "BEHIND") return "behind";
  if (m === "BLOCKED") return "blocked";
  if (m === "CLEAN" || m === "HAS_HOOKS" || m === "UNSTABLE") return "clean";
  return "unknown";
}

/** Why a PR may not be armed for auto-merge, or null when it may (§4.7):
 *  the base is the main branch, the head is the sha that was reviewed,
 *  every check passed or was skipped, and it is open, not a draft, and
 *  clean. */
export function armBlockedBy(w: Omit<PrWatch, "armBlockedBy" | "lifecycle" | "observedAt">, reviewedHead: string, mainBranch: string, state: "open" | "merged" | "closed"): string | null {
  if (state !== "open") return `the PR is ${state}`;
  if (w.draft) return "the PR is a draft";
  if (w.base !== mainBranch) return `its base is ${w.base}, not ${mainBranch}`;
  if (w.checks.headSha !== reviewedHead) return `its head ${w.checks.headSha.slice(0, 12)} is not the reviewed ${reviewedHead.slice(0, 12)}`;
  if (w.checks.state !== "passing") return w.checks.state === "none" ? "no check has run on it" : `checks are ${w.checks.state}${w.checks.failing.length ? ` (${w.checks.failing.join(", ")})` : ""}`;
  if (w.mergeable !== "clean") return `it is ${w.mergeable}, not clean`;
  return null;
}

/** What one `gh pr view` answer means for the card, or undefined when
 *  the answer can't be read. */
export function readPrWatch(raw: RawPr, pr: Pick<TaskPullRequest, "head">, mainBranch: string, now: Date): PrWatch | undefined {
  if (typeof raw.number !== "number" || typeof raw.headRefOid !== "string") return undefined;
  const state = raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open";
  const summary = summarizeChecks(raw.statusCheckRollup);
  const base: Omit<PrWatch, "armBlockedBy" | "lifecycle" | "observedAt"> = {
    checks: { state: summary.state, headSha: raw.headRefOid, failing: summary.failing },
    mergeable: state === "open" ? mergeableOf(raw) : "unknown",
    armed: raw.autoMergeRequest !== null && raw.autoMergeRequest !== undefined,
    draft: raw.isDraft === true,
    base: raw.baseRefName ?? "",
  };
  const blocked = armBlockedBy(base, pr.head, mainBranch, state);
  const lifecycle: PrLifecycle = state === "merged" ? "merged" : state === "closed" ? "closed" : blocked === null ? "ready" : "landed";
  return { ...base, lifecycle, armBlockedBy: blocked, observedAt: now.toISOString() };
}

/** What changed between two looks, as short phrases; empty when nothing
 *  that matters did (the time of the look aside). */
export function prChanges(before: PrWatch | undefined, after: PrWatch): string[] {
  if (!before) return [`first look: ${after.lifecycle}, checks ${after.checks.state}, ${after.mergeable}`];
  const out: string[] = [];
  if (before.lifecycle !== after.lifecycle) out.push(`${before.lifecycle} -> ${after.lifecycle}`);
  if (before.checks.state !== after.checks.state) out.push(`checks ${before.checks.state} -> ${after.checks.state}`);
  if (before.checks.headSha !== after.checks.headSha) out.push(`head ${before.checks.headSha.slice(0, 12)} -> ${after.checks.headSha.slice(0, 12)}`);
  if (before.mergeable !== after.mergeable) out.push(`${before.mergeable} -> ${after.mergeable}`);
  if (before.armed !== after.armed) out.push(after.armed ? "auto-merge armed" : "auto-merge disarmed");
  return out;
}

export interface PrChangedEvent {
  type: "pr.changed";
  taskId: string;
  number: number;
  changes: string[];
  lifecycle: PrLifecycle;
  mergeable: PrWatch["mergeable"];
  checks: PrWatch["checks"]["state"];
  headSha: string;
}

export interface PrWatcherDeps {
  /** Every card, to find the ones with a PR still to watch. */
  cards: () => Promise<TaskCard[]>;
  setPullRequest: (taskId: string, pr: TaskPullRequest) => Promise<unknown>;
  runner: CommandRunner;
  /** The main branch PRs of this repo target (Project.delivery.base, else
   *  the checked-out branch). */
  mainBranchFor: (repo: string) => Promise<string | undefined>;
  record?: (event: PrChangedEvent) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
  /** Called on every look at a dirty PR (card 10, merge-forward), after
   *  the card's watch is saved: it starts one merge-forward card, and
   *  re-runs it once its conflict integrator has finished. */
  onDirty?: (card: TaskCard) => Promise<unknown>;
}

/** Cards whose PR is worth another look: not archived, not merged or
 *  closed yet. */
export function watchedCards(cards: TaskCard[]): TaskCard[] {
  return cards.filter((c) => c.pr && c.repo && !c.archivedAt && c.pr.watch?.lifecycle !== "merged" && c.pr.watch?.lifecycle !== "closed");
}

export class PrWatcher {
  private running = false;

  constructor(private readonly deps: PrWatcherDeps) {}

  /** One pass over every watched card. Returns how many changed. A PR
   *  that can't be read is skipped this time, never marked. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let changed = 0;
    try {
      const repoSlug = new Map<string, string | undefined>();
      for (const card of watchedCards(await this.deps.cards())) {
        const pr = card.pr!;
        const repo = card.repo!;
        if (!repoSlug.has(repo)) {
          const remote = await this.deps.runner(["git", "remote", "get-url", "origin"], { cwd: repo }).catch(() => undefined);
          repoSlug.set(repo, remote && remote.exitCode === 0 ? parseGithubRemote(remote.stdout) : undefined);
        }
        const slug = repoSlug.get(repo);
        if (!slug) continue;
        const out = await this.deps.runner(["gh", "pr", "view", String(pr.number), "--repo", slug, "--json", FIELDS], { cwd: repo }).catch(() => undefined);
        if (!out || out.exitCode !== 0) continue;
        let raw: RawPr;
        try {
          raw = JSON.parse(out.stdout) as RawPr;
        } catch {
          continue;
        }
        const main = (await this.deps.mainBranchFor(repo)) ?? raw.baseRefName ?? "main";
        const watch = readPrWatch(raw, pr, main, (this.deps.now ?? (() => new Date()))());
        if (!watch) continue;
        const changes = prChanges(pr.watch, watch);
        if (changes.length > 0) {
          changed++;
          await this.deps.setPullRequest(card.id, { ...pr, watch });
          (this.deps.log ?? console.log)(`pr watcher: ${card.title} (#${pr.number}): ${changes.join("; ")}`);
          await this.deps.record?.({ type: "pr.changed", taskId: card.id, number: pr.number, changes, lifecycle: watch.lifecycle, mergeable: watch.mergeable, checks: watch.checks.state, headSha: watch.checks.headSha });
        }
        if (watch.mergeable === "dirty" && this.deps.onDirty) {
          await this.deps.onDirty({ ...card, pr: { ...pr, watch } }).catch((e) => (this.deps.log ?? console.log)(`pr watcher: merge forward for ${card.title} failed: ${(e as Error).message}`));
        }
      }
    } finally {
      this.running = false;
    }
    return changed;
  }
}
