import type { HarnessPool } from "../core/harness-pool.ts";
import { resolveModel } from "../core/model-resolution.ts";
import type { Registry } from "../core/registry.ts";
import type { TaskCard } from "../core/types.ts";
import type { Board } from "./board.ts";
import type { PipelineStore } from "./pipelines.ts";

/**
 * Read-only summary of one pipeline run for the board's run drawer
 * (docs/SDD-ui-cleanup.md §4.1, card B1): every step card in creation
 * order with the agent, harness, model, status, duration and cost the
 * drawer lists. Served by `GET /pipeline-runs/:runId` (src/api/server.ts).
 * Computes from what is already stored (task rows, recorded results,
 * the durable task-output JSONL); writes nothing.
 */

export interface PipelineRunStepSummary {
  taskId: string;
  /** PipelineStepDef.id this card is an instance of. */
  stepId: string | null;
  /** The step's name from the definition, or the card title minus its
   *  "<pipeline name>: " prefix when the definition is gone. */
  stepName: string;
  /** 1 for a step's first card in this run, 2 for its second, ... */
  attempt: number;
  agentId: string | null;
  harness: string | null;
  model: string | null;
  /** "output": the model the CLI reported it ran (claude's init line).
   *  "config": not reported, so the model the current config resolves
   *  to (resolveModel). null when neither is known. */
  modelSource: "output" | "config" | null;
  status: TaskCard["status"];
  /** claude's own `duration_ms` from its result line; null when the
   *  output doesn't carry one (codex, an API run, a step that never ran). */
  durationMs: number | null;
  cost: number | null;
}

export interface PipelineRunSummary {
  root: TaskCard;
  pipeline: { id: string; name: string; stepCount: number } | null;
  steps: PipelineRunStepSummary[];
  /** Sum of every step's known cost; null when no step has one. */
  totalCost: number | null;
  /** The run's MP3 from a "Make audio" step (TtsExecutor,
   *  docs/SDD-ai-news-podcast.md §3.7): where the drawer plays it from
   *  and its size; null when the run has none. */
  audio: { url: string; bytes: number } | null;
}

export interface PipelineRunSummaryDeps {
  board: Board;
  pipelines: PipelineStore;
  registry: Registry;
  harnesses: HarnessPool;
  /** A task's durable output lines (getTaskOutput, src/services/task-output.ts). */
  readOutput: (taskId: string) => Promise<string[]>;
  /** Size of the run's MP3, or null when it has none
   *  (pipelineAudioBytes, src/services/pipeline-audio.ts). Omitted means
   *  audio is never reported. */
  audioBytes?: (runId: string) => Promise<number | null>;
}

/**
 * What a step's raw CLI output says about its own run. Only claude's
 * stream-json shapes are read: the `{"type":"system","subtype":"init",
 * "model":...}` line it prints first and the `{"type":"result",
 * "duration_ms":...}` line it prints at the end (the Agent SDK's
 * SDKSystemMessage / SDKResultMessage; checked against those message
 * types, not observed in a live run here). Anything else (codex events,
 * a malformed line) is skipped, so an unknown format gives nulls rather
 * than a guess. The result line is searched from the end because claude
 * can print system lines after it (see `resultLine`,
 * src/executors/claude-cli.ts).
 */
export function parseRunStats(lines: string[]): { model: string | null; durationMs: number | null } {
  let model: string | null = null;
  let durationMs: number | null = null;
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) parsed.push(value as Record<string, unknown>);
    } catch {
      // not JSON: skip
    }
  }
  for (const event of parsed) {
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string" && event.model) {
      model = event.model;
      break;
    }
  }
  for (let i = parsed.length - 1; i >= 0; i--) {
    const event = parsed[i]!;
    if (event.type === "result" && typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms)) {
      durationMs = event.duration_ms;
      break;
    }
  }
  return { model, durationMs };
}

/** "Review-Handoff Loop: Reviewer" -> "Reviewer" when the root is
 *  "Pipeline: Review-Handoff Loop" (the titles startPipelineRun and
 *  runStepAndSuccessors give them, src/core/pipeline-runner.ts). */
export function stepNameFromTitle(stepTitle: string, rootTitle: string): string {
  const pipelineName = rootTitle.startsWith("Pipeline: ") ? rootTitle.slice("Pipeline: ".length) : "";
  if (pipelineName && stepTitle.startsWith(pipelineName + ": ")) return stepTitle.slice(pipelineName.length + 2);
  return stepTitle;
}

/** undefined when `runId` isn't a run root: no such task, a task with no
 *  pipelineId, or a step card (which has pipelineRunId set). */
export async function buildPipelineRunSummary(deps: PipelineRunSummaryDeps, runId: string): Promise<PipelineRunSummary | undefined> {
  const root = await deps.board.get(runId);
  if (!root || !root.pipelineId || root.pipelineRunId) return undefined;

  const def = await deps.pipelines.get(root.pipelineId);
  const cards = (await deps.board.list()).filter((t) => t.pipelineRunId === runId);
  const seenAttempts = new Map<string, number>();
  const steps: PipelineRunStepSummary[] = [];
  for (const card of cards) {
    const defStep = def?.graph.steps.find((s) => s.id === card.pipelineStepId);
    const attemptKey = card.pipelineStepId ?? card.id;
    const attempt = (seenAttempts.get(attemptKey) ?? 0) + 1;
    seenAttempts.set(attemptKey, attempt);

    const result = await deps.board.getResult(card.id);
    const stats = parseRunStats(await deps.readOutput(card.id));
    const agentId = result?.agentId ?? defStep?.agentId ?? card.routedTo ?? null;
    const harnessId = card.harness ?? result?.harnessId ?? null;

    let model = stats.model;
    let modelSource: PipelineRunStepSummary["modelSource"] = model ? "output" : null;
    const agent = agentId ? deps.registry.get(agentId) : undefined;
    if (!model && agent) {
      model = resolveModel(card, agent, harnessId ? deps.harnesses.get(harnessId) : undefined);
      modelSource = "config";
    }

    steps.push({
      taskId: card.id,
      stepId: card.pipelineStepId ?? null,
      stepName: defStep?.name ?? stepNameFromTitle(card.title, root.title),
      attempt,
      agentId,
      harness: harnessId,
      model,
      modelSource,
      status: card.status,
      durationMs: stats.durationMs,
      cost: typeof result?.actualCost === "number" ? result.actualCost : null,
    });
  }

  const costs = steps.map((s) => s.cost).filter((c): c is number => c !== null);
  const audioBytes = deps.audioBytes ? await deps.audioBytes(root.id) : null;
  return {
    root,
    pipeline: def ? { id: def.id, name: def.name, stepCount: def.graph.steps.length } : null,
    steps,
    totalCost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    audio: audioBytes === null ? null : { url: `/pipeline-runs/${encodeURIComponent(root.id)}/audio`, bytes: audioBytes },
  };
}
