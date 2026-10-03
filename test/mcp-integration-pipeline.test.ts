import { expect, test } from "bun:test";
import { Registry } from "../src/core/registry.ts";
import { buildMcpIntegrationPipelineGraph } from "../src/core/mcp-integration-pipeline.ts";

test("buildMcpIntegrationPipelineGraph shape: one coding step, one MCP-tool step, a single 'all' edge between them", () => {
  const graph = buildMcpIntegrationPipelineGraph();

  expect(graph.steps).toHaveLength(2);
  const codeStep = graph.steps.find((s) => s.id === "code")!;
  const toolStep = graph.steps.find((s) => s.id === "call-tool")!;
  expect(codeStep).toBeDefined();
  expect(toolStep).toBeDefined();
  expect(codeStep.agentId).toBe("implementer");
  expect(toolStep.agentId).toBe("mcp-tool-caller");

  // Neither step needs a pipeline-handoff contract — see the file's own
  // doc comment for why "all" needs no `next` at all.
  expect(codeStep.transition).toBe("all");
  expect(toolStep.transition).toBe("all");

  expect(graph.edges).toHaveLength(1);
  expect(graph.edges[0]).toMatchObject({ from: "code", to: "call-tool" });
});

test("buildMcpIntegrationPipelineGraph is pure: two calls return independent, mutable objects with identical content", () => {
  const a = buildMcpIntegrationPipelineGraph();
  const b = buildMcpIntegrationPipelineGraph();
  expect(a).toEqual(b);
  expect(a).not.toBe(b);
  expect(a.steps).not.toBe(b.steps);
  a.steps.push({ id: "mutated", name: "mutated", agentId: "implementer", transition: "all" });
  expect(b.steps).toHaveLength(2);
});

test("both agents the graph references are real, permanent entries in agents/manifest.yaml", async () => {
  const registry = await Registry.load();
  const graph = buildMcpIntegrationPipelineGraph();
  for (const step of graph.steps) {
    expect(registry.get(step.agentId)).toBeDefined();
  }
});

test("mcp-tool-caller (agents/manifest.yaml) is a readonly agent with a real mcpAccess grant — tier stays 'file/bash blast radius', orthogonal to MCP access", async () => {
  const registry = await Registry.load();
  const agent = registry.get("mcp-tool-caller")!;
  expect(agent.tier).toBe("readonly");
  expect(agent.executor).toBe("readonly");
  expect(agent.mcpAccess).toEqual([{ server: "wissel-echo-mcp", tools: ["echo", "echo_sensitive"] }]);
  expect(agent.reviewTarget).toBe("tool-calls");
  // Deliberately not shared with any other agent's tags — see this
  // agent's own manifest comment for the real collision `pipeline-reviewer`
  // hit from reusing a shared tag on a pipeline-only agent.
  const others = registry.all().filter((a) => a.id !== agent.id);
  for (const other of others) {
    expect(other.tags.some((t) => agent.tags.includes(t))).toBe(false);
  }
});
