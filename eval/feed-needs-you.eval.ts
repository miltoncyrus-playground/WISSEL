#!/usr/bin/env bun
/**
 * Live eval for the feed's needs-you placement (src/services/feed.ts):
 * every card that needs Milton opens page 1 of GET /feed, however long
 * it has waited, and never shows up again on a later page.
 *
 * Why this exists: needs-you items were dated by their latest result's
 * finish time, so on 2026-10-30 five review cards that had waited 7 to
 * 10 days sat on page 2 of the app's feed, under a week of podcast and
 * checks items. test/feed.test.ts pins the paging shape with a built
 * board; this checks the real board through the running server.
 *
 * Expected set: the server's own needsYouAction over GET /tasks (not a
 * re-implementation), with GET /harnesses for the switched-off ones.
 * Reads WISSEL_URL (default http://localhost:8787). Zero spend.
 * Exits 0 with a SKIP when nothing needs Milton.
 *
 * Pass bar: 100% of needs-you cards on page 1 (default page size), all
 * ahead of every other item, and 0 of them on page 2.
 */
import { needsYouAction, type FeedPage } from "../src/services/feed.ts";
import type { TaskCard } from "../src/core/types.ts";

const BASE = process.env.WISSEL_URL ?? "http://localhost:8787";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return (await res.json()) as T;
}

const tasksBody = await get<TaskCard[] | { tasks: TaskCard[] }>("/tasks");
const tasks = Array.isArray(tasksBody) ? tasksBody : tasksBody.tasks;
const harnessBody = await get<{ id: string; enabled: boolean }[] | { harnesses: { id: string; enabled: boolean }[] }>("/harnesses");
const harnesses = Array.isArray(harnessBody) ? harnessBody : harnessBody.harnesses;
const disabled = new Set(harnesses.filter((h) => !h.enabled).map((h) => h.id));

// A failed pipeline step is told by its run's root (buildFeed skips
// cards with a pipelineRunId), so the expected set skips them too.
const expected = tasks.filter((t) => t.pipelineRunId === undefined && needsYouAction(t, disabled)).map((t) => `needs-you:${t.id}`);
if (expected.length === 0) {
  console.log("SKIP: nothing needs you on the live board");
  process.exit(0);
}

const page1 = await get<FeedPage>("/feed");
const page2 = page1.next ? await get<FeedPage>(`/feed?before=${encodeURIComponent(page1.next)}`) : { items: [], next: null };
const ids1 = page1.items.map((i) => i.id);
const lastNeedsYou = Math.max(...ids1.map((id, i) => (id.startsWith("needs-you:") ? i : -1)));
const firstOther = ids1.findIndex((id) => !id.startsWith("needs-you:"));

const checks = [
  { name: `all ${expected.length} needs-you card(s) on page 1`, pass: expected.every((id) => ids1.includes(id)), detail: expected.filter((id) => !ids1.includes(id)).join(", ") },
  { name: "needs-you items come before every other item", pass: firstOther === -1 || lastNeedsYou < firstOther, detail: `last needs-you at ${lastNeedsYou}, first other at ${firstOther}` },
  { name: "none repeated on page 2", pass: !page2.items.some((i) => i.kind === "needs-you"), detail: page2.items.filter((i) => i.kind === "needs-you").map((i) => i.id).join(", ") },
];

for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.pass ? "" : `: ${c.detail}`}`);
const pass = checks.every((c) => c.pass);
console.log(`Overall: ${pass ? "PASS" : "FAIL"} (threshold: all ${checks.length} checks)`);
if (!pass) process.exit(1);
