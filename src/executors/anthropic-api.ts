import Anthropic from "@anthropic-ai/sdk";
import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../core/types.ts";
import { buildAgentPrompt } from "../core/prompt.ts";

/** $/1M tokens, current-generation models (see the claude-api skill's
 *  cached pricing table). Undefined for anything not listed here — an
 *  unknown model computes no actualCost rather than a guessed one;
 *  TaskResult.actualCost is documented as "when known." */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-fable-5-1": { input: 10.0, output: 50.0 },
  "claude-fable-5": { input: 10.0, output: 50.0 },
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-opus-4-8": { input: 5.0, output: 25.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

function computeCost(model: string, usage: Anthropic.Usage): number | undefined {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return undefined;
  return (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000;
}

/** Minimal surface this executor needs from an Anthropic client —
 *  injectable so tests never construct a real SDK client or spend a
 *  real token. */
export interface AnthropicMessagesClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ApiExecutorOptions {
  /** Defaults to `(apiKey) => new Anthropic(apiKey ? { apiKey } : {})` —
   *  an explicit key when a harness names one, otherwise the SDK's own
   *  ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login`
   *  resolution, identical to the ambient behavior every other executor
   *  falls back to when no harness is picked. */
  clientFactory?: (apiKey?: string) => AnthropicMessagesClient;
  maxTokens?: number;
}

/**
 * The lightweight path: a headless question in, an answer out, via the
 * raw Anthropic Messages API — no subprocess, no worktree, no file or
 * Bash tool access at all. For agents/skills that are genuinely just
 * "ask the model something," where claude-cli's whole agentic harness
 * (and the CLAUDE_CONFIG_DIR account model that comes with it) is more
 * than the task needs.
 *
 * Deliberately narrow: this is Q&A only. A task that needs to read the
 * actual repo (a diff, a file) belongs on ReadOnlyExecutor instead —
 * this executor only ever sees the task's title/body text.
 */
export class ApiExecutor implements Executor {
  readonly id = "anthropic-api";
  readonly harnessTool = "anthropic-api" as const;
  private clientFactory: (apiKey?: string) => AnthropicMessagesClient;
  private maxTokens: number;

  constructor(opts: ApiExecutorOptions = {}) {
    this.clientFactory = opts.clientFactory ?? ((apiKey) => new Anthropic(apiKey ? { apiKey } : {}));
    this.maxTokens = opts.maxTokens ?? 16_000;
  }

  canHandle(agent: AgentDef): boolean {
    return agent.tier === "readonly" && agent.executor === "api";
  }

  async run(task: TaskCard, agent: AgentDef, harness?: Harness): Promise<TaskResult> {
    let apiKey: string | undefined;
    if (harness?.apiKeyEnv) {
      apiKey = process.env[harness.apiKeyEnv];
      if (!apiKey) {
        return fail(task, agent, `harness "${harness.id}" names env var ${harness.apiKeyEnv} for its API key, but it isn't set`);
      }
    }

    const client = this.clientFactory(apiKey);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: agent.costProfile.model,
        max_tokens: this.maxTokens,
        messages: [{ role: "user", content: buildAgentPrompt(task, agent) }],
      });
    } catch (e) {
      return fail(task, agent, describeApiError(e));
    }

    if (response.stop_reason === "refusal") {
      const category = response.stop_details && "category" in response.stop_details ? response.stop_details.category : null;
      return fail(task, agent, `refused${category ? ` (${category})` : ""}`);
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const result: TaskResult = {
      taskId: task.id,
      agentId: agent.id,
      ok: true,
      summary: text || "(no text in response)",
      actualCost: computeCost(agent.costProfile.model, response.usage),
    };
    return harness ? { ...result, harnessId: harness.id } : result;
  }
}

function describeApiError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return `authentication failed: ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return `rate limited: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `API error (${e.status}): ${e.message}`;
  return `failed to call the Anthropic API: ${(e as Error).message}`;
}

function fail(task: TaskCard, agent: AgentDef, summary: string): TaskResult {
  return { taskId: task.id, agentId: agent.id, ok: false, summary };
}
