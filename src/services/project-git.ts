import { resolve } from "node:path";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { TaskCard } from "../core/types.ts";
import { getProjectGitStatus, type ProjectGitStatus } from "./project-status.ts";
import { referencesOf, ticketKeyOf } from "./ticket-refs.ts";
import { taskWorktreePath } from "./worktree.ts";

/** What a project's repo looks like right now: its branches and
 *  worktrees, grouped by the ticket each belongs to, with the cards
 *  working on them. Read-only git (`for-each-ref`, `worktree list`) and
 *  string matching: no network, no fetch, no LLM. Everything is as of
 *  the repo's last fetch. */
export interface BranchInfo {
  name: string;
  /** On this machine, on a remote, or both. */
  local: boolean;
  remote: boolean;
  /** The branch checked out in the project's own checkout. */
  current: boolean;
  shortSha: string;
  date: string;
  subject: string;
  /** Non-ticket references (a decision or spec id) found in the name. */
  references: string[];
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  /** The card whose worktree this is, when one matches. */
  cardId?: string;
}

export interface TicketCard {
  id: string;
  title: string;
  status: TaskCard["status"];
}

export interface TicketGroup {
  /** The ticket key, or null for work that names none. */
  key: string | null;
  branches: string[];
  worktrees: string[];
  cards: TicketCard[];
}

export interface ProjectGitOverview {
  status: ProjectGitStatus;
  branches: BranchInfo[];
  worktrees: WorktreeInfo[];
  tickets: TicketGroup[];
  /** Branches beyond MAX_BRANCHES, newest first kept. */
  truncated: boolean;
}

export const MAX_BRANCHES = 200;

/** The slice of a card this reads. */
export type OverviewCard = Pick<TaskCard, "id" | "title" | "status" | "repo" | "mergeTarget" | "archivedAt" | "reviewLineageId">;

const SEP = "\x1f";
const FORMAT = ["%(refname)", "%(objectname:short)", "%(committerdate:iso-strict)", "%(subject)", "%(HEAD)"].join(SEP);

async function run(runner: CommandRunner, path: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const result = await runner(["git", ...args], { cwd: path });
  return { ok: result.exitCode === 0, stdout: result.stdout.trim() };
}

/** Remote refs are `refs/remotes/<remote>/<branch>`. The remote's HEAD
 *  pointer and the merge queue's scratch branches are not work. */
function remoteBranchName(refname: string): string | undefined {
  const rest = refname.slice("refs/remotes/".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return undefined;
  const name = rest.slice(slash + 1);
  if (name === "HEAD" || name.startsWith("gh-readonly-queue/")) return undefined;
  return name;
}

/** `git worktree list --porcelain`: blank-line separated blocks of
 *  `worktree <path>` and `branch refs/heads/<name>`. */
export function parseWorktrees(out: string): { path: string; branch?: string }[] {
  const found: { path: string; branch?: string }[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (path) found.push({ path, ...(branch ? { branch } : {}) });
  }
  return found;
}

export async function getProjectGitOverview(
  path: string,
  runner: CommandRunner,
  opts: { ticketPatterns?: readonly string[]; referencePatterns?: readonly string[]; cards?: readonly OverviewCard[]; homeDir?: string } = {},
): Promise<ProjectGitOverview | { error: string }> {
  const status = await getProjectGitStatus(path, runner);
  if ("error" in status) return status;

  const refs = await run(runner, path, ["for-each-ref", "--sort=-committerdate", `--format=${FORMAT}`, "refs/heads", "refs/remotes"]);
  const byName = new Map<string, BranchInfo>();
  for (const line of refs.ok && refs.stdout ? refs.stdout.split("\n") : []) {
    const [refname, shortSha, date, subject, head] = line.split(SEP);
    if (!refname || !shortSha || !date || subject === undefined) continue;
    const local = refname.startsWith("refs/heads/");
    const name = local ? refname.slice("refs/heads/".length) : refname.startsWith("refs/remotes/") ? remoteBranchName(refname) : undefined;
    if (!name) continue;
    const existing = byName.get(name);
    if (existing) {
      if (local) existing.local = true;
      else existing.remote = true;
      if (head === "*") existing.current = true;
      continue;
    }
    byName.set(name, {
      name,
      local,
      remote: !local,
      current: head === "*",
      shortSha,
      date,
      subject,
      references: referencesOf([name], opts.referencePatterns),
    });
  }
  const all = [...byName.values()];
  const truncated = all.length > MAX_BRANCHES;
  const branches = all.slice(0, MAX_BRANCHES);

  const repoKey = resolve(path);
  const cards = (opts.cards ?? []).filter((c) => !c.archivedAt && c.repo && resolve(c.repo) === repoKey);
  const listed = await run(runner, path, ["worktree", "list", "--porcelain"]);
  const worktrees: WorktreeInfo[] = (listed.ok ? parseWorktrees(listed.stdout) : [])
    .filter((w) => resolve(w.path) !== repoKey)
    .map((w) => {
      const card = cards.find((c) => resolve(taskWorktreePath(c, opts.homeDir)) === resolve(w.path));
      return { ...w, ...(card ? { cardId: card.id } : {}) };
    });

  const groups = new Map<string, TicketGroup>();
  const groupFor = (key: string | undefined): TicketGroup => {
    const id = key ?? "";
    let g = groups.get(id);
    if (!g) {
      g = { key: key ?? null, branches: [], worktrees: [], cards: [] };
      groups.set(id, g);
    }
    return g;
  };
  for (const b of branches) groupFor(ticketKeyOf([b.name, b.subject], opts.ticketPatterns)).branches.push(b.name);
  for (const w of worktrees) {
    const card = cards.find((c) => c.id === w.cardId);
    groupFor(ticketKeyOf([card?.title, w.branch], opts.ticketPatterns)).worktrees.push(w.path);
  }
  for (const c of cards) {
    groupFor(ticketKeyOf([c.title, c.mergeTarget], opts.ticketPatterns)).cards.push({ id: c.id, title: c.title, status: c.status });
  }

  // Tickets with live cards first, then the rest by key; "no ticket" last.
  const tickets = [...groups.values()].sort((a, b) => {
    if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
    if ((a.cards.length > 0) !== (b.cards.length > 0)) return a.cards.length > 0 ? -1 : 1;
    return (a.key ?? "").localeCompare(b.key ?? "", undefined, { numeric: true });
  });

  return { status, branches, worktrees, tickets, truncated };
}

/** One project as the Tickets page sees it: where its checkout stands and
 *  why it may need a look. */
export interface WorkProject {
  id: string;
  name: string;
  status?: ProjectGitStatus;
  /** Why the checkout may need attention: changed files, not on the main
   *  branch, detached, behind its upstream. Empty when it doesn't. */
  attention: string[];
  /** Set when the repo could not be read; the project has no tickets. */
  error?: string;
}

/** One ticket across every project that has work on it. */
export interface WorkTicket {
  key: string | null;
  projects: { id: string; name: string; branches: string[]; worktrees: number; cards: TicketCard[] }[];
  cardCount: number;
  branchCount: number;
}

export interface WorkView {
  projects: WorkProject[];
  tickets: WorkTicket[];
}

const MAIN_BRANCHES = new Set(["main", "master"]);

/** Why a checkout may need attention. A checkout on a feature branch is
 *  normal while a spec is being written, so this names it rather than
 *  calls it wrong. */
export function attentionOf(status: ProjectGitStatus): string[] {
  const reasons: string[] = [];
  if (status.dirty) reasons.push(`${status.changedFiles} changed file${status.changedFiles === 1 ? "" : "s"}`);
  if (status.detached) reasons.push(`detached at ${status.branch}`);
  else if (!MAIN_BRANCHES.has(status.branch)) reasons.push(`on ${status.branch}`);
  if (status.behind) reasons.push(`${status.behind} behind`);
  return reasons;
}

/** Merges each project's overview into one ticket-first view: a ticket
 *  lists every project that has a branch, worktree or card on it. Pure. */
export function groupWork(entries: readonly { project: { id: string; name: string }; overview: ProjectGitOverview | { error: string } }[]): WorkView {
  const projects: WorkProject[] = [];
  const byKey = new Map<string, WorkTicket>();
  for (const { project, overview } of entries) {
    if ("error" in overview) {
      projects.push({ id: project.id, name: project.name, attention: [], error: overview.error });
      continue;
    }
    projects.push({ id: project.id, name: project.name, status: overview.status, attention: attentionOf(overview.status) });
    for (const t of overview.tickets) {
      const id = t.key ?? "";
      let ticket = byKey.get(id);
      if (!ticket) {
        ticket = { key: t.key, projects: [], cardCount: 0, branchCount: 0 };
        byKey.set(id, ticket);
      }
      ticket.projects.push({ id: project.id, name: project.name, branches: t.branches, worktrees: t.worktrees.length, cards: t.cards });
      ticket.cardCount += t.cards.length;
      ticket.branchCount += t.branches.length;
    }
  }
  const tickets = [...byKey.values()].sort((a, b) => {
    if ((a.key === null) !== (b.key === null)) return a.key === null ? 1 : -1;
    if ((a.cardCount > 0) !== (b.cardCount > 0)) return a.cardCount > 0 ? -1 : 1;
    return (a.key ?? "").localeCompare(b.key ?? "", undefined, { numeric: true });
  });
  return { projects, tickets };
}
