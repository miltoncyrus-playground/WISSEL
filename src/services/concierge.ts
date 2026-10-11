// Ask wissel (docs/SDD-wissel-app.md §3.4): one chat message in, one
// reply and at most three board actions out. The model call is the only
// latent part; around it everything is code: the context is built by
// concierge-context.ts, the reply is parsed and every action validated
// by concierge-actions.ts, and only then does anything touch the board.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Board } from "./board.ts";
import type { PipelineStore } from "./pipelines.ts";
import type { ProjectStore } from "./projects.ts";
import type { TelemetryLog } from "./telemetry.ts";
import type { Registry } from "../core/registry.ts";
import type { Router } from "../core/router.ts";
import type { HarnessPool } from "../core/harness-pool.ts";
import type { AgentDef, Executor, PipelineDef, TaskCard, TaskResult } from "../core/types.ts";
import { stepsNeedingRepo } from "../core/pipeline-runner.ts";
import { resolveScratchWorkspace } from "./scratch-workspace.ts";
import { buildConciergeContext, chatLabels, HISTORY_MESSAGES } from "./concierge-context.ts";
import { droppedNote, parseConciergeOutput, proseOf, validateActions, type ActionContext, type DroppedAction, type ValidAction } from "./concierge-actions.ts";
import type { ChatMessage, Conversation, ExecutedAction, SqliteConversationStore } from "./conversations.ts";

export const CONCIERGE_AGENT_ID = "concierge";

/** A chat message is at most this long. */
export const MAX_MESSAGE_LENGTH = 4000;

/** What goes out on `/events` as a named `ask` event, so a second tab or
 *  phone sees "thinking" too. Named (not a plain message) so /board,
 *  which refetches on every plain message, never sees it. */
export type AskEvent =
  | { type: "ask.thinking"; conversationId: string; messageId: string }
  | { type: "ask.replied"; conversationId: string; messageId: string };

export interface ConciergeDeps {
  board: Board;
  registry: Registry;
  router: Router;
  pipelines: PipelineStore;
  projects: ProjectStore;
  harnesses: HarnessPool;
  conversations: SqliteConversationStore;
  /** Runs the concierge agent: a ReadOnlyExecutor in the server, built
   *  with a scripted runner in tests and e2e. */
  executor: Executor;
  telemetry?: TelemetryLog;
  /** Starts a pipeline run and resolves with its root card as soon as
   *  it exists; the run itself carries on in the background. */
  startPipeline(pipeline: PipelineDef, input: string): Promise<TaskCard>;
  events?: EventEmitter;
  now?: () => Date;
  /** Where the shared scratch cwd lives (`<home>/.wissel/scratch/
   *  ask-concierge`); tests point it at a temp dir. */
  homeDir?: string;
}

export interface AskResult {
  conversation: Conversation;
  user: ChatMessage;
  assistant: ChatMessage;
}

export class AskError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

/** The reply when the run itself failed: short, and says nothing changed. */
export function failureReply(result: TaskResult): string {
  if (result.retryAfter) {
    const at = new Date(result.retryAfter);
    const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    return `Claude's usage limit is reached until ${hhmm}. Nothing was changed. Try again then.`;
  }
  const first = result.summary.split("\n")[0]!.slice(0, 200);
  return `I could not answer that: ${first}. Nothing was changed.`;
}

export function createConcierge(deps: ConciergeDeps) {
  const events = deps.events ?? new EventEmitter();
  const now = deps.now ?? (() => new Date());

  const emit = (e: AskEvent) => events.emit("ask", e);

  /** The label set as a lookup key: order and repeats don't matter. */
  const labelKey = (labels: string[]) => JSON.stringify([...new Set(labels.map((l) => l.trim()))].sort());

  async function actionContext(proposed: unknown[], tasks: TaskCard[], pipelines: PipelineDef[], agentList: AgentDef[]): Promise<ActionContext> {
    const projects = await deps.projects.list();
    // Same rule as POST /tasks: a confident route to an agent with file
    // or bash access needs a repo. Routing is async, validation is not,
    // so every proposed card's labels are routed here first.
    const needsRepo = new Map<string, string | undefined>();
    for (const a of proposed) {
      const labels = (a as { labels?: unknown })?.labels;
      if (!Array.isArray(labels) || !labels.every((l) => typeof l === "string")) continue;
      const key = labelKey(labels as string[]);
      if (needsRepo.has(key)) continue;
      const decision = await deps.router.route({ id: "ask-repo-check", title: "", body: "", labels: JSON.parse(key) as string[], status: "inbox" });
      const agent = decision.confident && decision.selected ? deps.registry.get(decision.selected) : undefined;
      needsRepo.set(key, agent && (agent.toolAccess.includes("write") || agent.toolAccess.includes("bash")) ? agent.id : undefined);
    }
    return {
      projects,
      pipelines,
      knownLabels: chatLabels(agentList, CONCIERGE_AGENT_ID),
      taskIds: tasks.map((t) => t.id),
      repoRequiredBy: (labels) => needsRepo.get(labelKey(labels)),
      pipelineNeedsRepo: (id) => {
        const p = pipelines.find((x) => x.id === id);
        return p ? stepsNeedingRepo(p, deps.registry).length > 0 : false;
      },
    };
  }

  async function execute(action: ValidAction): Promise<ExecutedAction> {
    try {
      if (action.type === "create_task") {
        const task = await deps.board.create({ title: action.title, body: action.body, labels: action.labels, ...(action.repo ? { repo: action.repo } : {}) });
        return { type: "create_task", ok: true, taskId: task.id, title: task.title };
      }
      if (action.type === "run_pipeline") {
        const pipeline = await deps.pipelines.get(action.pipelineId);
        if (!pipeline) return { type: "run_pipeline", ok: false, error: "the pipeline is gone", name: action.name };
        const root = await deps.startPipeline(pipeline, action.input ?? "");
        return { type: "run_pipeline", ok: true, runId: root.id, name: pipeline.name, pipelineId: pipeline.id };
      }
      return { type: "show_task", ok: true, taskId: action.id };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        type: action.type,
        ok: false,
        error,
        ...(action.type === "create_task" ? { title: action.title } : action.type === "run_pipeline" ? { name: action.name } : {}),
      };
    }
  }

  /** Runs the model, or says why it can't, as reply text plus proposed actions. */
  async function think(messageId: string, text: string, history: ChatMessage[]) {
    const agent = deps.registry.get(CONCIERGE_AGENT_ID);
    if (!agent) return { reply: "Ask is not set up: there is no concierge agent in agents/manifest.yaml.", proposed: [] as unknown[] };

    const [tasks, pipelines, projects] = await Promise.all([deps.board.list(), deps.pipelines.list(), deps.projects.list()]);
    const nonce = randomUUID().slice(0, 8);
    const body = buildConciergeContext({
      tasks,
      pipelines,
      projects,
      accounts: deps.harnesses
        .all()
        .filter((h) => h.enabled)
        .map((h) => ({ id: h.id, label: h.label, activeCount: deps.harnesses.activeCount(h.id), ...(h.maxConcurrent !== undefined ? { maxConcurrent: h.maxConcurrent } : {}) })),
      knownLabels: chatLabels(deps.registry.all(), CONCIERGE_AGENT_ID),
      history: history.slice(-HISTORY_MESSAGES).map((m) => ({ role: m.role, text: m.text })),
      message: text,
      nonce,
      now: now().toISOString(),
    });
    // Not a board card: an id of its own so telemetry can name the run
    // (`ask-` keeps it apart from task ids). `repo` is one shared empty
    // scratch directory as the cwd: the agent has no tools, and a fresh
    // directory per message would only pile up.
    const runTask: TaskCard = {
      id: `ask-${messageId}`,
      title: "Answer Milton's message in the Ask chat",
      body,
      labels: [],
      status: "running",
      repo: await resolveScratchWorkspace("ask-concierge", deps.homeDir),
    };

    // Acquired last, right before the try that releases it: anything that
    // throws above can't leave the account's slot held.
    const tool = deps.executor.harnessTool;
    const harness = tool ? deps.harnesses.acquire(tool, undefined, agent.harnesses) : undefined;
    if (tool && !harness) {
      const names = agent.harnesses?.length ? agent.harnesses.join(", ") : tool;
      return { reply: `I can't reach Claude right now: the ${names} account is off or busy. Nothing was changed. Try again, or use the board.`, proposed: [] };
    }

    let result: TaskResult;
    try {
      await deps.telemetry?.record({
        type: "dispatch",
        taskId: runTask.id,
        agentId: agent.id,
        model: agent.costProfile.model,
        estimatedCost: agent.costProfile.estUsdPerTask,
      });
      result = await deps.executor.run(runTask, agent, harness);
    } catch (e) {
      result = { taskId: runTask.id, agentId: agent.id, ok: false, summary: `executor threw: ${(e as Error).message}` };
    } finally {
      if (harness) deps.harnesses.release(harness.id);
    }
    await deps.telemetry?.record({
      type: "result",
      taskId: runTask.id,
      agentId: agent.id,
      actualCost: result.actualCost,
      harnessId: harness?.id,
      ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}),
    });

    if (!result.ok) return { reply: failureReply(result), proposed: [], costUsd: result.actualCost };
    const parsed = parseConciergeOutput(result.summary);
    if (!parsed) {
      const prose = proseOf(result.summary);
      return { reply: prose ? `${prose}\n\n(No actions taken: my answer had no valid actions block.)` : "I could not read my own answer. Nothing was changed.", proposed: [], costUsd: result.actualCost };
    }
    return { reply: parsed.reply, proposed: parsed.actions, costUsd: result.actualCost, tasks, pipelines };
  }

  return {
    events,

    async ask(input: { conversationId?: unknown; text?: unknown }): Promise<AskResult> {
      if (typeof input.text !== "string" || input.text.trim() === "") throw new AskError("text is required", 400);
      const text = input.text.trim();
      if (text.length > MAX_MESSAGE_LENGTH) throw new AskError(`text is longer than ${MAX_MESSAGE_LENGTH} characters`, 400);
      if (input.conversationId !== undefined && input.conversationId !== null && typeof input.conversationId !== "string") {
        throw new AskError("conversationId must be a string", 400);
      }

      let conversation: Conversation;
      if (input.conversationId) {
        const found = deps.conversations.get(input.conversationId);
        if (!found) throw new AskError(`conversation not found: ${input.conversationId}`, 404);
        conversation = found;
      } else {
        conversation = deps.conversations.create(text, now().toISOString());
      }

      const history = deps.conversations.messages(conversation.id);
      const user = deps.conversations.add({ conversationId: conversation.id, role: "user", text, actions: [], dropped: [], at: now().toISOString() });
      emit({ type: "ask.thinking", conversationId: conversation.id, messageId: user.id });

      let reply: string;
      let executed: ExecutedAction[] = [];
      let dropped: DroppedAction[] = [];
      let costUsd: number | undefined;
      try {
        const out = await think(user.id, text, history);
        reply = out.reply;
        costUsd = out.costUsd;
        if (out.proposed.length > 0) {
          // Validated against the board as the model saw it.
          const tasks = out.tasks ?? (await deps.board.list());
          const pipelines = out.pipelines ?? (await deps.pipelines.list());
          const checked = validateActions(out.proposed, await actionContext(out.proposed, tasks, pipelines, deps.registry.all()));
          dropped = checked.dropped;
          for (const action of checked.valid) executed.push(await execute(action));
        }
      } catch (e) {
        reply = `Something went wrong: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`;
        executed = [];
      }

      const failed = executed.filter((a) => !a.ok);
      const notes = [droppedNote(dropped), failed.length ? `These did not work: ${failed.map((a) => (a.ok ? "" : a.error)).join("; ")}` : ""].filter(Boolean);
      const assistant = deps.conversations.add({
        conversationId: conversation.id,
        role: "assistant",
        text: [reply, ...notes].join("\n\n"),
        actions: executed,
        dropped,
        at: now().toISOString(),
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
      emit({ type: "ask.replied", conversationId: conversation.id, messageId: assistant.id });
      return { conversation: deps.conversations.get(conversation.id)!, user, assistant };
    },

    list: (limit?: number) => deps.conversations.list(limit),

    get(id: string): { conversation: Conversation; messages: ChatMessage[] } | undefined {
      const conversation = deps.conversations.get(id);
      return conversation ? { conversation, messages: deps.conversations.messages(id) } : undefined;
    },
  };
}

export type Concierge = ReturnType<typeof createConcierge>;
