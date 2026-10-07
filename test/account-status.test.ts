import { expect, test } from "bun:test";
import { buildAccountStatus } from "../src/core/account-status.ts";
import { Registry } from "../src/core/registry.ts";
import {
  describeAccountChip,
  shortAccountLabel,
  shortModelName,
  summarizeRunningModels,
} from "../src/api/public/render-harness-preference.js";
import type { AgentDef, Harness, PipelineDef, TaskCard } from "../src/core/types.ts";

// The board's account line (GET /status/accounts): which enabled
// harnesses are working and on which models.

function harness(overrides: Partial<Harness> & Pick<Harness, "id">): Harness {
  return { tool: "claude-cli", label: overrides.id, enabled: true, ...overrides };
}

function agent(id: string, model: string): AgentDef {
  return {
    id,
    name: id,
    kind: "agent",
    tier: "readonly",
    description: "test agent",
    whenToUse: "test only",
    tags: ["intake"],
    executor: "readonly",
    inputs: [],
    outputs: [],
    trustLevel: "low",
    toolAccess: ["read"],
    costProfile: { model, estUsdPerTask: 0.01 },
  };
}

function task(overrides: Partial<TaskCard> & Pick<TaskCard, "id">): TaskCard {
  return { title: `task ${overrides.id}`, body: "", labels: [], status: "running", ...overrides };
}

const registry = Registry.from([agent("implementer", "claude-opus-5-5"), agent("triager", "claude-haiku-4-5")]);
const noLoad = () => 0;

test("disabled harnesses are left out; enabled ones keep pool order", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "claude" }), harness({ id: "claude-adevinta", enabled: false }), harness({ id: "codex", tool: "codex-cli" })],
    tasks: [],
    agents: registry,
    activeCount: noLoad,
  });
  expect(rows.map((r) => r.id)).toEqual(["claude", "codex"]);
});

test("a running task stamped with a disabled harness is not shown on any chip", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "claude" }), harness({ id: "off", enabled: false })],
    tasks: [task({ id: "t1", harness: "off", routedTo: "implementer" })],
    agents: registry,
    activeCount: noLoad,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.running).toEqual([]);
});

test("idle harness: defaultModel when the harness sets one, absent otherwise; maxConcurrent and activeCount pass through", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "a", model: "claude-sonnet-5-5", maxConcurrent: 3 }), harness({ id: "b", label: "Bee", tool: "anthropic-api" })],
    tasks: [],
    agents: registry,
    activeCount: (id) => (id === "a" ? 2 : 0),
  });
  expect(rows).toEqual([
    { id: "a", label: "a", tool: "claude-cli", activeCount: 2, maxConcurrent: 3, defaultModel: "claude-sonnet-5-5", running: [] },
    { id: "b", label: "Bee", tool: "anthropic-api", activeCount: 0, running: [] },
  ]);
  expect("defaultModel" in rows[1]!).toBe(false);
  expect("maxConcurrent" in rows[1]!).toBe(false);
});

test("running tasks group under their harness with resolveModel's answer: task.model > harness.model > agent default", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "plain" }), harness({ id: "pinned", model: "claude-sonnet-5-5" })],
    tasks: [
      task({ id: "agent-default", harness: "plain", routedTo: "implementer" }),
      task({ id: "task-override", harness: "plain", routedTo: "triager", model: "claude-fable-5-1" }),
      task({ id: "harness-model", harness: "pinned", routedTo: "implementer" }),
      task({ id: "task-beats-harness", harness: "pinned", routedTo: "implementer", model: "claude-haiku-4-5" }),
      task({ id: "not-running", harness: "plain", routedTo: "implementer", status: "done" }),
    ],
    agents: registry,
    activeCount: noLoad,
  });
  expect(rows[0]!.running).toEqual([
    { taskId: "agent-default", title: "task agent-default", agentId: "implementer", model: "claude-opus-5-5" },
    { taskId: "task-override", title: "task task-override", agentId: "triager", model: "claude-fable-5-1" },
  ]);
  expect(rows[1]!.running).toEqual([
    { taskId: "harness-model", title: "task harness-model", agentId: "implementer", model: "claude-sonnet-5-5" },
    { taskId: "task-beats-harness", title: "task task-beats-harness", agentId: "implementer", model: "claude-haiku-4-5" },
  ]);
});

test("a running task with no harness stamp is not attributed to any chip", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "only" })],
    tasks: [task({ id: "unstamped", routedTo: "implementer" })],
    agents: registry,
    activeCount: noLoad,
  });
  expect(rows[0]!.running).toEqual([]);
});

test("an unknown agent, or no agent at all, gives model null instead of a guess (and doesn't throw)", () => {
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "h", model: "claude-sonnet-5-5" })],
    tasks: [task({ id: "ghost", harness: "h", routedTo: "no-such-agent" }), task({ id: "unrouted", harness: "h" })],
    agents: registry,
    activeCount: noLoad,
  });
  expect(rows[0]!.running).toEqual([
    { taskId: "ghost", title: "task ghost", agentId: "no-such-agent", model: null },
    { taskId: "unrouted", title: "task unrouted", agentId: null, model: null },
  ]);
});

test("a pipeline step card (no routedTo) takes its agent from the stored pipeline step", () => {
  const pipeline: PipelineDef = {
    id: "p1",
    name: "P",
    description: "",
    graph: { steps: [{ id: "s1", name: "Triage", agentId: "triager", transition: "choose" }], edges: [] },
    createdAt: "",
    updatedAt: "",
  };
  const rows = buildAccountStatus({
    harnesses: [harness({ id: "h" })],
    tasks: [
      task({ id: "step", harness: "h", pipelineId: "p1", pipelineStepId: "s1" }),
      task({ id: "lost-step", harness: "h", pipelineId: "p1", pipelineStepId: "gone" }),
    ],
    agents: registry,
    activeCount: noLoad,
    pipelines: [pipeline],
  });
  expect(rows[0]!.running).toEqual([
    { taskId: "step", title: "task step", agentId: "triager", model: "claude-haiku-4-5" },
    { taskId: "lost-step", title: "task lost-step", agentId: null, model: null },
  ]);
});

// ---- browser side: render-harness-preference.js's chip helpers ----

test("shortAccountLabel keeps short labels, cuts long ones to after the dash, emails to their provider", () => {
  expect(shortAccountLabel("codex")).toBe("codex");
  expect(shortAccountLabel("Claude — personal")).toBe("Claude — personal");
  expect(shortAccountLabel("Claude — milton.cyrus@gmail.com")).toBe("Claude (gmail)");
  expect(shortAccountLabel("Some very long account name - work laptop")).toBe("work laptop");
  expect(shortAccountLabel("averyveryverylonglabelwithnodash")).toBe("averyveryverylonglabelwithnodash");
});

test("shortModelName drops the claude- prefix and a date suffix only", () => {
  expect(shortModelName("claude-opus-5-5")).toBe("opus-5-5");
  expect(shortModelName("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  expect(shortModelName("gpt-5-codex")).toBe("gpt-5-codex");
});

test("summarizeRunningModels: distinct models in first-seen order with ×N; null reads unknown model", () => {
  const run = (model: string | null) => ({ taskId: "x", title: "x", agentId: "a", model });
  expect(summarizeRunningModels([run("claude-opus-5-5"), run("claude-sonnet-5-5"), run("claude-opus-5-5")])).toBe("opus-5-5 ×2, sonnet-5-5");
  expect(summarizeRunningModels([run(null)])).toBe("unknown model");
});

test("describeAccountChip: idle chip shows its pinned defaultModel or no model at all, load via formatHarnessCapacity", () => {
  const idle = describeAccountChip({ id: "codex", label: "codex", tool: "codex-cli", activeCount: 0, running: [] });
  expect(idle).toMatchObject({ label: "codex", tool: "codex-cli", load: "idle", models: "", busy: false });
  expect(idle.text).toBe("codex · idle");
  expect(idle.title).toContain("(codex-cli)");
  expect(idle.title).toContain("each agent's own model");

  const capped = describeAccountChip({ id: "a", label: "A", tool: "anthropic-api", activeCount: 0, maxConcurrent: 2, defaultModel: "claude-sonnet-5-5", running: [] });
  expect(capped).toMatchObject({ load: "0/2 active", models: "sonnet-5-5", busy: false });
  expect(capped.text).toBe("A · 0/2 active · sonnet-5-5");
});

test("describeAccountChip: busy chip lists running models, and its title lists each task with agent and model", () => {
  const chip = describeAccountChip({
    id: "claude",
    label: "Claude — milton.cyrus@gmail.com",
    tool: "claude-cli",
    activeCount: 2,
    running: [
      { taskId: "1", title: "Fix login", agentId: "implementer", model: "claude-opus-5-5" },
      { taskId: "2", title: "Review it", agentId: "reviewer", model: "claude-sonnet-5-5" },
    ],
  });
  expect(chip).toMatchObject({ label: "Claude (gmail)", load: "2 active", models: "opus-5-5, sonnet-5-5", busy: true });
  expect(chip.title).toContain("Claude — milton.cyrus@gmail.com (claude-cli)");
  expect(chip.title).toContain("• Fix login · implementer · claude-opus-5-5");
  expect(chip.title).toContain("• Review it · reviewer · claude-sonnet-5-5");
});

test("describeAccountChip: running tasks with no pool count (e.g. after a restart) still read as running", () => {
  const chip = describeAccountChip({ id: "h", label: "h", tool: "claude-cli", activeCount: 0, running: [{ taskId: "1", title: "t", agentId: null, model: null }] });
  expect(chip).toMatchObject({ load: "1 running", models: "unknown model", busy: true });
  expect(chip.title).toContain("• t · unknown agent · unknown model");
});
