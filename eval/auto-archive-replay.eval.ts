#!/usr/bin/env bun
/**
 * Replay eval for auto-archive (findArchivableRoots,
 * src/core/archive-scheduler.ts) against the REAL board, read-only:
 * what would the next tick archive, and would any of it be a card that
 * still has work or a decision pending?
 *
 * Why this exists: on 2026-10-30, the first tick after
 * WISSEL_AUTO_ARCHIVE=1 archived four live cards (two in review, two in
 * inbox). Their planner roots had been `done` for days, and the cascade
 * took every descendant regardless of status. test/archive-scheduler.test.ts
 * pins that shape; this checks the rule over every root the live board
 * has, and reports what the old rule would have swept as the contrast.
 *
 * Reads `~/.wissel/board.sqlite` (or WISSEL_DB) through SqliteBoard's
 * own list(), opened read-only. Archives nothing. Zero spend.
 *
 * Pass bar: 0 unsettled cards (not done, not superseded, not archived)
 * in the subtree of any root the rule would archive.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_ARCHIVE_AFTER_HOURS, findArchivableRoots } from "../src/core/archive-scheduler.ts";
import type { TaskCard } from "../src/core/types.ts";

const DB_PATH = process.env.WISSEL_DB ?? join(homedir(), ".wissel", "board.sqlite");
const db = new Database(DB_PATH, { readonly: true });
const rows = db.query("SELECT id, title, status, parentTaskId, supersededBy, doneAt, archivedAt FROM tasks").all() as Record<string, string | null>[];
const tasks = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null))) as unknown as TaskCard[];

const children = new Map<string, TaskCard[]>();
for (const t of tasks) if (t.parentTaskId) children.set(t.parentTaskId, [...(children.get(t.parentTaskId) ?? []), t]);
const subtree = (root: TaskCard): TaskCard[] => {
  const out: TaskCard[] = [];
  const stack = [...(children.get(root.id) ?? [])];
  const seen = new Set([root.id]);
  while (stack.length) {
    const t = stack.pop()!;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    stack.push(...(children.get(t.id) ?? []));
  }
  return out;
};
const unsettled = (t: TaskCard) => t.status !== "done" && !t.supersededBy && !t.archivedAt;

const now = new Date();
const roots = findArchivableRoots(tasks, now);
const swept = roots.flatMap((r) => subtree(r).filter(unsettled).map((t) => ({ root: r, t })));

// The pre-2026-10-30 rule: old-enough done roots, no subtree check.
const oldRoots = tasks.filter((t) => !t.parentTaskId && t.status === "done" && t.doneAt && !t.archivedAt && now.getTime() - new Date(t.doneAt).getTime() >= AUTO_ARCHIVE_AFTER_HOURS * 3_600_000);
const oldSwept = oldRoots.flatMap((r) => subtree(r).filter(unsettled));
const held = oldRoots.filter((r) => !roots.includes(r));

console.log(`Board: ${tasks.length} cards in ${DB_PATH}`);
console.log(`  next tick would archive: ${roots.length} root(s), ${roots.reduce((n, r) => n + 1 + subtree(r).filter((t) => !t.archivedAt).length, 0)} card(s)`);
console.log(`  roots held (something under them is still live): ${held.length}`);
for (const r of held) console.log(`    ${r.id.slice(0, 8)} ${r.title.slice(0, 60)}  <- ${subtree(r).filter(unsettled).map((t) => `${t.id.slice(0, 8)}:${t.status}`).join(", ")}`);
console.log(`  old rule would have swept ${oldSwept.length} live card(s)${oldSwept.length ? `: ${oldSwept.map((t) => `${t.id.slice(0, 8)}:${t.status}`).join(", ")}` : ""}`);
const pass = swept.length === 0;
console.log(`${pass ? "PASS" : "FAIL"}  live cards the rule would archive: ${swept.length}${swept.length ? ` [${swept.map((s) => `${s.t.id.slice(0, 8)}:${s.t.status} under ${s.root.id.slice(0, 8)}`).join(", ")}]` : ""}`);
console.log(`Overall: ${pass ? "PASS" : "FAIL"} (threshold: 0 live cards archived)`);
if (!pass) process.exit(1);
