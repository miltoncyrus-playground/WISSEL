import { expect, test } from "bun:test";
import { resolveModel } from "../src/core/model-resolution.ts";
import type { AgentDef, Harness, TaskCard } from "../src/core/types.ts";

const agent: AgentDef = {
  id: "triager",
  name: "Triager",
  kind: "agent",
  tier: "readonly",
  description: "d",
  whenToUse: "w",
  tags: [],
  executor: "readonly",
  inputs: [],
  outputs: [],
  trustLevel: "low",
  toolAccess: [],
  costProfile: { model: "agent-default-model", estUsdPerTask: 0.03 },
};

const task: TaskCard = { id: "t1", title: "t", body: "", labels: [], repo: "/tmp", status: "ready" };

const harness: Harness = { id: "h", tool: "claude-cli", label: "H", enabled: true, model: "harness-default-model" };

test("falls through to agent.costProfile.model when neither task nor harness set one", () => {
  expect(resolveModel(task, agent)).toBe("agent-default-model");
  expect(resolveModel(task, agent, { ...harness, model: undefined })).toBe("agent-default-model");
});

test("harness.model beats agent.costProfile.model when task.model is absent", () => {
  expect(resolveModel(task, agent, harness)).toBe("harness-default-model");
});

test("task.model beats both harness.model and agent.costProfile.model", () => {
  expect(resolveModel({ ...task, model: "task-model" }, agent, harness)).toBe("task-model");
});

test("task.model beats agent.costProfile.model with no harness given at all", () => {
  expect(resolveModel({ ...task, model: "task-model" }, agent)).toBe("task-model");
});
