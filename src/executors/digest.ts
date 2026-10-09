import { fileURLToPath } from "node:url";
import type { AgentDef, Executor, TaskCard, TaskResult } from "../core/types.ts";
import type { Board } from "../services/board.ts";
import { DEFAULT_MEMORY_PATH } from "../services/memory.ts";
import { buildWisselDigest } from "../services/wissel-digest.ts";
import { runViaBun, type CommandRunner } from "./claude-cli.ts";

/**
 * The "Collect activity" step of the Wissel retrospective podcast
 * (docs/SDD-wissel-retro-podcast.md §3.1): builds the digest
 * (src/services/wissel-digest.ts) from the board this server runs on,
 * its telemetry, memory/lessons.md, wissel's own docs/ and read-only git,
 * and hands it to the analyst step as pipeline-handoff `data`.
 *
 * Deterministic code, not an agent, like TtsExecutor: no LLM, no prompt,
 * no harness (`harnessTool` is undefined, so the pipeline runner acquires
 * none), no spend. The run input (this step's body, since it is the
 * first step) sets the period: `last N days`, `since YYYY-MM-DD`, else
 * the last 7 days.
 */

/** wissel's own docs/ directory, next to src/. */
export const DEFAULT_DOCS_DIR = fileURLToPath(new URL("../../docs", import.meta.url));

export interface DigestExecutorOptions {
  /** The board to read; the server passes its own. */
  board: Pick<Board, "list" | "getResult">;
  telemetryPath?: string;
  lessonsPath?: string;
  docsDir?: string;
  /** Only ever given read-only git commands (assertReadOnlyGit). */
  runner?: CommandRunner;
  /** Manifest model per agent, for spend with no dispatch event. */
  agentModel?: (agentId: string) => string | undefined;
  worktreesRoot?: string;
  now?: () => Date;
}

export class DigestExecutor implements Executor {
  readonly id = "digest";

  constructor(private opts: DigestExecutorOptions) {}

  canHandle(agent: AgentDef): boolean {
    return agent.executor === "digest";
  }

  async run(task: TaskCard, agent: AgentDef): Promise<TaskResult> {
    let data;
    try {
      data = await buildWisselDigest({
        board: this.opts.board,
        telemetryPath: this.opts.telemetryPath,
        lessonsPath: this.opts.lessonsPath ?? DEFAULT_MEMORY_PATH,
        docsDir: this.opts.docsDir ?? DEFAULT_DOCS_DIR,
        runner: this.opts.runner ?? runViaBun,
        now: (this.opts.now ?? (() => new Date()))(),
        input: task.body,
        worktreesRoot: this.opts.worktreesRoot,
        agentModel: this.opts.agentModel,
        excludeRunId: task.pipelineRunId,
      });
    } catch (e) {
      return { taskId: task.id, agentId: agent.id, ok: false, summary: `Digest not built: ${(e as Error).message}` };
    }
    const linked = data.stories.filter((s) => s.sources.length > 0).length;
    console.log(`digest: ${data.period.from} to ${data.period.to}, ${data.stories.length} stories (${linked} linked), $${data.stats.spendUsd} spent, truncated ${data.truncated}`);
    return {
      taskId: task.id,
      agentId: agent.id,
      ok: true,
      summary: [
        `Wissel activity ${data.period.from} to ${data.period.to} (${data.period.days} days): ${data.stats.cards} cards, ${data.stories.length} stories (${linked} linked to a commit), $${data.stats.spendUsd.toFixed(2)} spent, ${data.docs.length} SDDs changed${data.truncated ? `, ${data.truncated} items left out to stay small` : ""}.`,
        "",
        "```pipeline-handoff",
        JSON.stringify({ data }),
        "```",
      ].join("\n"),
      actualCost: 0,
      pipelineHandoff: { data: data as unknown as Record<string, unknown> },
    };
  }
}
