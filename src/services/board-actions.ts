// What the board's buttons do, once (docs/SDD-wissel-app.md §3.7). Each
// function is the body of one `POST /tasks/:id/...`, `/harnesses/:id/...`
// or `/mcp-servers/:id/...` route, moved out of server.ts so the route
// and Ask's control actions run the very same code: Ask never calls our
// own HTTP API and never has a second copy of an endpoint's checks.
//
// The `...Refusal` predicates are pure: Ask's validator
// (concierge-actions.ts) runs them up front to say why, and the
// functions here run them again on the board as it is when they act.

import type { Board } from "./board.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { McpServerPool, CheckMcpServerReachableOptions } from "../core/mcp-server-pool.ts";
import { checkMcpServerReachable } from "../core/mcp-server-pool.ts";
import { setMcpServerEnabled, setMcpServerToolTrust } from "../core/mcp-manifest.ts";
import { checkHarnessAuth } from "../core/harness-discovery.ts";
import { setHarnessEnabled, setHarnessModel } from "../core/harness-manifest.ts";
import { readModelsCache } from "../core/model-refresh-scheduler.ts";
import { validateExtraAllowedTools } from "../core/allowed-tools.ts";
import { validateNotBefore } from "../core/not-before.ts";
import { mergeTaskWorktree, removeTaskWorktree } from "./worktree.ts";
import type { CommandRunner } from "../executors/claude-cli.ts";
import type { Harness, McpServer, TaskCard, TaskResult } from "../core/types.ts";

/** A route's answer before it is a Response: the value on success, or
 *  the status and error it answers with. 404 routes answer "not found". */
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const no = (status: 400 | 404 | 409, error: string): Outcome<never> => ({ ok: false, status, error });

// ---------- pure predicates: undefined means allowed ----------

/** Merge and Discard need a worktree (a write-tier run's result). */
export function worktreeRefusal(result: Pick<TaskResult, "worktree"> | undefined, verb: "merge" | "discard"): string | undefined {
  return result?.worktree ? undefined : `task has no worktree to ${verb}`;
}

/** Abandon, approve, grant-and-retry and retry of an escalation. */
export function escalationRefusal(task: Pick<TaskCard, "status">): string | undefined {
  return task.status === "escalated" ? undefined : "task is not escalated";
}

/** Approve or deny an MCP tool call request. */
export function mcpApprovalRefusal(task: Pick<TaskCard, "status" | "pendingMcpApproval">): string | undefined {
  return task.status === "review" && task.pendingMcpApproval ? undefined : "task has no pending MCP approval request";
}

/** Per-card settings (tools, harness) change only while the card isn't
 *  running: a running card keeps what it started with. */
export function cardSettingsRefusal(task: Pick<TaskCard, "status">, what: "tools" | "harness"): string | undefined {
  return task.status === "running" || task.status === "dispatched" ? `task is ${task.status}; change its ${what} once it stops` : undefined;
}

/** A start time (TaskCard.notBefore) only means something on a card
 *  sweep() has yet to pick up: queued, not routed, not archived, and not
 *  a pipeline card (the pipeline runner starts those, never sweep). */
export function notBeforeRefusal(task: Pick<TaskCard, "status" | "routedTo" | "archivedAt" | "pipelineId">): string | undefined {
  if (task.archivedAt) return "task is archived; unarchive it to give it a start time";
  if (task.pipelineId !== undefined) return "a pipeline card starts with its pipeline, not on its own start time";
  if (task.status !== "inbox" && task.status !== "ready") return `task is ${task.status}; a start time only applies to a card in inbox or ready`;
  if (task.routedTo) return `task is already routed to ${task.routedTo}; it is past its start`;
  return undefined;
}

// ---------- tasks ----------

/** `POST /tasks/:id/merge`: commits and merges the worktree into
 *  task.repo, removes it, and moves the card to done. */
export async function mergeTask(board: Board, id: string, runner: CommandRunner): Promise<Outcome<{ merged: true; message: string; task: TaskCard }>> {
  const task = await board.get(id);
  if (!task) return no(404, "not found");
  const result = await board.getResult(id);
  const refused = worktreeRefusal(result, "merge");
  if (refused) return no(409, refused);
  // A worktree only ever exists for a write-tier run, which requires
  // `repo` at creation time (see POST /tasks) — never reachable for a
  // repo-less readonly task.
  const merge = await mergeTaskWorktree(task.repo!, result!.worktree!, task, runner);
  if (!merge.ok) return no(409, merge.message);
  const moved = await board.move(task.id, "done");
  return ok({ merged: true as const, message: merge.message, task: moved });
}

/** `POST /tasks/:id/discard`: removes the worktree and its branch
 *  without merging, and moves the card to failed. */
export async function discardTask(board: Board, id: string, runner: CommandRunner): Promise<Outcome<{ discarded: true; task: TaskCard }>> {
  const task = await board.get(id);
  if (!task) return no(404, "not found");
  const result = await board.getResult(id);
  const refused = worktreeRefusal(result, "discard");
  if (refused) return no(409, refused);
  await removeTaskWorktree(task.repo!, result!.worktree!, runner);
  const moved = await board.move(task.id, "failed");
  return ok({ discarded: true as const, task: moved });
}

/** `POST /tasks/:id/escalation/abandon`: gives up on an escalated card. */
export async function abandonEscalation(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = escalationRefusal(task);
  if (refused) return no(400, refused);
  return ok(await board.move(task.id, "failed"));
}

/** `POST /tasks/:id/mcp-approval/approve`: a new, narrow follow-up card
 *  scoped to exactly the one approved server and tool. See the route's
 *  comment in server.ts for why it is a new card, not a resumption. */
export async function approveMcpRequest(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = mcpApprovalRefusal(task);
  if (refused) return no(400, refused);
  const request = task.pendingMcpApproval!;
  const followUp = await board.create({
    title: `Approved MCP call: ${request.server}/${request.tool}`,
    body:
      `A human approved exactly one MCP tool call. Make exactly this one call, then end your turn — do not take any other action.\n\n` +
      `Server: ${request.server}\nTool: ${request.tool}\nArguments: ${JSON.stringify(request.args)}\n\n` +
      `Reason originally given for this call: ${request.reason}`,
    labels: task.labels,
    repo: task.repo,
    mcpAccessOverride: [{ server: request.server, tools: [request.tool] }],
  });
  await board.setSupersededBy(task.id, followUp.id);
  await board.move(task.id, "done");
  return ok(followUp);
}

/** `POST /tasks/:id/mcp-approval/deny`: no follow-up; the card fails. */
export async function denyMcpRequest(board: Board, task: TaskCard): Promise<Outcome<TaskCard>> {
  const refused = mcpApprovalRefusal(task);
  if (refused) return no(400, refused);
  return ok(await board.move(task.id, "failed"));
}

/** `POST /tasks/:id/allowed-tools`: replaces the card's per-card tool
 *  grants (`[]` clears), command-scoped Bash only. */
export async function setAllowedTools(board: Board, task: TaskCard, extraAllowedTools: unknown): Promise<Outcome<TaskCard>> {
  const refused = cardSettingsRefusal(task, "tools");
  if (refused) return no(409, refused);
  if (extraAllowedTools === undefined) return no(400, "body needs extraAllowedTools (a list; [] clears)");
  const grants = validateExtraAllowedTools(extraAllowedTools);
  if (!grants.ok) return no(400, grants.error);
  return ok(await board.setExtraAllowedTools(task.id, grants.tools));
}

/** `POST /tasks/:id/harness`: the harness a card asks to run on
 *  (TaskCard.harnessOverride), or null to clear it. Same rule as a new
 *  card's `harnessOverride` in POST /tasks: the harness must exist. */
export async function setTaskHarnessOverride(board: Board, harnesses: HarnessPool, task: TaskCard, harnessId: unknown): Promise<Outcome<TaskCard>> {
  const refused = cardSettingsRefusal(task, "harness");
  if (refused) return no(409, refused);
  if (harnessId !== null && typeof harnessId !== "string") return no(400, "body needs harness (a harness id, or null to clear)");
  if (typeof harnessId === "string" && !harnesses.get(harnessId)) return no(400, `unknown harness "${harnessId}"`);
  return ok(await board.setHarnessOverride(task.id, harnessId ?? undefined));
}

/** `POST /tasks/:id/not-before`: the card's start time
 *  (TaskCard.notBefore), or null to clear it. Same rules as a new
 *  card's `notBefore` in POST /tasks (validateNotBefore). */
export async function setTaskNotBefore(board: Board, task: TaskCard, notBefore: unknown, now: Date): Promise<Outcome<TaskCard>> {
  const refused = notBeforeRefusal(task);
  if (refused) return no(409, refused);
  if (notBefore === null) return ok(await board.setNotBefore(task.id, undefined));
  const check = validateNotBefore(notBefore, now);
  if (!check.ok) return no(400, check.error);
  return ok(await board.setNotBefore(task.id, check.notBefore));
}

// ---------- harnesses ----------

export interface HarnessControlDeps {
  harnesses: HarnessPool;
  /** harnesses.yaml, where a human's decision persists. */
  harnessesPath: string;
  /** For the enable re-check (checkHarnessAuth). */
  harnessRunner: CommandRunner;
  modelsCachePath: string;
  /** After a successful enable: held tasks are only re-checked on a
   *  sweep, and a harness toggle isn't a board event. */
  afterEnable?: () => void;
}

/** `POST /harnesses/:id/enable`: only for real. Re-runs the auth check
 *  first and refuses (409) a harness that still isn't signed in. */
export async function enableHarness(deps: HarnessControlDeps, harness: Harness): Promise<Outcome<Harness>> {
  const { authenticated } = await checkHarnessAuth(harness, { runner: deps.harnessRunner });
  if (!authenticated) {
    deps.harnesses.setEnabled(harness.id, false, "not authenticated");
    return no(409, "still not authenticated");
  }
  await setHarnessEnabled(deps.harnessesPath, harness, true);
  const enabled = deps.harnesses.setEnabled(harness.id, true)!;
  deps.afterEnable?.();
  return ok(enabled);
}

/** `POST /harnesses/:id/disable`. */
export async function disableHarness(deps: HarnessControlDeps, harness: Harness): Promise<Outcome<Harness>> {
  await setHarnessEnabled(deps.harnessesPath, harness, false);
  return ok(deps.harnesses.setEnabled(harness.id, false)!);
}

/** `POST /harnesses/:id/model`: sets or (undefined) clears the harness's
 *  default model. Refuses (400) a model outside the harness's cached
 *  list, when there is one; an empty cache has no opinion. */
export async function setHarnessDefaultModel(deps: HarnessControlDeps, harness: Harness, model: string | undefined): Promise<Outcome<Harness>> {
  if (model !== undefined) {
    const cache = await readModelsCache(deps.modelsCachePath);
    const availableModels = cache[harness.id]?.models ?? [];
    if (availableModels.length > 0 && !availableModels.includes(model)) {
      return no(400, `model "${model}" is not in the known model list for harness "${harness.id}"`);
    }
  }
  await setHarnessModel(deps.harnessesPath, harness, model);
  return ok(deps.harnesses.setModel(harness.id, model)!);
}

// ---------- MCP servers ----------

export interface McpControlDeps {
  mcpServers: McpServerPool;
  mcpServersPath: string;
  reachability: CheckMcpServerReachableOptions;
}

/** `POST /mcp-servers/:id/enable`: only for real, after a reachability
 *  re-check; refuses (409) with the reason otherwise. */
export async function enableMcpServer(deps: McpControlDeps, server: McpServer): Promise<Outcome<McpServer>> {
  const { reachable, reason } = await checkMcpServerReachable(server, deps.reachability);
  if (!reachable) {
    deps.mcpServers.setEnabled(server.id, false, reason ?? "not reachable");
    return no(409, reason ?? "not reachable");
  }
  await setMcpServerEnabled(deps.mcpServersPath, server, true);
  return ok(deps.mcpServers.setEnabled(server.id, true)!);
}

/** `POST /mcp-servers/:id/disable`. */
export async function disableMcpServer(deps: McpControlDeps, server: McpServer): Promise<Outcome<McpServer>> {
  await setMcpServerEnabled(deps.mcpServersPath, server, false);
  return ok(deps.mcpServers.setEnabled(server.id, false)!);
}

/** `POST /mcp-servers/:id/tools/:tool/trust`: 404 for a tool the server
 *  doesn't have, 400 for a trust that isn't one of the two. */
export async function setMcpToolTrust(deps: McpControlDeps, server: McpServer, toolName: string, trust: unknown): Promise<Outcome<McpServer>> {
  if (!server.tools.some((t) => t.name === toolName)) return no(404, "not found");
  if (trust !== "auto" && trust !== "approval-required") {
    return no(400, `trust must be "auto" or "approval-required", got ${JSON.stringify(trust)}`);
  }
  await setMcpServerToolTrust(deps.mcpServersPath, server, toolName, trust);
  return ok(deps.mcpServers.setToolTrust(server.id, toolName, trust)!);
}
