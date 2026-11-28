#!/usr/bin/env bun
/**
 * The replay eval (docs/SDD-coordinator.md §8): a recorded day runs
 * through Wissel in Shadow, and its would-records are compared with what
 * the team's coordinator did. Target: at least 95% agreement on
 * ready-to-merge, zero would-be hard-limit violations. No agent runs and
 * nothing is posted.
 *
 *   bun run eval:replay                                   # the invented example day
 *   bun run eval:replay <day.jsonl> <coordinator.json>    # a recorded day
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDay, runReplay, type CoordinatorRecord } from "../src/services/replay.ts";
import { evalHarnessPool } from "./eval-harness.ts";

const dayPath = process.argv[2] ?? join(import.meta.dir, "fixtures", "replay-day.jsonl");
const expectedPath = process.argv[3] ?? join(import.meta.dir, "fixtures", "replay-day.expected.json");
const report = await runReplay(parseDay(readFileSync(dayPath, "utf8")), JSON.parse(readFileSync(expectedPath, "utf8")) as CoordinatorRecord, await evalHarnessPool(null));
console.log(JSON.stringify(report, null, 2));
console.log(`ready-to-merge agreement ${(report.readyToMergeAgreement * 100).toFixed(0)}% (target 95%), hard-limit violations ${report.hardLimitViolations} (target 0): ${report.pass ? "PASS" : "FAIL"}`);
process.exit(report.pass ? 0 : 1);
