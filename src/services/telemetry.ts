import { appendFile, mkdir } from "node:fs/promises";
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
}
