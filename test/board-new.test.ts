import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { CARD_SEARCH_LIMIT, isLiveCard, searchLiveCards } from "../src/api/public/board-new.js";
import type { TaskCard } from "../src/core/types.ts";

// docs/SDD-ui-cleanup.md §3.3 (card A3): the "+ New" drawer's live-card
// search behind "Depends on" and "Follow-up of".

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

type T = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
let seq = 0;
// Arrays below are in GET /tasks order: oldest first.
function card(over: Partial<T> = {}): T {
  seq++;
  return { id: `t${seq}`, title: `Card ${seq}`, status: "ready", ...over } as T;
}

test("live means not done, not archived and not superseded; every other status is live", () => {
  expect(isLiveCard(card({ status: "done" }))).toBe(false);
  expect(isLiveCard(card({ archivedAt: "2026-10-01T00:00:00Z" }))).toBe(false);
  expect(isLiveCard(card({ supersededBy: "x" }))).toBe(false);
  for (const status of ["inbox", "ready", "running", "dispatched", "pending-review", "review", "escalated", "failed", "no-match"] as const) {
    expect(isLiveCard(card({ status }))).toBe(true);
  }
  expect(isLiveCard(null)).toBe(false);
  expect(isLiveCard(undefined)).toBe(false);
});

// The bug this card fixes: "Depends on" listed every stale
// pending-review card, and done/archived/superseded ones besides.
test("search never offers a done, archived or superseded card, even on an exact title match", () => {
  const live = card({ title: "Fix login redirect" });
  const tasks = [
    card({ title: "Fix login redirect", status: "done" }),
    card({ title: "Fix login redirect", archivedAt: "2026-10-01T00:00:00Z" }),
    card({ title: "Fix login redirect", supersededBy: live.id }),
    live,
  ];
  expect(searchLiveCards(tasks, "Fix login redirect").map((t) => t.id)).toEqual([live.id]);
});

test("every query word must match title, id, status or routed agent, case-insensitively", () => {
  const a = card({ title: "Fix the login redirect" });
  const b = card({ title: "Login page copy", routedTo: "planner" });
  const c = card({ title: "Unrelated", status: "escalated" });
  const tasks = [a, b, c];
  expect(searchLiveCards(tasks, "fix LOGIN").map((t) => t.id)).toEqual([a.id]);
  expect(searchLiveCards(tasks, "login").map((t) => t.id)).toEqual([b.id, a.id]);
  expect(searchLiveCards(tasks, "planner").map((t) => t.id)).toEqual([b.id]);
  expect(searchLiveCards(tasks, "escalated").map((t) => t.id)).toEqual([c.id]);
  expect(searchLiveCards(tasks, c.id).map((t) => t.id)).toEqual([c.id]);
  expect(searchLiveCards(tasks, "login nothing")).toEqual([]);
});

test("an empty query lists live cards newest first, capped at the limit", () => {
  const tasks = Array.from({ length: CARD_SEARCH_LIMIT + 3 }, () => card());
  const hits = searchLiveCards(tasks, "   ");
  expect(hits).toHaveLength(CARD_SEARCH_LIMIT);
  expect(hits[0]!.id).toBe(tasks[tasks.length - 1]!.id);
  expect(searchLiveCards(tasks, "", { limit: 2 }).map((t) => t.id)).toEqual([tasks[tasks.length - 1]!.id, tasks[tasks.length - 2]!.id]);
});

test("the limit counts only matches: older matching cards still surface past skipped ones", () => {
  const old = card({ title: "needle" });
  const noise = Array.from({ length: CARD_SEARCH_LIMIT * 2 }, () => card({ status: "done" }));
  expect(searchLiveCards([old, ...noise], "needle").map((t) => t.id)).toEqual([old.id]);
});

test("exclude drops cards already picked; routedOnly drops cards never routed", () => {
  const a = card({ routedTo: "triager" });
  const b = card();
  const c = card({ routedTo: "planner" });
  expect(searchLiveCards([a, b, c], "", { exclude: [c.id] }).map((t) => t.id)).toEqual([b.id, a.id]);
  expect(searchLiveCards([a, b, c], "", { routedOnly: true }).map((t) => t.id)).toEqual([c.id, a.id]);
});

test("null or missing inputs return nothing rather than throwing", () => {
  expect(searchLiveCards(null, "x")).toEqual([]);
  expect(searchLiveCards(undefined, undefined)).toEqual([]);
  expect(searchLiveCards([card({ title: undefined })], "")).toHaveLength(1);
});

// Markup: the New task form now lives in the drawer, not in a page.
test("board.html holds both New forms in the #newDrawer dialog, and neither is a [data-page]", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const drawer = html.slice(html.indexOf('<aside class="drawer new-drawer" id="newDrawer"'), html.indexOf("</aside>", html.indexOf('id="newDrawer"')));
  expect(drawer.length).toBeGreaterThan(0);
  for (const id of ["newTabTask", "newTabPipeline", "newTaskPanel", "newTaskForm", "newPipelinePanel", "pipelineRunForm", "prPipeline", "prRepo", "prInput", "ntDependsSearch", "ntParentSearch", "ntParentTask"]) {
    expect(drawer).toContain(`id="${id}"`);
  }
  expect(html).not.toMatch(/id="newTaskPanel"[^>]*data-page/);
  expect(html).not.toContain('id="ntDependsOn"');
  // Both repo fields share the one project-aware datalist.
  expect(drawer).toContain('<input id="ntRepo" type="text" required list="ntRepoList"');
  expect(drawer).toContain('<input id="prRepo" type="text" required list="ntRepoList"');
});

test("board.html loads board-new.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-new.js"></script>');
  expect(tag).toBeGreaterThan(-1);
  expect(tag).toBeLessThan(html.indexOf("function createCardSearch("));
});

test("GET /board-new.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
  const res = await app(new Request("http://localhost/board-new.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function searchLiveCards(");
});
