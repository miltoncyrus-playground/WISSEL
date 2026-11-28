// Importing a team's existing coordinator (docs/SDD-coordinator.md §7,
// phase 3 card 21).
//
// A team that already has a coordinator brings its state across. Import
// creates nothing:
// - Work items ({ key, cardId?, pr?, sha?, round? }, JSONL or a list) are
//   matched to cards already on the board: by cardId, else by key within
//   the workstream. A match gets its key, workstream, round and PR
//   recorded. A card that already has a different key or PR is reported as
//   a conflict and left as it is. An item that matches nothing is reported.
// - Standing rules become a project's cardRules and card templates, through
//   the same checks as POST /projects/:id/settings.
// - The channel cursor is where Wissel's channel reading starts.
// - The schedule (digests, quiet hours) goes onto the workstream.
// `dryRun: true` reports all of it and changes nothing.
import type { TaskCard, TaskPullRequest } from "../core/types.ts";
import { CARD_KEY_PATTERN } from "./task-input.ts";
import type { Workstream } from "./workstreams.ts";

export interface ImportItem {
  key: string;
  cardId?: string;
  pr?: number | { number: number; url?: string };
  sha?: string;
  round?: number;
}

export interface ImportBody {
  items?: string | ImportItem[];
  rules?: { projectId: string; cardRules?: string; cardTemplates?: Record<string, string> };
  channelCursor?: string;
  schedule?: { digests?: unknown; quietHours?: unknown };
  dryRun?: boolean;
}

export interface ImportReport {
  dryRun: boolean;
  matched: Array<{ key: string; cardId: string; set: string[] }>;
  unmatched: Array<{ key: string; reason: string }>;
  conflicts: Array<{ key: string; cardId: string; reason: string }>;
  invalid: Array<{ line: number; reason: string }>;
  rules?: string;
  channelCursor?: string;
  schedule?: string;
}

/** The items, from JSONL text or a list; bad lines are reported, not fatal. */
export function parseItems(raw: ImportBody["items"]): { items: Array<ImportItem & { line: number }>; invalid: ImportReport["invalid"] } {
  const rows: unknown[] = typeof raw === "string" ? raw.split("\n").map((l) => l.trim()) : (raw ?? []);
  const items: Array<ImportItem & { line: number }> = [];
  const invalid: ImportReport["invalid"] = [];
  rows.forEach((row, i) => {
    const line = i + 1;
    if (row === "") return;
    let v: unknown = row;
    if (typeof row === "string") {
      try {
        v = JSON.parse(row);
      } catch {
        invalid.push({ line, reason: "not JSON" });
        return;
      }
    }
    const o = v as Record<string, unknown> | null;
    if (!o || typeof o !== "object" || typeof o.key !== "string" || !CARD_KEY_PATTERN.test(o.key)) return void invalid.push({ line, reason: "needs a key such as A4" });
    if (o.cardId !== undefined && typeof o.cardId !== "string") return void invalid.push({ line, reason: "cardId must be text" });
    if (o.sha !== undefined && (typeof o.sha !== "string" || !/^[0-9a-f]{40}$/.test(o.sha))) return void invalid.push({ line, reason: "sha must be the full 40-character commit sha" });
    if (o.round !== undefined && !(Number.isInteger(o.round) && (o.round as number) >= 1)) return void invalid.push({ line, reason: "round must be a whole number from 1" });
    const pr = o.pr;
    if (pr !== undefined && !(Number.isInteger(pr) || (pr && typeof pr === "object" && Number.isInteger((pr as { number?: unknown }).number)))) return void invalid.push({ line, reason: "pr must be a number or { number, url }" });
    items.push({ line, key: o.key, ...(o.cardId ? { cardId: o.cardId as string } : {}), ...(pr !== undefined ? { pr: pr as ImportItem["pr"] } : {}), ...(o.sha ? { sha: o.sha as string } : {}), ...(o.round !== undefined ? { round: o.round as number } : {}) });
  });
  return { items, invalid };
}

export interface ImportDeps {
  cards: TaskCard[];
  /** The GitHub `org/repo` of a card's checkout, to build a PR url. */
  prUrlFor: (card: TaskCard, number: number) => Promise<string | undefined>;
  setKey: (card: TaskCard, key: string, workstreamId: string) => Promise<void>;
  setRound: (card: TaskCard, round: number) => Promise<void>;
  setPr: (card: TaskCard, pr: TaskPullRequest) => Promise<void>;
}

/** Matches and (unless dry-run) records the work items. */
export async function importItems(ws: Workstream, items: Array<ImportItem & { line: number }>, dryRun: boolean, deps: ImportDeps): Promise<Pick<ImportReport, "matched" | "unmatched" | "conflicts">> {
  const out: Pick<ImportReport, "matched" | "unmatched" | "conflicts"> = { matched: [], unmatched: [], conflicts: [] };
  const live = deps.cards.filter((c) => !c.archivedAt && !c.supersededBy);
  for (const item of items) {
    const card = item.cardId ? live.find((c) => c.id === item.cardId) : live.find((c) => c.key === item.key && c.workstreamId === ws.id);
    if (!card) {
      out.unmatched.push({ key: item.key, reason: item.cardId ? `no live card ${item.cardId}` : "no live card in this workstream has this key; import creates nothing" });
      continue;
    }
    if (card.workstreamId && card.workstreamId !== ws.id) {
      out.conflicts.push({ key: item.key, cardId: card.id, reason: "the card belongs to another workstream" });
      continue;
    }
    const lineage = card.reviewLineageId ?? card.id;
    const taken = live.find((c) => c.id !== card.id && c.key === item.key && c.workstreamId === ws.id && (c.reviewLineageId ?? c.id) !== lineage);
    if (taken) {
      out.conflicts.push({ key: item.key, cardId: card.id, reason: `key ${item.key} is already used by "${taken.title}" in this workstream` });
      continue;
    }
    if (card.key && card.key !== item.key) {
      out.conflicts.push({ key: item.key, cardId: card.id, reason: `the card already has key ${card.key}` });
      continue;
    }
    const prNumber = typeof item.pr === "number" ? item.pr : item.pr?.number;
    if (prNumber !== undefined && card.pr && card.pr.number !== prNumber) {
      out.conflicts.push({ key: item.key, cardId: card.id, reason: `the card already has PR #${card.pr.number}` });
      continue;
    }
    const set: string[] = [];
    if (card.key !== item.key || card.workstreamId !== ws.id) set.push("key");
    if (item.round !== undefined && card.round !== item.round) set.push("round");
    let pr: TaskPullRequest | undefined;
    if (prNumber !== undefined && !card.pr) {
      const url = (typeof item.pr === "object" && item.pr.url?.startsWith("https://") ? item.pr.url : undefined) ?? (await deps.prUrlFor(card, prNumber));
      if (!url || !item.sha) {
        out.conflicts.push({ key: item.key, cardId: card.id, reason: !item.sha ? `PR #${prNumber} needs the full head sha (sha)` : `can't tell PR #${prNumber}'s url; give pr as { number, url }` });
        continue;
      }
      pr = { number: prNumber, url, head: item.sha };
      set.push("pr");
    }
    if (!dryRun) {
      if (set.includes("key")) await deps.setKey(card, item.key, ws.id);
      if (set.includes("round")) await deps.setRound(card, item.round!);
      if (pr) await deps.setPr(card, pr);
    }
    out.matched.push({ key: item.key, cardId: card.id, set });
  }
  return out;
}
