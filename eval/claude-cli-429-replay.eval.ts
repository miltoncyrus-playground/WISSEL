#!/usr/bin/env bun
/**
 * Replay eval for runClaude's 429 session-limit detection against REAL
 * captured stdout, not hand-written fixtures. Reads every failed
 * `task_results` row on the live board (`~/.wissel/board.sqlite`, or
 * `WISSEL_DB`) whose stored summary carries a claude-cli
 * `"api_error_status":429` payload, feeds that exact stdout back through
 * runClaude via a stub runner, and checks it now comes back as a
 * retriable `retryAfter` result instead of a plain failure.
 *
 * Why this exists: reviewer task 0d8a648c (2026-10-04) hit a 429 under
 * `stream-json`, but its result line was followed by trailing
 * `background_tasks_changed` / `task_updated` / `task_notification`
 * system lines. runClaude parsed only the last line, missed the 429, and
 * stranded the task on `failed`. test/claude-cli.test.ts pins that exact
 * shape; this eval proves the fix generalizes to every real 429 the
 * board has ever recorded, whatever shape its stdout took.
 *
 * Zero spend, no `claude` process — read-only against the board DB.
 * Not in the gate lane only because it depends on local board history.
 * Exits 0 with a SKIP when the board has no 429 rows to replay.
 *
 * Two classes of real 429, each checked against its own contract:
 *   - session-limit 429s whose result text states a reset time
 *     ("resets 3:10pm (UTC)", "resets 1am (UTC)") MUST yield `retryAfter`;
 *   - account rate-limit 429s with no stated reset time ("This request
 *     would exceed your account's rate limit") MUST NOT — runClaude never
 *     guesses a retry time (see parse-session-limit-reset.ts).
 *
 * Pass bar: 100% of replayed rows match their class's contract.
 */
import { Database } from "bun:sqlite";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runClaude } from "../src/executors/claude-cli.ts";
import type { AgentDef, TaskCard } from "../src/core/types.ts";

const PASS_THRESHOLD = 1.0;
const DB_PATH = process.env.WISSEL_DB ?? join(homedir(), ".wissel", "board.sqlite");
const PREFIX = /^claude exited \d+: /;

const agent: AgentDef = {
  id: "replay",
  name: "Replay",
  kind: "agent",
  tier: "readonly",
  description: "429 replay stub",
  whenToUse: "never",
  tags: [],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "medium",
  toolAccess: ["read"],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0 },
};

const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .query(`select taskId, summary from task_results where ok = 0 and summary like '%"api_error_status":429%'`)
  .all() as { taskId: string; summary: string }[];
db.close();

if (rows.length === 0) {
  console.log(`SKIP: no 429 failures recorded in ${DB_PATH}`);
  process.exit(0);
}

let matched = 0;
for (const row of rows) {
  const stdout = row.summary.replace(PREFIX, "");
  const task: TaskCard = { id: row.taskId, title: "replay", body: "", labels: [], repo: "/tmp", status: "ready" };
  const result = await runClaude({
    runner: async () => ({ stdout, stderr: "", exitCode: 1 }),
    task,
    agent,
    permissionMode: "plan",
    memoryPath: join(tmpdir(), "wissel-429-replay-no-memory.md"),
  });
  // Class comes from the result text itself, matched loosely ("resets"
  // followed by a clock time) so a reset-text shape the parser doesn't
  // handle yet still lands in the must-retry class and fails loudly.
  const statesReset = /"result":"[^"]*resets\s+\d{1,2}(:\d{2})?\s*(am|pm)/i.test(stdout);
  const pass = statesReset === (result.retryAfter !== undefined);
  if (pass) matched++;
  const cls = statesReset ? "session-limit (must retry)" : "rate-limit, no reset (must fail)";
  console.log(`${pass ? "PASS" : "FAIL"}  ${row.taskId}  ${cls}  ${result.retryAfter ? `retryAfter=${result.retryAfter}` : result.summary.slice(0, 80)}`);
}

const rate = matched / rows.length;
console.log(`\n429 contract match: ${matched}/${rows.length} (${(rate * 100).toFixed(0)}%), threshold ${PASS_THRESHOLD * 100}%`);
console.log(`OVERALL: ${rate >= PASS_THRESHOLD ? "PASS" : "FAIL"}`);
process.exit(rate >= PASS_THRESHOLD ? 0 : 1);
