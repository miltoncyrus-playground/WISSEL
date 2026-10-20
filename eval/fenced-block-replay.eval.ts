#!/usr/bin/env bun
/**
 * Replay eval for lastFencedBlock (src/executors/fenced-block.ts) against
 * REAL agent output, not hand-written fixtures. Reads every
 * `task_results` row on the live board (`~/.wissel/board.sqlite`, or
 * `WISSEL_DB`) whose stored text carries a ```review-verdict,
 * ```pipeline-handoff or ```mcp-approval-request block, and runs it
 * through both the old non-greedy regex parse and the new parser.
 *
 * Why this exists: reviewer 093d0f69 (2026-10-20) approved, but its
 * feedback quoted "``` still leaving exactly one closing fence". The old
 * `/```review-verdict\s*\n([\s\S]*?)```/g` stopped at that inner fence,
 * JSON.parse failed, the run was recorded as a contract violation and
 * the card it reviewed sat in pending-review with two cards queued
 * behind it. test/fenced-block.test.ts pins that shape; this proves the
 * fix generalizes to every block the board has recorded, and that it
 * changes nothing that already parsed.
 *
 * Stored text per row: a successful pipeline step's `summary` is its raw
 * final message (handoff block included); a contract violation's summary
 * carries the raw message after ", got: ". A successful review's summary
 * is the parsed feedback, so it has no block and is skipped.
 *
 * Zero spend, no `claude` process, read-only against the board DB.
 * Not in the gate lane only because it depends on local board history.
 * Exits 0 with a SKIP when the board has no blocks to replay.
 *
 * Pass bar: 0 regressions (every block the old parse read gives the same
 * JSON under the new one) and every contract violation whose stored
 * message holds a complete, valid block now parses (0 still failing).
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { lastFencedBlock } from "../src/executors/fenced-block.ts";

const DB_PATH = process.env.WISSEL_DB ?? join(homedir(), ".wissel", "board.sqlite");
const TAGS = ["review-verdict", "pipeline-handoff", "mcp-approval-request"] as const;
const VIOLATION = "violated its output contract";

function oldParse(raw: string, tag: string): unknown {
  const re = new RegExp("```" + tag + "\\s*\\n([\\s\\S]*?)```", "g");
  const m = [...raw.matchAll(re)];
  if (m.length === 0) return undefined;
  try { return JSON.parse(m.at(-1)![1]!.trim()); } catch { return undefined; }
}

function newParse(raw: string, tag: string): unknown {
  const body = lastFencedBlock(raw, tag);
  if (body === null) return undefined;
  try { return JSON.parse(body.trim()); } catch { return undefined; }
}

const db = new Database(DB_PATH, { readonly: true });
const rows = db.query("SELECT taskId, summary FROM task_results WHERE summary LIKE '%```%'").all() as { taskId: string; summary: string }[];

let replayed = 0, unchanged = 0, newlyParsed = 0;
const regressions: string[] = [];
const stillFailing: string[] = [];
const fixed: string[] = [];

for (const row of rows) {
  const isViolation = row.summary.includes(VIOLATION);
  const raw = isViolation ? row.summary.split(", got: ").slice(1).join(", got: ") : row.summary;
  for (const tag of TAGS) {
    if (!raw.includes("```" + tag)) continue;
    replayed++;
    const before = oldParse(raw, tag);
    const after = newParse(raw, tag);
    const id = `${row.taskId.slice(0, 8)} ${tag}`;
    if (before !== undefined) {
      if (JSON.stringify(before) === JSON.stringify(after)) unchanged++;
      else regressions.push(id);
    } else if (after !== undefined) {
      newlyParsed++;
      if (isViolation) fixed.push(id);
    } else if (isViolation && raw.trimEnd().endsWith("```")) {
      // A complete block (message ends with a closing fence) that still
      // doesn't parse: a real malformed block, or a parser gap.
      stillFailing.push(id);
    }
  }
}

if (replayed === 0) {
  console.log(`SKIP: no fenced blocks in ${DB_PATH}`);
  process.exit(0);
}

console.log(`Replayed ${replayed} block(s) from ${rows.length} row(s) in ${DB_PATH}`);
console.log(`  unchanged:      ${unchanged}`);
console.log(`  newly parsed:   ${newlyParsed} (contract violations now readable: ${fixed.join(", ") || "none"})`);
console.log(`  regressions:    ${regressions.length}${regressions.length ? ` [${regressions.join(", ")}]` : ""}`);
console.log(`  still failing:  ${stillFailing.length}${stillFailing.length ? ` [${stillFailing.join(", ")}]` : ""}`);
const pass = regressions.length === 0 && stillFailing.length === 0;
console.log(`Overall: ${pass ? "PASS" : "FAIL"} (threshold: 0 regressions, 0 complete violation blocks still unreadable)`);
if (!pass) process.exit(1);
