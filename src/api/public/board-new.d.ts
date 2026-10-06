// Type declaration for board-new.js — a plain browser script (no build
// step, see its own header comment) that's also imported directly by bun
// test. Kept in sync by hand; the .js file is the source of truth for
// behavior.
import type { TaskCard } from "../../core/types.ts";

type SearchTask = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;

export const CARD_SEARCH_LIMIT: number;

export function isLiveCard(t: SearchTask | null | undefined): boolean;

export function searchLiveCards<T extends SearchTask>(
  tasks: T[] | null | undefined,
  query: string | null | undefined,
  opts?: { exclude?: string[]; routedOnly?: boolean; limit?: number },
): T[];
