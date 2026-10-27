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
export interface PrView {
  number: number;
  title: string;
  url: string;
  branch: string;
  state: "open" | "draft" | "merged" | "closed";
  review?: string;
  mergeable?: string;
  checks: { state: "passing" | "failing" | "pending" | "none"; total: number; failing: string[] };
}
export function prLine(pr: PrView): string;
export function prsByProject(answer: { projects: { id: string; repo?: string; prs?: PrView[]; error?: string }[] }): Record<string, { repo?: string; error?: string; byBranch: Record<string, PrView> }>;
export interface MineTicket { parent?: { key: string; summary: string }; key: string; summary: string; status: string; statusCategory?: string; assignee?: string; url: string }
export function cardsForTicket<T extends { archivedAt?: string; title: string; repo?: string; mergeTarget?: string }>(key: string, tasks: T[], projects: { path: string; ticketPatterns?: string[] }[]): T[];
export function ticketCardDraft(ticket: MineTicket, projects: { path: string; ticketPatterns?: string[] }[]): { title: string; body: string; repo?: string };
type Proj = { path: string; ticketPatterns?: string[] };
type CardLike = { id?: string; archivedAt?: string; title: string; repo?: string; mergeTarget?: string; status?: string };
export function workByKey(work: { tickets: { key: string | null; cardCount: number; branchCount: number }[] } | null | undefined): Record<string, { cards: number; branches: number }>;
export function ticketStarted(key: string, tasks: CardLike[], projects: Proj[], byKey?: Record<string, { cards: number; branches: number }>): boolean;
export function epicGroups(tickets: MineTicket[]): { epic: { key: string; summary: string } | null; tickets: MineTicket[] }[];
export function featureFollowUps(laneCards: CardLike[], mine: MineTicket[], known: Record<string, MineTicket>, projects: Proj[]): { implemented: boolean; epics: { key: string; summary: string }[]; own: MineTicket[]; followUps: MineTicket[] };
