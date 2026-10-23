// Type declaration for board-work.js — a plain browser script that's also
// imported directly by bun test. Kept in sync by hand; the .js file is the
// source of truth for behavior.
import type { TaskCard } from "../../core/types.ts";
import type { WorkProject, WorkTicket, WorkView } from "../../services/project-git.ts";

type RepoProject = { path: string; ticketPatterns?: string[] };

export function ticketKeyOf(texts: (string | undefined)[], patterns?: string[]): string | undefined;
export function projectForRepo<P extends RepoProject>(repo: string | undefined, projects: P[]): P | undefined;
export function cardTicketKey(task: Pick<TaskCard, "title" | "repo" | "mergeTarget">, projects: RepoProject[]): string | undefined;
export function filterWork(work: WorkView, filters?: { projectId?: string; attentionOnly?: boolean }): WorkView;
export function ticketSummary(t: WorkTicket): string;
export function ticketKeysOf(work: WorkView): string[];
export function projectStateLine(p: WorkProject): string;
