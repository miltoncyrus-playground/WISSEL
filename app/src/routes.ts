// Hash routes (docs/SDD-wissel-app.md §3.1): `#/feed`, `#/ask`,
// `#/board`, `#/board/<task id>`, `#/listen`, `#/you`. No router
// dependency; App listens to `hashchange` and calls parseRoute.

export type ScreenId = "feed" | "ask" | "board" | "listen" | "you" | "coordinator";

export interface Screen {
  id: ScreenId;
  label: string;
}

/** Tab order, left to right on the phone tab bar and top to bottom on
 *  the desktop rail. */
export const SCREENS: readonly Screen[] = [
  { id: "feed", label: "Feed" },
  { id: "ask", label: "Ask" },
  { id: "board", label: "Board" },
  { id: "listen", label: "Listen" },
  { id: "you", label: "You" },
];

/** Where `/app` with no hash (or an unknown one) lands: the app is
 *  chat-first. */
export const DEFAULT_SCREEN: ScreenId = "ask";

export interface Route {
  screen: ScreenId;
  /** `#/board/<id>`: a card opened from the Board tab or the palette. */
  taskId?: string;
  /** `#/coordinator/<id>`: one workstream's coordinator window
   *  (docs/SDD-coordinator.md §4.14). Not a tab: reached from the rail,
   *  You and the palette. */
  workstreamId?: string;
  /** False when the hash named nothing we know and we fell back. */
  known: boolean;
}

function isScreen(s: string): s is ScreenId {
  return SCREENS.some((x) => x.id === s);
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return { screen: DEFAULT_SCREEN, known: true };
  const [head, ...rest] = path.split("/");
  if (head === "coordinator") {
    if (rest.length === 0) return { screen: "coordinator", known: true };
    if (rest.length === 1) {
      try {
        const workstreamId = decodeURIComponent(rest[0]!);
        if (workstreamId) return { screen: "coordinator", workstreamId, known: true };
      } catch {
        // Bad percent-encoding: the list instead.
      }
    }
    return { screen: "coordinator", known: false };
  }
  if (!head || !isScreen(head)) return { screen: DEFAULT_SCREEN, known: false };
  if (rest.length === 0) return { screen: head, known: true };
  if (head === "board" && rest.length === 1) {
    try {
      const taskId = decodeURIComponent(rest[0]!);
      if (taskId) return { screen: "board", taskId, known: true };
    } catch {
      // Bad percent-encoding: fall through to the plain Board tab.
    }
  }
  return { screen: head, known: false };
}

/** `?embed=1`: the app shown inside the board's coordinator dock. */
export function isEmbedded(search: string): boolean {
  return new URLSearchParams(search).get("embed") === "1";
}

export function routeHash(route: { screen: ScreenId; taskId?: string; workstreamId?: string }): string {
  if (route.workstreamId) return `#/${route.screen}/${encodeURIComponent(route.workstreamId)}`;
  return route.taskId ? `#/${route.screen}/${encodeURIComponent(route.taskId)}` : `#/${route.screen}`;
}
