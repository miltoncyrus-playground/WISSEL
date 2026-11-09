// Hash routes (docs/SDD-wissel-app.md §3.1): `#/feed`, `#/ask`,
// `#/board`, `#/board/<task id>`, `#/listen`, `#/you`. No router
// dependency; App listens to `hashchange` and calls parseRoute.

/** `window` is the coordinator window (docs/SDD-coordinator.md §4.14):
 *  `#/window/<workstream id>`, reached from the board's dock, not a tab. */
export type ScreenId = "feed" | "ask" | "board" | "listen" | "you" | "window";

export interface Screen {
  /** The tabs; the window has no tab or icon. */
  id: Exclude<ScreenId, "window">;
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
  /** `#/window/<id>`: one workstream's coordinator window. */
  workstreamId?: string;
  /** False when the hash named nothing we know and we fell back. */
  known: boolean;
}

function isScreen(s: string): s is ScreenId {
  return s === "window" || SCREENS.some((x) => x.id === s);
}

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (!path) return { screen: DEFAULT_SCREEN, known: true };
  const [head, ...rest] = path.split("/");
  if (!head || !isScreen(head)) return { screen: DEFAULT_SCREEN, known: false };
  if (rest.length === 0) return { screen: head, known: true };
  if ((head === "board" || head === "window") && rest.length === 1) {
    try {
      const id = decodeURIComponent(rest[0]!);
      if (id) return head === "board" ? { screen: "board", taskId: id, known: true } : { screen: "window", workstreamId: id, known: true };
    } catch {
      // Bad percent-encoding: fall through to the plain tab.
    }
  }
  return { screen: head, known: false };
}

export function routeHash(route: { screen: ScreenId; taskId?: string; workstreamId?: string }): string {
  const id = route.taskId ?? route.workstreamId;
  return id ? `#/${route.screen}/${encodeURIComponent(id)}` : `#/${route.screen}`;
}
