/**
 * The sub-agents a run spawned, read back from its raw agent output
 * (the JSONL `appendTaskOutput` records, docs/SDD-live-task-output.md).
 * docs/SDD-subagent-board.md.
 *
 * A sub-agent is an `Agent` (older builds: `Task`) tool call. Its own
 * messages carry `parent_tool_use_id` = that call's id, and its hand-back
 * is the matching `tool_result`. Only complete top-level `assistant` and
 * `user` lines are read: the `stream_event` deltas repeat the same turns.
 */

export type SubagentStatus = "running" | "done" | "failed";

export interface SubagentRun {
  /** The Agent tool call's id; stable for the life of the run. */
  id: string;
  /** `subagent_type` (Explore, general-purpose, ...); "agent" when unset. */
  type: string;
  /** The short description the parent gave it. */
  description: string;
  status: SubagentStatus;
  /** Spawned with `run_in_background`, so it can outlive its tool call. */
  background: boolean;
  /** Tool calls the sub-agent itself has made so far. */
  toolCalls: number;
}

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const MAX_DESCRIPTION = 160;

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > MAX_DESCRIPTION ? `${one.slice(0, MAX_DESCRIPTION - 1)}…` : one;
}

/** Reads the raw JSONL lines of one task, oldest first. A line that is
 *  not JSON, or not one of the shapes above, is skipped: the output
 *  file is a log, never a contract. */
export function parseSubagentRuns(lines: readonly string[]): SubagentRun[] {
  const runs = new Map<string, SubagentRun>();
  for (const line of lines) {
    let msg: Record<string, unknown> | undefined;
    try {
      msg = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (!msg || (msg.type !== "assistant" && msg.type !== "user")) continue;
    const content = asObject(msg.message)?.content;
    if (!Array.isArray(content)) continue;
    const parent = typeof msg.parent_tool_use_id === "string" ? msg.parent_tool_use_id : undefined;

    for (const raw of content) {
      const block = asObject(raw);
      if (!block) continue;
      if (block.type === "tool_use") {
        if (parent) {
          const owner = runs.get(parent);
          if (owner) owner.toolCalls += 1;
        }
        if (parent === undefined && typeof block.id === "string" && typeof block.name === "string" && SPAWN_TOOLS.has(block.name)) {
          const input = asObject(block.input) ?? {};
          const type = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "agent";
          const description = typeof input.description === "string" && input.description ? input.description : typeof input.prompt === "string" ? input.prompt : "";
          runs.set(block.id, { id: block.id, type, description: clip(description), status: "running", background: input.run_in_background === true, toolCalls: 0 });
        }
      } else if (block.type === "tool_result" && parent === undefined && typeof block.tool_use_id === "string") {
        const run = runs.get(block.tool_use_id);
        // A background spawn's result only says it started; it stays
        // "running" until the run itself ends (see settleSubagentRuns).
        if (run && !run.background) run.status = block.is_error === true ? "failed" : "done";
        else if (run && block.is_error === true) run.status = "failed";
      }
    }
  }
  return [...runs.values()];
}

/** Once the task's run is over nothing is still running: a sub-agent
 *  that never reported back is closed as `done`, or `failed` when the
 *  run itself failed. */
export function settleSubagentRuns(runs: readonly SubagentRun[], runOk: boolean): SubagentRun[] {
  return runs.map((r) => (r.status === "running" ? { ...r, status: runOk ? "done" : "failed" } : r));
}

export interface SubagentSummary {
  total: number;
  running: number;
  failed: number;
}

export function summarizeSubagentRuns(runs: readonly SubagentRun[]): SubagentSummary {
  return { total: runs.length, running: runs.filter((r) => r.status === "running").length, failed: runs.filter((r) => r.status === "failed").length };
}
