#!/usr/bin/env bun
/**
 * Permission denials per write-tier run, before and after the Bash
 * sandbox (docs/SDD-write-tier-sandbox.md). Free and read-only.
 *
 *   bun run denials:baseline                       # implementer runs since 2026-10-03
 *   bun run denials:baseline --since 2026-10-17 --agent fixer
 *   bun run denials:baseline --fixtures <taskId>   # one run's refused commands, old vs new keys
 *   bun run denials:baseline --telemetry           # median raw denials by sandbox state
 *
 * The baseline reads each run's final result line from
 * ~/.wissel/task-output/<taskId>.jsonl (its raw `permission_denials`)
 * and counts them three ways: raw, distinct keys with the old
 * quote-blind split, distinct keys with today's commandKeys. The old
 * split inflated the key counts, so the raw count is the honest one.
 *
 * `--telemetry` reads the `denials`/`sandbox` fields the result event
 * carries from this change on: the after number.
 *
 * WISSEL_DB_PATH, WISSEL_TELEMETRY_PATH as for the server.
 */
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { summarizeDenials } from "../src/core/permission-denials.ts";

type Denial = { tool_name?: unknown; tool_input?: { command?: unknown } };

/** The raw permission_denials of the last `type: "result"` line of a
 *  run's JSONL output; undefined when it has none. */
export function denialsFromOutput(jsonl: string): Denial[] | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown; permission_denials?: unknown };
      if (parsed.type === "result") return Array.isArray(parsed.permission_denials) ? (parsed.permission_denials as Denial[]) : [];
    } catch {
      // partial line
    }
  }
  return undefined;
}

const RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);
const HELPERS = new Set(["cd", "ls", "cat", "echo", "pwd", "tail", "head", "grep", "wc", "sort", "true", "test", "["]);
const WRAPPERS: Record<string, number> = { timeout: 1, nice: 0, time: 0 };

/** commandKeys as it was before 2026-10-17, verbatim, kept only to
 *  measure how much its quote-blind split inflated the key counts. */
export function legacyCommandKeys(command: string): string[] {
  const keys: string[] = [];
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    let words = segment.trim().split(/\s+/).filter((w) => w && !/^\d?>/.test(w) && !w.startsWith("2>"));
    while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
    const wrapperArgs = words[0] !== undefined ? WRAPPERS[words[0]] : undefined;
    if (wrapperArgs !== undefined) words = words.slice(1 + wrapperArgs);
    const program = words[0];
    if (!program || HELPERS.has(program)) continue;
    const args = words.slice(1).filter((w, i, rest) => !w.startsWith("-") && !["--cwd", "--prefix", "-C"].includes(rest[i - 1] ?? ""));
    const sub = args[0];
    let key = sub && /^[a-z][a-z0-9:._-]*$/.test(sub) ? `${program} ${sub}` : program;
    const script = args[1];
    if (RUNNERS.has(program) && sub === "run" && script && /^[a-z][a-z0-9:._-]*$/.test(script)) key = `${key} ${script}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Distinct keys the old summarizeDenials produced for a run. */
export function legacyKeyCount(raw: Denial[]): number {
  const keys = new Set<string>();
  for (const d of raw) {
    if (typeof d?.tool_name !== "string" || d.tool_name === "") continue;
    const command = d.tool_input?.command;
    if (d.tool_name !== "Bash" || typeof command !== "string") {
      keys.add(d.tool_name);
      continue;
    }
    const ks = legacyCommandKeys(command);
    if (ks.length === 0) keys.add("Bash");
    for (const k of ks) keys.add(`Bash: ${k}`);
  }
  return keys.size;
}

export interface Stats {
  runs: number;
  withDenials: number;
  median: number;
  mean: number;
  max: number;
}

export function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n === 0 ? 0 : n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { runs: n, withDenials: sorted.filter((v) => v > 0).length, median, mean: n ? Math.round((sum / n) * 10) / 10 : 0, max: n ? sorted[n - 1]! : 0 };
}

/** Median raw denials per sandbox state from telemetry result events. */
export function telemetryStats(jsonl: string, agentId: string, since: string): Record<string, Stats> {
  const by: Record<string, number[]> = {};
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; agentId?: string; denials?: unknown; sandbox?: unknown; at?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "result" || e.agentId !== agentId || typeof e.denials !== "number" || (e.at ?? "") < since) continue;
    (by[String(e.sandbox ?? "off")] ??= []).push(e.denials);
  }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, stats(v)]));
}

function fmt(s: Stats): string {
  return `${s.runs} runs, ${s.withDenials} with denials, median ${s.median}, mean ${s.mean}, max ${s.max}`;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const outputDir = join(homedir(), ".wissel", "task-output");
  const agentId = arg("--agent") ?? "implementer";
  const since = arg("--since") ?? "2026-10-03";

  const fixtures = arg("--fixtures");
  if (fixtures) {
    const raw = denialsFromOutput(await readFile(join(outputDir, `${fixtures}.jsonl`), "utf8")) ?? [];
    console.log(`${raw.length} raw denial(s) in ${fixtures}`);
    for (const d of raw) {
      const command = typeof d.tool_input?.command === "string" ? d.tool_input.command : "";
      console.log(JSON.stringify({ tool: d.tool_name, command, keys: summarizeDenials([d]), legacyKeyCount: legacyKeyCount([d]) }));
    }
    return;
  }

  if (process.argv.includes("--telemetry")) {
    const path = process.env.WISSEL_TELEMETRY_PATH ?? join(homedir(), ".wissel", "telemetry.jsonl");
    const by = telemetryStats(await readFile(path, "utf8").catch(() => ""), agentId, since);
    if (Object.keys(by).length === 0) console.log(`no ${agentId} result events with a denials count since ${since}`);
    for (const [state, s] of Object.entries(by)) console.log(`${agentId}, sandbox ${state}: ${fmt(s)}`);
    return;
  }

  const dbPath = process.env.WISSEL_DB_PATH ?? join(homedir(), ".wissel", "board.sqlite");
  const db = new Database(dbPath, { readonly: true });
  const rows = db.query("SELECT taskId FROM task_results WHERE agentId = ? AND finishedAt >= ? ORDER BY finishedAt").all(agentId, since) as { taskId: string }[];
  const raw: number[] = [];
  const legacy: number[] = [];
  const fixed: number[] = [];
  let missing = 0;
  for (const { taskId } of rows) {
    const text = await readFile(join(outputDir, `${taskId}.jsonl`), "utf8").catch(() => undefined);
    const denials = text === undefined ? undefined : denialsFromOutput(text);
    if (!denials) {
      missing++;
      continue;
    }
    raw.push(denials.length);
    legacy.push(legacyKeyCount(denials));
    fixed.push(summarizeDenials(denials).length);
  }
  console.log(`${agentId} results since ${since}: ${rows.length} (${missing} without a result line in task output, skipped)`);
  console.log(`raw denials:             ${fmt(stats(raw))}`);
  console.log(`keys, old split:         ${fmt(stats(legacy))}`);
  console.log(`keys, quote-aware split: ${fmt(stats(fixed))}`);
}

if (import.meta.main) await main();
