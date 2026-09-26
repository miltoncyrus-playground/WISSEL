import { describe, expect, test } from "vitest";
import { flowToGraph, graphToFlow, incomingCounts, positionsOf } from "../src/graph";
import type { PipelineGraph } from "../src/types";

const graph: PipelineGraph = {
  steps: [
    { id: "a", name: "A", agentId: "implementer", transition: "choose" },
    { id: "b", name: "B", agentId: "reviewer", transition: "choose", joinMode: "all" },
    { id: "c", name: "C", agentId: "reviewer", transition: "all" },
  ],
  edges: [
    { id: "e1", from: "a", to: "b", label: "approve" },
    { id: "e2", from: "c", to: "b" },
  ],
};

describe("graphToFlow / flowToGraph round trip", () => {
  test("graphToFlow produces one node per step and one edge per edge, preserving ids/fields", () => {
    const { nodes, edges } = graphToFlow(graph);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(nodes.map((n) => n.data.step)).toEqual(graph.steps);
    expect(edges.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(edges[0]).toMatchObject({ source: "a", target: "b", label: "approve" });
    expect(edges[1]).toMatchObject({ source: "c", target: "b" });
  });

  test("flowToGraph is the exact inverse of graphToFlow for a graph with no positions given", () => {
    const { nodes, edges } = graphToFlow(graph);
    expect(flowToGraph(nodes, edges)).toEqual(graph);
  });

  test("save-then-reload round trip: flowToGraph(graphToFlow(g)) === g even after mutating node data in place", () => {
    const { nodes, edges } = graphToFlow(graph);
    const renamed = nodes.map((n) => (n.id === "a" ? { ...n, data: { ...n.data, step: { ...n.data.step, name: "Renamed A" } } } : n));
    const result = flowToGraph(renamed, edges);
    expect(result.steps[0]).toEqual({ ...graph.steps[0], name: "Renamed A" });
    expect(result.steps[1]).toEqual(graph.steps[1]);
    expect(result.edges).toEqual(graph.edges);
  });

  test("an edge with no label round-trips as undefined, not an empty string or missing key with a stray value", () => {
    const unlabeled: PipelineGraph = { steps: graph.steps, edges: [{ id: "e3", from: "a", to: "c" }] };
    const { nodes, edges } = graphToFlow(unlabeled);
    expect(edges[0]!.label).toBeUndefined();
    expect(flowToGraph(nodes, edges).edges[0]!.label).toBeUndefined();
  });

  test("graphToFlow lays out unpositioned steps on a deterministic grid, never stacking two steps at the same point", () => {
    const many: PipelineGraph = {
      steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, agentId: "a", transition: "choose" as const })),
      edges: [],
    };
    const { nodes } = graphToFlow(many);
    const positions = nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(positions).size).toBe(nodes.length);
  });

  test("graphToFlow reuses a given position for a known step id instead of the default grid", () => {
    const { nodes } = graphToFlow(graph, { a: { x: 999, y: 111 } });
    expect(nodes[0]!.position).toEqual({ x: 999, y: 111 });
    // b/c weren't given explicit positions, so they still fall back to
    // the deterministic grid rather than inheriting a's override.
    expect(nodes[1]!.position).not.toEqual({ x: 999, y: 111 });
  });
});

describe("incomingCounts", () => {
  test("counts incoming edges per target step id, from PipelineEdgeDef[] input", () => {
    const counts = incomingCounts(graph.edges);
    expect(counts.get("b")).toBe(2);
    expect(counts.get("a")).toBeUndefined();
    expect(counts.get("c")).toBeUndefined();
  });

  test("counts incoming edges per target step id, from React Flow Edge[] input (source/target, not from/to)", () => {
    const { edges } = graphToFlow(graph);
    const counts = incomingCounts(edges);
    expect(counts.get("b")).toBe(2);
  });

  test("a step with exactly one incoming edge is not >1, so the join-mode toggle in StepNode stays hidden for it", () => {
    const counts = incomingCounts(graph.edges);
    expect((counts.get("a") ?? 0) > 1).toBe(false);
  });
});

describe("positionsOf", () => {
  test("captures every node's current position, keyed by id", () => {
    const { nodes } = graphToFlow(graph, { a: { x: 5, y: 6 } });
    const positions = positionsOf(nodes);
    expect(positions.a).toEqual({ x: 5, y: 6 });
    expect(Object.keys(positions).sort()).toEqual(["a", "b", "c"]);
  });
});
