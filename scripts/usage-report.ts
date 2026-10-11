#!/usr/bin/env bun
/**
 * Where agent spend goes, from the telemetry log: per agent, the runs,
 * cost, turns and tokens, how many runs a session limit (429) cut off
 * and what they cost, and how many resumed a cut-off session instead of
 * starting over. Free and read-only. docs/proposal-agent-run-efficiency.md
 * item 1.
 *
 *   bun run usage:report                    # last 7 days
 *   bun run usage:report --since 2026-10-10 # from a date (UTC)
 *   bun run usage:report --agent implementer
 *
 * Cost grows with turns times context: every turn re-reads the
 * conversation so far from cache, so "context/turn" (cache-read tokens
 * divided by turns) is the number to watch. Runs recorded before usage
 * logging existed count toward cost and runs but not the token columns.
 *
 * WISSEL_TELEMETRY_PATH as for the server.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunUsage } from "../src/core/types.ts";

export interface ResultEvent {
  type: "result";
  taskId: string;
  agentId: string;
  actualCost?: number;
  retryAfter?: string;
  usage?: RunUsage;
  resumed?: boolean;
  at: string;
}

export interface AgentUsage {
  agentId: string;
  runs: number;
  costUsd: number;
  /** Runs that carried a usage block; the token figures cover only these. */
  runsWithUsage: number;
  turns: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  inputTokens: number;
  cutByLimit: { runs: number; costUsd: number };
  resumed: { runs: number; costUsd: number };
}

export interface TaskUsage {
  taskId: string;
  agentId: string;
  runs: number;
  costUsd: number;
  turns: number;
  cacheReadTokens: number;
}

/** The result events in a JSONL telemetry log, skipping anything else. */
export function parseResultEvents(text: string): ResultEvent[] {
  const out: ResultEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const r = e as Partial<ResultEvent>;
    if (r && r.type === "result" && typeof r.taskId === "string" && typeof r.agentId === "string" && typeof r.at === "string") out.push(r as ResultEvent);
  }
  return out;
}

/** Per-agent and per-task totals for results at or after `since`,
 *  optionally for one agent. Agents sorted by cost, highest first. */
export function summarizeUsage(events: ResultEvent[], since: Date, agentId?: string): { agents: AgentUsage[]; tasks: TaskUsage[] } {
  const agents = new Map<string, AgentUsage>();
  const tasks = new Map<string, TaskUsage>();
  for (const e of events) {
    if (new Date(e.at).getTime() < since.getTime()) continue;
    if (agentId && e.agentId !== agentId) continue;
    const cost = typeof e.actualCost === "number" ? e.actualCost : 0;
    const a =
      agents.get(e.agentId) ??
      ({ agentId: e.agentId, runs: 0, costUsd: 0, runsWithUsage: 0, turns: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, inputTokens: 0, cutByLimit: { runs: 0, costUsd: 0 }, resumed: { runs: 0, costUsd: 0 } } satisfies AgentUsage);
    a.runs++;
    a.costUsd += cost;
    if (e.usage) {
      a.runsWithUsage++;
      a.turns += e.usage.turns ?? 0;
      a.cacheReadTokens += e.usage.cacheReadTokens;
      a.cacheWriteTokens += e.usage.cacheWriteTokens;
      a.outputTokens += e.usage.outputTokens;
      a.inputTokens += e.usage.inputTokens;
    }
    if (e.retryAfter) {
      a.cutByLimit.runs++;
      a.cutByLimit.costUsd += cost;
    }
    if (e.resumed) {
      a.resumed.runs++;
      a.resumed.costUsd += cost;
    }
    agents.set(e.agentId, a);

    const t = tasks.get(e.taskId) ?? { taskId: e.taskId, agentId: e.agentId, runs: 0, costUsd: 0, turns: 0, cacheReadTokens: 0 };
    t.runs++;
    t.costUsd += cost;
    t.turns += e.usage?.turns ?? 0;
    t.cacheReadTokens += e.usage?.cacheReadTokens ?? 0;
    tasks.set(e.taskId, t);
  }
  return {
    agents: [...agents.values()].sort((x, y) => y.costUsd - x.costUsd),
    tasks: [...tasks.values()].sort((x, y) => y.costUsd - x.costUsd),
  };
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The printed report. */
export function formatReport(summary: ReturnType<typeof summarizeUsage>, since: Date, top = 5): string {
  const lines = [`Agent usage since ${since.toISOString().slice(0, 10)}`, ""];
  if (summary.agents.length === 0) return [...lines, "No results in this window."].join("\n");
  const total = summary.agents.reduce((s, a) => s + a.costUsd, 0);
  lines.push("agent                        runs      cost  share  turns/run  context/turn  output/run  cut by 429  resumed");
  for (const a of summary.agents) {
    const withUsage = a.runsWithUsage || 1;
    const perTurn = a.turns > 0 ? k(a.cacheReadTokens / a.turns) : "-";
    lines.push(
      [
        a.agentId.padEnd(26),
        String(a.runs).padStart(6),
        usd(a.costUsd).padStart(9),
        `${Math.round((a.costUsd / (total || 1)) * 100)}%`.padStart(6),
        (a.runsWithUsage ? String(Math.round(a.turns / withUsage)) : "-").padStart(10),
        perTurn.padStart(13),
        (a.runsWithUsage ? k(a.outputTokens / withUsage) : "-").padStart(11),
        `${a.cutByLimit.runs} ${usd(a.cutByLimit.costUsd)}`.padStart(11),
        `${a.resumed.runs} ${usd(a.resumed.costUsd)}`.padStart(9),
      ].join(" "),
    );
  }
  const untracked = summary.agents.reduce((s, a) => s + (a.runs - a.runsWithUsage), 0);
  lines.push("", `Total ${usd(total)}.${untracked ? ` ${untracked} run(s) predate usage logging: in cost, not in the token columns.` : ""}`);
  const cut = summary.agents.reduce((s, a) => s + a.cutByLimit.costUsd, 0);
  if (cut > 0) lines.push(`Spent on runs a session limit cut off: ${usd(cut)} (${Math.round((cut / (total || 1)) * 100)}%).`);
  lines.push("", `Most expensive tasks:`);
  for (const t of summary.tasks.slice(0, top)) {
    lines.push(`  ${t.taskId.slice(0, 8)}  ${t.agentId.padEnd(22)} ${usd(t.costUsd).padStart(8)}  ${t.runs} run(s)${t.turns ? `, ${t.turns} turns, ${k(t.cacheReadTokens / t.turns)} context/turn` : ""}`);
  }
  return lines.join("\n");
}

/** `--since` and `--agent` from argv; a string is a usage error. */
export function parseArgs(argv: string[], now = new Date()): { since: Date; agent?: string } | string {
  let since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  let agent: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--since") {
      if (!v || Number.isNaN(Date.parse(v))) return `--since needs a date like 2026-10-10, got ${JSON.stringify(v)}`;
      since = new Date(v);
      i++;
    } else if (a === "--agent") {
      if (!v) return "--agent needs an agent id";
      agent = v;
      i++;
    } else return `unknown argument ${JSON.stringify(a)}`;
  }
  return { since, ...(agent ? { agent } : {}) };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(`usage-report: ${args}`);
    process.exit(2);
  }
  const path = process.env.WISSEL_TELEMETRY_PATH ?? join(homedir(), ".wissel", "telemetry.jsonl");
  const text = await readFile(path, "utf8").catch(() => "");
  console.log(formatReport(summarizeUsage(parseResultEvents(text), args.since, args.agent), args.since));
}
