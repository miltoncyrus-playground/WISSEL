import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { TaskCard } from "../src/core/types.ts";
import {
  BOARD_LANES,
  DONE_WINDOW_MS,
  NEEDS_YOU,
  STATUS_DISPLAY,
  needsYouReason,
  partitionBoard,
  statusColor,
  statusLabel,
  taskDisplayStatus,
  taskPlacement,
} from "../src/api/public/board-lanes.js";

// docs/SDD-ui-cleanup.md §3.2 (card A2): the board's one status→lane
// table and where each card goes.

const TYPES_PATH = join(import.meta.dir, "..", "src", "core", "types.ts");
const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

/** TaskCard.status's literal union, read from the source so a value
 *  added to types.ts shows up here without anyone editing this test. */
async function taskStatusValues(): Promise<string[]> {
  const src = await readFile(TYPES_PATH, "utf8");
  const card = src.slice(src.indexOf("export interface TaskCard {"));
  const m = /\n\s*status:\s*([^;]+);/.exec(card);
  if (!m) throw new Error("TaskCard.status not found in src/core/types.ts");
  const values = [...m[1]!.matchAll(/"([^"]+)"/g)].map((v) => v[1]!);
  if (values.length === 0) throw new Error("TaskCard.status has no string literals");
  return values;
}

// Injected clock: partitionBoard takes `now`, never reads Date.now() here.
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

let seq = 0;
function card(status: TaskCard["status"], extra: Partial<TaskCard> = {}): TaskCard {
  seq++;
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    body: "",
    labels: [],
    status,
    ...extra,
  };
}

test("every TaskCard.status value maps to exactly one lane or to Needs you", async () => {
  const laneIds = new Set<string>(BOARD_LANES.map((l) => l.id));
  const statuses = await taskStatusValues();
  // Sanity: the parser found the real union, not a fragment of it.
  expect(statuses).toContain("inbox");
  expect(statuses).toContain("escalated");
  for (const status of statuses) {
    const def = STATUS_DISPLAY[status];
    expect(def, `STATUS_DISPLAY has no entry for "${status}" (src/api/public/board-lanes.js)`).toBeDefined();
    // One string, so "exactly one" holds by construction; it must be a
    // real destination.
    expect(def!.lane === NEEDS_YOU || laneIds.has(def!.lane), `"${status}" maps to unknown lane "${def!.lane}"`).toBe(true);
    expect(def!.label.length).toBeGreaterThan(0);
    expect(def!.color).toMatch(/^--/);
    // And a card with that status actually lands there.
    expect(taskPlacement(card(status as TaskCard["status"]))).toBe(def!.lane);
  }
});

test("STATUS_DISPLAY has no entry beyond TaskCard.status except the display-only 'reviewing'", async () => {
  const statuses = new Set(await taskStatusValues());
  const extra = Object.keys(STATUS_DISPLAY).filter((s) => !statuses.has(s));
  expect(extra).toEqual(["reviewing"]);
});

test("the lanes and Needs you statuses match the SDD's table", () => {
  expect(BOARD_LANES.map((l) => [l.id, l.label])).toEqual([
    ["queued", "Queued"],
    ["working", "Working"],
    ["in-review", "In review"],
    ["done", "Done"],
  ]);
  const byLane: Record<string, string[]> = {};
  for (const [status, def] of Object.entries(STATUS_DISPLAY)) (byLane[def.lane] ??= []).push(status);
  for (const list of Object.values(byLane)) list.sort();
  expect(byLane).toEqual({
    queued: ["inbox", "ready"],
    working: ["dispatched", "reviewing", "running"],
    "in-review": ["pending-review"],
    done: ["done"],
    [NEEDS_YOU]: ["escalated", "failed", "no-match", "review"],
  });
});

test("a reviewer's running task displays as 'reviewing'; everything else displays its own status", () => {
  expect(taskDisplayStatus(card("running", { routedTo: "reviewer" }))).toBe("reviewing");
  expect(taskDisplayStatus(card("running", { routedTo: "implementer" }))).toBe("running");
  expect(taskDisplayStatus(card("done", { routedTo: "reviewer" }))).toBe("done");
  expect(statusLabel("reviewing")).toBe("Reviewing");
  expect(statusLabel("pending-review")).toBe("Pending review");
  expect(statusColor("failed")).toBe("--critical");
});

test("an unknown status goes to Needs you instead of vanishing", () => {
  const odd = card("inbox", { status: "made-up" as TaskCard["status"] });
  expect(taskPlacement(odd)).toBe(NEEDS_YOU);
  expect(partitionBoard([odd], { now: NOW }).needsYou).toEqual([odd]);
  expect(statusLabel("made-up")).toBe("made-up");
  expect(statusColor("made-up")).toBe("--ink-muted");
  // Not fooled by Object.prototype keys.
  const proto = card("inbox", { status: "constructor" as TaskCard["status"] });
  expect(taskPlacement(proto)).toBe(NEEDS_YOU);
  expect(partitionBoard([proto], { now: NOW }).needsYou).toEqual([proto]);
});

test("a pending MCP approval is in Needs you with the call named; a resolved one isn't", () => {
  const req = { server: "slack", tool: "send_message", args: {}, reason: "notify" };
  const pending = card("review", { pendingMcpApproval: req });
  expect(taskPlacement(pending)).toBe(NEEDS_YOU);
  expect(needsYouReason(pending)).toBe("MCP approval: slack · send_message");
  // pendingMcpApproval is never cleared; status leaving review resolves it.
  const approved = card("done", { pendingMcpApproval: req, doneAt: new Date(NOW).toISOString() });
  expect(taskPlacement(approved)).toBe("done");
  const denied = card("failed", { pendingMcpApproval: req });
  expect(needsYouReason(denied)).toBe("failed");
});

test("each Needs you card says why it's there", () => {
  expect(needsYouReason(card("review"))).toBe("review");
  // 5 pushbacks then the 6th rejection escalates (resumeAfterReviewVerdict).
  expect(needsYouReason(card("escalated", { pushbackCount: 5 }))).toBe("escalated after 6 rejections");
  expect(needsYouReason(card("escalated", { pushbackCount: 0 }))).toBe("escalated after 1 rejection");
  expect(needsYouReason(card("escalated"))).toBe("escalated");
  expect(needsYouReason(card("failed"))).toBe("failed");
  expect(needsYouReason(card("no-match"))).toBe("no agent matched");
});

test("partitionBoard: Needs you statuses never land in a lane, and nothing shows twice", () => {
  const all = (Object.keys(STATUS_DISPLAY) as string[]).map((s) =>
    s === "reviewing" ? card("running", { routedTo: "reviewer" }) : card(s as TaskCard["status"], { doneAt: new Date(NOW).toISOString() }),
  );
  const parts = partitionBoard(all, { now: NOW });
  const inLanes = Object.values(parts.lanes).flat();
  const seen = [...parts.needsYou, ...inLanes].map((t) => t.id);
  expect(new Set(seen).size).toBe(seen.length);
  expect(seen.sort()).toEqual(all.map((t) => t.id).sort());
  expect(parts.needsYou.map((t) => t.status).sort()).toEqual(["escalated", "failed", "no-match", "review"]);
  for (const t of inLanes) expect(["review", "escalated", "failed", "no-match"]).not.toContain(t.status);
  expect(parts.lanes.working.map(taskDisplayStatus).sort()).toEqual(["dispatched", "reviewing", "running"]);
});

test("partitionBoard: archived cards never show; superseded cards only with showSuperseded, and never in Needs you or a lane", () => {
  const archived = card("failed", { archivedAt: new Date(NOW).toISOString() });
  const supFailed = card("failed", { supersededBy: "x" });
  const supPending = card("pending-review", { supersededBy: "y" });
  const supArchived = card("inbox", { supersededBy: "z", archivedAt: new Date(NOW).toISOString() });
  const live = card("inbox");
  const tasks = [archived, supFailed, supPending, supArchived, live];

  const hidden = partitionBoard(tasks, { now: NOW });
  expect(hidden.needsYou).toEqual([]);
  expect(hidden.lanes.queued).toEqual([live]);
  expect(hidden.lanes["in-review"]).toEqual([]);
  expect(hidden.superseded).toEqual([]);

  const shown = partitionBoard(tasks, { now: NOW, showSuperseded: true });
  expect(shown.superseded).toEqual([supFailed, supPending]);
  expect(shown.needsYou).toEqual([]);
  expect(shown.lanes["in-review"]).toEqual([]);
});

test("partitionBoard: Done shows the last 24h by default and everything with showAllDone", () => {
  const recent = card("done", { doneAt: new Date(NOW - 2 * HOUR).toISOString() });
  const edge = card("done", { doneAt: new Date(NOW - DONE_WINDOW_MS).toISOString() });
  const old = card("done", { doneAt: new Date(NOW - 30 * HOUR).toISOString() });
  // No doneAt (predates the field) or a bad one: shown rather than
  // silently hidden.
  const undated = card("done");
  const garbled = card("done", { doneAt: "not a date" });

  const def = partitionBoard([recent, edge, old, undated, garbled], { now: NOW });
  expect(def.lanes.done).toEqual([recent, edge, undated, garbled]);
  expect(def.doneTotal).toBe(5);
  expect(def.doneHidden).toBe(1);

  const all = partitionBoard([recent, edge, old, undated, garbled], { now: NOW, showAllDone: true });
  expect(all.lanes.done).toEqual([recent, edge, old, undated, garbled]);
  expect(all.doneHidden).toBe(0);
});

test("board.html has no leftover per-status tables and loads board-lanes.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  for (const name of ["STATUS_COLOR", "STATUS_LABEL", "COLUMNS", "taskDisplayColumn", "renderStats", 'id="stats"']) {
    expect(html, name).not.toContain(name);
  }
  const tag = html.indexOf('<script src="/board-lanes.js"></script>');
  expect(tag).toBeGreaterThan(-1);
  expect(tag).toBeLessThan(html.indexOf("function renderKanban("));
  expect(html).toContain("partitionBoard(tasks,");
});

test("GET /board-lanes.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
  const res = await app(new Request("http://localhost/board-lanes.js"));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("function partitionBoard(");
  expect(body).toContain("var STATUS_DISPLAY = {");
});
