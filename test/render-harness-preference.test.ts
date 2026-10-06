import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { describeAgentHarnesses, formatHarnessCapacity, harnessPreferenceState } from "../src/api/public/render-harness-preference.js";
import type { AgentDef, Harness } from "../src/core/types.ts";

// docs/SDD-agent-harness-preference.md §3.7 (card 2): the board shows an
// agent's preferred harness list with each entry's live state, and the
// Manage harnesses panel shows maxConcurrent as active/max.

function harness(overrides: Partial<Harness> & Pick<Harness, "id">): Harness {
  return { tool: "claude-cli", label: overrides.id, enabled: true, ...overrides };
}

function agent(id: string, harnesses?: string[]): AgentDef {
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
    costProfile: { model: "claude-sonnet-5-5", estUsdPerTask: 0.01 },
    ...(harnesses ? { harnesses } : {}),
  };
}

test("formatHarnessCapacity: active/max whenever maxConcurrent is set (even idle), N active only while busy otherwise", () => {
  expect(formatHarnessCapacity({ id: "a", enabled: true, activeCount: 0, maxConcurrent: 2 })).toBe("0/2 active");
  expect(formatHarnessCapacity({ id: "a", enabled: true, activeCount: 2, maxConcurrent: 2 })).toBe("2/2 active");
  expect(formatHarnessCapacity({ id: "a", enabled: true, activeCount: 3 })).toBe("3 active");
  expect(formatHarnessCapacity({ id: "a", enabled: true, activeCount: 0 })).toBeNull();
  expect(formatHarnessCapacity({ id: "a", enabled: true })).toBeNull();
});

test("harnessPreferenceState matches acquire()'s rules: disabled beats capacity, at max is full, missing is unknown", () => {
  expect(harnessPreferenceState({ id: "a", enabled: true, activeCount: 1, maxConcurrent: 2 })).toBe("available");
  expect(harnessPreferenceState({ id: "a", enabled: true, activeCount: 2, maxConcurrent: 2 })).toBe("full");
  expect(harnessPreferenceState({ id: "a", enabled: true, activeCount: 50 })).toBe("available");
  expect(harnessPreferenceState({ id: "a", enabled: false, activeCount: 2, maxConcurrent: 2 })).toBe("disabled");
  expect(harnessPreferenceState(undefined)).toBe("unknown");
});

test("describeAgentHarnesses: no list (undefined or empty) means any enabled harness", () => {
  for (const a of [{}, { harnesses: [] }, undefined]) {
    const desc = describeAgentHarnesses(a, [{ id: "x", enabled: true }]);
    expect(desc).toEqual({ any: true, entries: [], text: "Runs on: any enabled harness" });
  }
});

test("describeAgentHarnesses: keeps the agent's order, not the pool's, and names each entry's state", () => {
  const pool = [
    { id: "claude", label: "Personal", enabled: false, activeCount: 0 },
    { id: "claude-adevinta", label: "Adevinta", enabled: true, activeCount: 1, maxConcurrent: 2 },
    { id: "unlisted", label: "Unlisted", enabled: true, activeCount: 0 },
  ];
  const desc = describeAgentHarnesses({ harnesses: ["claude-adevinta", "claude", "gone"] }, pool);
  expect(desc.any).toBe(false);
  expect(desc.entries.map((e) => [e.id, e.state])).toEqual([
    ["claude-adevinta", "available"],
    ["claude", "disabled"],
    ["gone", "unknown"],
  ]);
  expect(desc.text).toBe("Runs on: 1. Adevinta (enabled · 1/2 active) → 2. Personal (disabled) → 3. gone (not configured)");
  expect(desc.text).not.toContain("Unlisted");
});

// Real data flow: the exact JSON the board fetches (GET /agents, GET
// /harnesses from a real createApp) drives the description, with a live
// in-flight run counted by HarnessPool.acquire.
test("GET /agents + GET /harnesses from a real app drive the description, including live active/max", async () => {
  const pool = HarnessPool.from([
    harness({ id: "first", label: "First", maxConcurrent: 1 }),
    harness({ id: "second", label: "Second", maxConcurrent: 3 }),
    harness({ id: "off", label: "Off", enabled: false }),
  ]);
  const app = createApp(new SqliteBoard(), Registry.from([agent("picky", ["first", "off", "second"]), agent("easy")]), undefined, { harnesses: pool });
  const fetchBoardData = async () => ({
    agents: (await (await app(new Request("http://localhost/agents"))).json()) as AgentDef[],
    harnesses: (await (await app(new Request("http://localhost/harnesses"))).json()) as Parameters<typeof describeAgentHarnesses>[1],
  });

  let data = await fetchBoardData();
  const picky = () => data.agents.find((a) => a.id === "picky");
  expect(describeAgentHarnesses(picky(), data.harnesses).text).toBe(
    "Runs on: 1. First (enabled · 0/1 active) → 2. Off (disabled) → 3. Second (enabled · 0/3 active)",
  );
  expect(describeAgentHarnesses(data.agents.find((a) => a.id === "easy"), data.harnesses).any).toBe(true);

  // One run takes "first" (the agent's top choice) to capacity.
  expect(pool.acquire("claude-cli", undefined, ["first", "off", "second"])?.id).toBe("first");
  data = await fetchBoardData();
  const desc = describeAgentHarnesses(picky(), data.harnesses);
  expect(desc.entries.map((e) => e.state)).toEqual(["full", "disabled", "available"]);
  expect(desc.text).toBe("Runs on: 1. First (at capacity · 1/1 active) → 2. Off (disabled) → 3. Second (enabled · 0/3 active)");
  expect(formatHarnessCapacity(data.harnesses!.find((h) => h.id === "first")!)).toBe("1/1 active");
});

test("GET /render-harness-preference.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([agent("easy")]), undefined, { harnesses: HarnessPool.from([]) });
  const res = await app(new Request("http://localhost/render-harness-preference.js"));
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("function describeAgentHarnesses(");
  expect(body).toContain("function formatHarnessCapacity(");
});
