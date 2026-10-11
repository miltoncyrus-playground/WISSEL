// Runs Ask's control actions (docs/SDD-wissel-app.md §3.7) once
// concierge-actions.ts has validated them. Every action calls the same
// function its board endpoint calls (board-actions.ts, the Board, the
// orchestrator, the stores), never our own HTTP API, and each target is
// checked again on the board as it is right now first (recheckControl):
// a card that moved since the model looked is refused, not acted on.

import type { Board } from "./board.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { McpServerPool } from "../core/mcp-server-pool.ts";
import type { PipelineStore } from "./pipelines.ts";
import type { ProjectStore } from "./projects.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { TaskCard } from "../core/types.ts";
import { grantAndRetry } from "../core/orchestrator.ts";
import {
  abandonEscalation,
  approveMcpRequest,
  denyMcpRequest,
  disableHarness,
  disableMcpServer,
  discardTask,
  enableHarness,
  enableMcpServer,
  mergeTask,
  setAllowedTools,
  setHarnessDefaultModel,
  setMcpToolTrust,
  setTaskHarnessOverride,
  type HarnessControlDeps,
  type McpControlDeps,
  type Outcome,
} from "./board-actions.ts";
import { ACTION_VERBS, cardName, isCardControl, recheckControl, type ActionContext, type CardControl, type ControlAction, type OtherControl } from "./concierge-actions.ts";
import type { ControlExecuted, ControlTarget } from "./conversations.ts";

/** What Ask's control actions run on: the same objects createApp gives
 *  the routes. */
export interface ControlDeps {
  board: Board;
  /** Orchestrator.runNow with the manual executors: the board's Run now. */
  runNow(taskId: string): Promise<void>;
  /** For merge and discard's git (runViaBun in the server). */
  gitRunner: CommandRunner;
  harness: HarnessControlDeps;
  mcp: McpControlDeps;
  pipelines: PipelineStore;
  projects: ProjectStore;
}

/** Past tense, for what was done. */
const DONE_VERBS: Record<CardControl["type"], string> = {
  move_task: "Moved",
  run_task: "Started",
  retry_task: "Retried",
  stop_task: "Stopped",
  approve_mcp_request: "Approved the MCP call on",
  deny_mcp_request: "Denied the MCP call on",
  grant_and_retry: "Granted the suggested tools and retried",
  abandon_escalation: "Abandoned",
  archive_task: "Archived",
  unarchive_task: "Unarchived",
  add_dependency: "Added a dependency to",
  set_task_harness: "Set the harness of",
  merge_task: "Merged",
  discard_task: "Discarded",
  delete_task: "Deleted",
  grant_allowed_tools: "Granted tools to",
};

/** The sentence for a card action on `task`, done or not. */
export function cardSentence(action: CardControl, task: Pick<TaskCard, "id" | "title">, ctx: Pick<ActionContext, "tasks">, error?: string): string {
  const name = cardName(task);
  if (error) return `Did not ${ACTION_VERBS[action.type]} ${name}: ${error}.`;
  const dep = action.dependsOn ? ctx.tasks?.find((t) => t.id === action.dependsOn) : undefined;
  switch (action.type) {
    case "move_task":
      return `Moved ${name} to ${action.status}.`;
    case "stop_task":
      return `Stopped ${name}: moved it to failed.`;
    case "add_dependency":
      return `${name} now waits for ${dep ? cardName(dep) : `card ${action.dependsOn!.slice(0, 8)}`}.`;
    case "set_task_harness":
      return action.harness ? `${name} will run on harness ${action.harness}.` : `Cleared the harness of ${name}.`;
    case "grant_allowed_tools":
      return `Granted ${action.tools!.join(", ")} to ${name}.`;
    default:
      return `${DONE_VERBS[action.type]} ${name}.`;
  }
}

/** The sentence for a non-card action, done or not. */
export function otherSentence(action: OtherControl, error?: string): string {
  const [infinitive, past] = otherWords(action);
  return error ? `Did not ${infinitive}: ${error}.` : past;
}

/** [what it would do, what it did] for a non-card action. */
function otherWords(action: OtherControl): [string, string] {
  return action.type === "set_harness_enabled"
      ? [`${action.enabled ? "enable" : "disable"} harness ${action.harnessId}`, `${action.enabled ? "Enabled" : "Disabled"} harness ${action.harnessId}.`]
      : action.type === "set_harness_model"
        ? [
            `set the model of harness ${action.harnessId}`,
            action.model ? `Set harness ${action.harnessId}'s model to ${action.model}.` : `Cleared harness ${action.harnessId}'s model; it uses each agent's default.`,
          ]
        : action.type === "set_mcp_server_enabled"
          ? [`${action.enabled ? "enable" : "disable"} MCP server ${action.serverId}`, `${action.enabled ? "Enabled" : "Disabled"} MCP server ${action.serverId}.`]
          : action.type === "trust_mcp_tool"
            ? [`set ${action.serverId}/${action.tool} to ${action.trust}`, `Set ${action.serverId}/${action.tool} to ${action.trust}.`]
            : action.type === "delete_pipeline"
              ? [`delete pipeline '${action.name}'`, `Deleted pipeline '${action.name}'.`]
              : [`remove project '${action.name}'`, `Removed project '${action.name}' from wissel (its files are untouched).`];
}

function otherTarget(action: OtherControl): ControlTarget {
  switch (action.type) {
    case "set_harness_enabled":
    case "set_harness_model":
      return { kind: "harness", id: action.harnessId, label: action.harnessId };
    case "set_mcp_server_enabled":
      return { kind: "mcp-server", id: action.serverId, label: action.serverId };
    case "trust_mcp_tool":
      return { kind: "mcp-server", id: action.serverId, label: `${action.serverId}/${action.tool}` };
    case "delete_pipeline":
      return { kind: "pipeline", id: action.pipelineId, label: action.name };
    case "remove_project":
      return { kind: "project", id: action.projectId, label: action.name };
  }
}

/** The line a Confirm card shows per target: "Merge 'X' (card 2f0cd188)". */
export function pendingLines(action: ControlAction, ctx: Pick<ActionContext, "tasks">): string[] {
  const verb = ACTION_VERBS[action.type];
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (!isCardControl(action)) return [cap(otherWords(action)[0])];
  return action.taskIds.map((id) => {
    const t = ctx.tasks?.find((x) => x.id === id);
    const extra = action.type === "move_task" ? ` to ${action.status}` : action.type === "grant_allowed_tools" ? `: ${action.tools!.join(", ")}` : "";
    return `${cap(verb)} ${t ? cardName(t) : `card ${id.slice(0, 8)}`}${extra}`;
  });
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const outcomeError = <T>(o: Outcome<T>) => (o.ok ? undefined : o.status === 404 ? "it is gone" : o.error);

/** One card action on one card. Undefined error means it worked;
 *  `touched` is every card it changed (archive cascades). */
async function runOnCard(action: CardControl, task: TaskCard, deps: ControlDeps): Promise<{ error?: string; touched?: TaskCard[] }> {
  const { board } = deps;
  try {
    switch (action.type) {
      case "move_task":
        await board.move(task.id, action.status!);
        return {};
      case "stop_task":
        await board.move(task.id, "failed");
        return {};
      case "run_task":
      case "retry_task":
        await deps.runNow(task.id);
        return {};
      case "approve_mcp_request":
        return { error: outcomeError(await approveMcpRequest(board, task)) };
      case "deny_mcp_request":
        return { error: outcomeError(await denyMcpRequest(board, task)) };
      case "grant_and_retry": {
        const next = await grantAndRetry(board, task);
        return typeof next === "string" ? { error: next } : {};
      }
      case "abandon_escalation":
        return { error: outcomeError(await abandonEscalation(board, task)) };
      case "archive_task":
        return { touched: await board.archive(task.id) };
      case "unarchive_task":
        await board.unarchive(task.id);
        return {};
      case "add_dependency":
        await board.setDependencies(task.id, [...(task.dependsOn ?? []), action.dependsOn!]);
        return {};
      case "set_task_harness":
        return { error: outcomeError(await setTaskHarnessOverride(board, deps.harness.harnesses, task, action.harness ?? null)) };
      case "merge_task":
        return { error: outcomeError(await mergeTask(board, task.id, deps.gitRunner)) };
      case "discard_task":
        return { error: outcomeError(await discardTask(board, task.id, deps.gitRunner)) };
      case "delete_task":
        await board.delete(task.id);
        return {};
      case "grant_allowed_tools":
        return { error: outcomeError(await setAllowedTools(board, task, [...(task.extraAllowedTools ?? []), ...action.tools!])) };
    }
  } catch (e) {
    return { error: errorText(e) };
  }
}

async function runOther(action: OtherControl, deps: ControlDeps): Promise<string | undefined> {
  try {
    switch (action.type) {
      case "set_harness_enabled": {
        const h = deps.harness.harnesses.get(action.harnessId);
        if (!h) return "the harness is gone";
        return outcomeError(action.enabled ? await enableHarness(deps.harness, h) : await disableHarness(deps.harness, h));
      }
      case "set_harness_model": {
        const h = deps.harness.harnesses.get(action.harnessId);
        if (!h) return "the harness is gone";
        return outcomeError(await setHarnessDefaultModel(deps.harness, h, action.model ?? undefined));
      }
      case "set_mcp_server_enabled": {
        const s = deps.mcp.mcpServers.get(action.serverId);
        if (!s) return "the MCP server is gone";
        return outcomeError(action.enabled ? await enableMcpServer(deps.mcp, s) : await disableMcpServer(deps.mcp, s));
      }
      case "trust_mcp_tool": {
        const s = deps.mcp.mcpServers.get(action.serverId);
        if (!s) return "the MCP server is gone";
        return outcomeError(await setMcpToolTrust(deps.mcp, s, action.tool, action.trust));
      }
      case "delete_pipeline":
        await deps.pipelines.delete(action.pipelineId);
        return undefined;
      case "remove_project":
        await deps.projects.delete(action.projectId);
        return undefined;
    }
  } catch (e) {
    return errorText(e);
  }
}

export interface ControlRun {
  /** One per target, in order: what was done or refused, and why. */
  executed: ControlExecuted[];
  /** What would undo what worked, for the Undo chip: archive, move and
   *  harness enable/disable only (§3.7). Empty for everything else. */
  inverse: ControlAction[];
}

/**
 * Runs one validated control action. `ctx` is the board as it is now
 * (built fresh by the caller); every target is rechecked against it
 * before anything runs, and a target that no longer passes is refused
 * by name.
 */
export async function executeControl(action: ControlAction, ctx: ActionContext, deps: ControlDeps, confirmedBy: ControlExecuted["confirmedBy"]): Promise<ControlRun> {
  const base = { type: action.type, control: true as const, tier: action.tier, confirmedBy };
  const rechecked = recheckControl(action, ctx);
  const executed: ControlExecuted[] = [];
  const inverse: ControlAction[] = [];

  if (!isCardControl(action)) {
    const target = otherTarget(action);
    if (!rechecked.action) {
      const error = rechecked.refused[0]?.reason ?? "it can't be done now";
      return { executed: [{ ...base, ok: false, target, error, text: otherSentence(action, error) }], inverse };
    }
    const error = await runOther(action, deps);
    executed.push({ ...base, ok: !error, target, text: otherSentence(action, error), ...(error ? { error } : {}) });
    if (!error && action.type === "set_harness_enabled") inverse.push({ ...action, enabled: !action.enabled });
    return { executed, inverse };
  }

  const byId = new Map((ctx.tasks ?? []).map((t) => [t.id, t]));
  const refusedById = new Map(rechecked.refused.flatMap((r) => (r.taskId ? [[r.taskId, r.reason] as const] : [])));
  const unarchive: string[] = [];
  for (const id of action.taskIds) {
    const task = byId.get(id);
    const target: ControlTarget = { kind: "card", id, label: task?.title ?? id.slice(0, 8) };
    const refused = refusedById.get(id) ?? (rechecked.action ? undefined : "it can't be done now");
    if (refused || !task) {
      const error = refused ?? "the card is gone";
      executed.push({ ...base, ok: false, target, error, text: cardSentence(action, task ?? { id, title: id.slice(0, 8) }, ctx, error) });
      continue;
    }
    const { error, touched } = await runOnCard(action, task, deps);
    executed.push({ ...base, ok: !error, target, text: cardSentence(action, task, ctx, error), ...(error ? { error } : {}) });
    if (error) continue;
    if (action.type === "archive_task") unarchive.push(...(touched ?? [task]).map((t) => t.id));
    // Undo of a move puts the card back where it was: one action per
    // card, since a batch's cards may have come from different places.
    if (action.type === "move_task") inverse.push({ type: "move_task", tier: "A", taskIds: [task.id], batch: false, status: task.status });
  }
  if (unarchive.length) inverse.push({ type: "unarchive_task", tier: "A", taskIds: [...new Set(unarchive)], batch: action.batch });
  return { executed, inverse };
}
