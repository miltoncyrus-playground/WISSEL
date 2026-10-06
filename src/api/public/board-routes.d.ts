// Type declaration for board-routes.js — a plain browser script (no
// build step, see its own header comment) that's also imported directly
// by bun test. Kept in sync by hand; the .js file is the source of truth
// for behavior.
export interface BoardRouteDef {
  page: string;
  nav: string | null;
  boardView?: "lanes" | "features";
}

export type NewDrawerTab = "task" | "pipeline";

export const BOARD_ROUTES: Record<string, BoardRouteDef>;

export const BOARD_ROUTE_REDIRECTS: Record<string, { to: string; openNew: NewDrawerTab }>;

export function parseBoardRoute(
  hash: string | null | undefined,
): { route: string; known: boolean; redirected?: true; openNew?: NewDrawerTab };

export function boardRouteHash(route: string): string;
