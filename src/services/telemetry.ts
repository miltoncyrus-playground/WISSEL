import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type TelemetryEvent =
  | { type: "dispatch"; taskId: string; agentId: string; model?: string; estimatedCost?: number }
  | { type: "result"; taskId: string; agentId: string; actualCost?: number; harnessId?: string };

/**
 * Append-only cost/dispatch log: {agent, model, task_id, estimated_cost,
 * actual_cost}, split into a dispatch row and a result row rather than
 * one mutable record — nothing reads this yet, so an event log that's
 * trivial to append to beats a store that has to support in-place
 * updates for no current reader. Logged from the dispatch point itself,
 * before anything consumes it.
 */
export class TelemetryLog {
  constructor(private filePath: string) {}

  async record(event: TelemetryEvent): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const line = JSON.stringify({ ...event, at: new Date().toISOString() });
    await appendFile(this.filePath, line + "\n");
  }

  /**
   * Sums `actualCost` across every recorded "result" event at or after
   * `since` — used by the sweep concurrency/spend guard
   * (Orchestrator.sweep's `spendCeilingUsd` option) to check real,
   * recorded spend before dispatching more autonomous work. Reads the
   * file fresh every call rather than keeping a running in-memory total
   * — correctness matters more than the cost of re-reading a same-day
   * jsonl file, and a running total would drift the moment anything
   * else appends to this log outside this process's own lifetime. A
   * missing file (nothing recorded yet) reads as zero spend, not an
   * error — a brand-new install is never "over budget." A line that
   * fails to parse, or isn't a "result" event, or has no actualCost, is
   * skipped rather than treated as an error — this log is meant to
   * tolerate partial/malformed entries the same way `record` itself
   * never validates what it's handed.
   */
  async sumCostSince(since: Date): Promise<number> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch {
      return 0;
    }
    let total = 0;
    for (const line of contents.split("\n")) {
      if (!line.trim()) continue;
      let event: { type?: string; actualCost?: number; at?: string };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.type !== "result" || typeof event.actualCost !== "number" || !event.at) continue;
      if (new Date(event.at).getTime() >= since.getTime()) total += event.actualCost;
    }
    return total;
  }
}
