import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ApiExecutor, type AnthropicMessagesClient } from "../src/executors/anthropic-api.ts";
import type { AgentDef, Harness, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "quick-answer",
  name: "Quick answer",
  kind: "skill",
  tier: "readonly",
  description: "Answers a self-contained question with no repo access.",
  whenToUse: "A general question needing nothing from the repo.",
  tags: ["question"],
  executor: "api",
  inputs: ["question"],
  outputs: ["answer"],
  trustLevel: "low",
  toolAccess: [],
  costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
};

const task: TaskCard = {
  id: "t1",
  title: "What is the capital of France?",
  body: "",
  labels: ["question"],
  repo: "/tmp",
  status: "ready",
};

function textMessage(text: string, overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 } as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

function fakeClient(create: AnthropicMessagesClient["messages"]["create"]): (apiKey?: string) => AnthropicMessagesClient {
  return () => ({ messages: { create } });
}

test("canHandle only accepts readonly-tier agents with executor: api", () => {
  const executor = new ApiExecutor();
  expect(executor.canHandle(agent)).toBe(true);
  expect(executor.canHandle({ ...agent, executor: "readonly" })).toBe(false);
  expect(executor.canHandle({ ...agent, tier: "write" })).toBe(false);
});

test("calls the API with the agent's declared model and returns the response text", async () => {
  let seenParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async (params) => {
      seenParams = params;
      return textMessage("Paris.");
    }),
  });

  const result = await executor.run(task, agent);

  expect(seenParams?.model).toBe("claude-sonnet-5");
  expect(seenParams?.messages).toEqual([{ role: "user", content: expect.stringContaining(task.title) }]);
  expect(result).toEqual({ taskId: "t1", agentId: "quick-answer", ok: true, summary: "Paris.", actualCost: (100 * 2.0 + 20 * 10.0) / 1_000_000 });
});

test("joins multiple text blocks and ignores non-text blocks", async () => {
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () =>
      textMessage("", {
        content: [
          { type: "text", text: "Part one.", citations: null },
          { type: "text", text: "Part two.", citations: null },
        ],
      }),
    ),
  });

  const result = await executor.run(task, agent);
  expect(result.summary).toBe("Part one.\nPart two.");
});

test("computes no actualCost for a model with no pricing entry", async () => {
  const executor = new ApiExecutor({ clientFactory: fakeClient(async () => textMessage("hi", { model: "some-future-model" })) });
  const result = await executor.run(task, { ...agent, costProfile: { model: "some-future-model", estUsdPerTask: 0.01 } });
  expect(result.actualCost).toBeUndefined();
});

test("a refusal stop_reason becomes a failed TaskResult, not a throw", async () => {
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () =>
      textMessage("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } as never }),
    ),
  });

  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toBe("refused (cyber)");
});

test("a typed AuthenticationError becomes a clear failed TaskResult, not a throw", async () => {
  const err = new Anthropic.AuthenticationError(401, { error: { message: "invalid x-api-key" } }, "invalid x-api-key", new Headers());
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () => {
      throw err;
    }),
  });

  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("authentication failed");
});

test("a typed RateLimitError becomes a clear failed TaskResult, not a throw", async () => {
  const err = new Anthropic.RateLimitError(429, { error: { message: "rate limited" } }, "rate limited", new Headers());
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () => {
      throw err;
    }),
  });

  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("rate limited");
});

test("a generic thrown error becomes a failed TaskResult, not a throw", async () => {
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () => {
      throw new Error("network down");
    }),
  });

  const result = await executor.run(task, agent);
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("network down");
});

test("reads the API key from the harness's apiKeyEnv and reports harnessId on the result", async () => {
  process.env.WISSEL_TEST_ANTHROPIC_KEY = "sk-ant-test-123";
  try {
    let seenKey: string | undefined;
    const executor = new ApiExecutor({
      clientFactory: (apiKey) => {
        seenKey = apiKey;
        return { messages: { create: async () => textMessage("ok") } };
      },
    });
    const harness: Harness = { id: "my-key", tool: "anthropic-api", label: "My key", enabled: true, apiKeyEnv: "WISSEL_TEST_ANTHROPIC_KEY" };

    const result = await executor.run(task, agent, harness);

    expect(seenKey).toBe("sk-ant-test-123");
    expect(result.harnessId).toBe("my-key");
  } finally {
    delete process.env.WISSEL_TEST_ANTHROPIC_KEY;
  }
});

// The full model-resolution precedence order (see the doc comment next
// to CostProfile/Harness in types.ts): TaskCard.model beats
// Harness.model beats AgentDef.costProfile.model, and a constructor
// override (tests/evals only, and the new hook this subtask adds to
// ApiExecutor) beats all three of those. Mirrors readonly.test.ts's own
// precedence tests, the other executor of the pair this card's
// acceptance criteria calls out by name.
async function seenModel(opts: { task: TaskCard; harness?: Harness; ctorModel?: string }): Promise<string | undefined> {
  let seenParams: Anthropic.MessageCreateParamsNonStreaming | undefined;
  const executor = new ApiExecutor({
    model: opts.ctorModel,
    clientFactory: fakeClient(async (params) => {
      seenParams = params;
      return textMessage("ok");
    }),
  });
  await executor.run(opts.task, agent, opts.harness);
  return seenParams?.model;
}

test("model precedence: task.model beats harness.model and the agent's costProfile.model", async () => {
  const model = await seenModel({
    task: { ...task, model: "task-level-model" },
    harness: { id: "h", tool: "anthropic-api", label: "H", enabled: true, model: "harness-level-model" },
  });
  expect(model).toBe("task-level-model");
});

test("model precedence: harness.model beats the agent's costProfile.model when task.model is absent", async () => {
  const model = await seenModel({
    task,
    harness: { id: "h", tool: "anthropic-api", label: "H", enabled: true, model: "harness-level-model" },
  });
  expect(model).toBe("harness-level-model");
});

test("model precedence: falls through to the agent's costProfile.model when neither task nor harness sets one", async () => {
  const model = await seenModel({ task });
  expect(model).toBe(agent.costProfile.model);
});

test("model precedence: a constructor override wins over task.model, harness.model, and costProfile.model all at once", async () => {
  const model = await seenModel({
    task: { ...task, model: "task-level-model" },
    harness: { id: "h", tool: "anthropic-api", label: "H", enabled: true, model: "harness-level-model" },
    ctorModel: "ctor-level-model",
  });
  expect(model).toBe("ctor-level-model");
});

// computeCost reads the same resolved model, not the agent's raw
// costProfile.model — a task-level override must price against what
// actually ran, not the manifest default.
test("actualCost is computed against the resolved model, not the agent's raw costProfile.model", async () => {
  const executor = new ApiExecutor({
    clientFactory: fakeClient(async () => textMessage("hi")),
  });
  const result = await executor.run({ ...task, model: "claude-haiku-4-5" }, agent);
  expect(result.actualCost).toBe((100 * 1.0 + 20 * 5.0) / 1_000_000);
});

test("a harness naming an unset apiKeyEnv fails clearly instead of falling back to ambient", async () => {
  const executor = new ApiExecutor({ clientFactory: fakeClient(async () => textMessage("should not be called")) });
  const harness: Harness = { id: "broken", tool: "anthropic-api", label: "Broken", enabled: true, apiKeyEnv: "WISSEL_DEFINITELY_UNSET_VAR" };

  const result = await executor.run(task, agent, harness);

  expect(result.ok).toBe(false);
  expect(result.summary).toContain("WISSEL_DEFINITELY_UNSET_VAR");
});
