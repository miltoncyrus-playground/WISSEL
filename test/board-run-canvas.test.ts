import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import type { PipelineDef, TaskCard } from "../src/core/types.ts";
import { RUN_CANVAS_GEOMETRY, canvasLayers, runCanvasModel } from "../src/api/public/board-run-canvas.js";

// docs/SDD-ui-cleanup.md §4.3 (card B3): a pipeline run drawn as its
// graph, each step coloured by its live status.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");
const G = RUN_CANVAS_GEOMETRY;
const COL = G.nodeWidth + G.columnGap;
const ROW = G.nodeHeight + G.rowGap;

type T = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
const ids = (...xs: string[]) => xs.map((id) => ({ id }));
const edge = (from: string, to: string, label?: string) => ({ id: `${from}-${to}`, from, to, ...(label ? { label } : {}) });

// plan -> impl -> rev, rev loops back to impl ("changes requested"), rev -> ship.
const DEF: Pick<PipelineDef, "graph"> = {
  graph: {
    steps: [
      { id: "plan", name: "Planner", agentId: "planner", transition: "all" },
      { id: "impl", name: "Implementer", agentId: "implementer", transition: "all" },
      { id: "rev", name: "Reviewer", agentId: "reviewer", transition: "choose" },
      { id: "ship", name: "Ship", agentId: "shipper", transition: "all" },
    ],
    edges: [edge("plan", "impl"), edge("impl", "rev"), edge("rev", "impl", "changes"), edge("rev", "ship", "approved")],
  },
};

const ROOT: T = { id: "r1", status: "running", title: "Pipeline: Review loop", pipelineId: "p1" };
const step = (id: string, stepId: string, status: TaskCard["status"], extra: Partial<TaskCard> = {}): T => ({
  id, status, title: `Review loop: ${stepId}`, parentTaskId: "r1", pipelineRunId: "r1", pipelineStepId: stepId, ...extra,
});

test("canvasLayers: forward edges give each step its longest-path layer from the entry steps", () => {
  // a -> b -> d, a -> c -> d, and a shortcut a -> d: d sits after the longer path.
  const lay = canvasLayers(ids("a", "b", "c", "d"), [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("a", "d")]);
  expect(lay.layer).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  expect(Object.keys(lay.back)).toEqual([]);
  expect(lay.edges).toHaveLength(5);
});

test("canvasLayers: two entry steps both sit in layer 0", () => {
  const lay = canvasLayers(ids("a", "b", "c"), [edge("a", "c"), edge("b", "c")]);
  expect(lay.layer).toEqual({ a: 0, b: 0, c: 1 });
});

test("canvasLayers: an edge looping back is a back edge and doesn't bend the layering", () => {
  const lay = canvasLayers(DEF.graph.steps, DEF.graph.edges);
  expect(lay.back).toEqual({ "rev-impl": true });
  expect(lay.layer).toEqual({ plan: 0, impl: 1, rev: 2, ship: 3 });
});

test("canvasLayers: a self-loop is a back edge", () => {
  const lay = canvasLayers(ids("a", "b"), [edge("a", "a"), edge("a", "b")]);
  expect(lay.back).toEqual({ "a-a": true });
  expect(lay.layer).toEqual({ a: 0, b: 1 });
});

test("canvasLayers: a graph that is one cycle (no entry step) starts from the first step", () => {
  const lay = canvasLayers(ids("a", "b"), [edge("a", "b"), edge("b", "a")]);
  expect(lay.back).toEqual({ "b-a": true });
  expect(lay.layer).toEqual({ a: 0, b: 1 });
});

test("canvasLayers: an edge naming a step the graph doesn't have is dropped", () => {
  const lay = canvasLayers(ids("a", "b"), [edge("a", "b"), edge("a", "gone"), edge("gone", "b")]);
  expect(lay.edges.map((e) => e.id)).toEqual(["a-b"]);
  expect(lay.layer).toEqual({ a: 0, b: 1 });
});

test("runCanvasModel: one node per definition step, coloured by its latest card, pending where the run hasn't been", () => {
  const steps = [
    step("t-plan", "plan", "done"),
    step("t-impl-1", "impl", "done"),
    step("t-rev-1", "rev", "done"),
    step("t-impl-2", "impl", "running", { routedTo: "implementer" }),
  ];
  const m = runCanvasModel(ROOT, steps, DEF);
  expect(m.nodes.map((n) => [n.id, n.status, n.taskId, n.taskStatus, n.attempt])).toEqual([
    ["plan", "done", "t-plan", "done", 1],
    ["impl", "running", "t-impl-2", "running", 2],
    ["rev", "done", "t-rev-1", "done", 1],
    ["ship", "pending", null, null, 0],
  ]);
  expect(m.nodes.map((n) => n.name)).toEqual(["Planner", "Implementer", "Reviewer", "Ship"]);
  expect(m.nodes.every((n) => n.inDefinition)).toBe(true);
  // Left to right by layer, one row (no column holds two steps).
  expect(m.nodes.map((n) => [n.x, n.y])).toEqual([0, 1, 2, 3].map((l) => [G.pad + l * COL, G.pad]));
});

test("runCanvasModel: a reviewer's running card shows as reviewing, while taskStatus keeps the card's own status", () => {
  const m = runCanvasModel(ROOT, [step("t-rev", "rev", "running", { routedTo: "reviewer" })], DEF);
  const rev = m.nodes.find((n) => n.id === "rev")!;
  expect(rev.status).toBe("reviewing");
  expect(rev.taskStatus).toBe("running");
});

test("runCanvasModel: edges carry their label and back flag, and are reached once both ends have a card", () => {
  const m = runCanvasModel(ROOT, [step("t-plan", "plan", "done"), step("t-impl", "impl", "running")], DEF);
  const byId = Object.fromEntries(m.edges.map((e) => [e.id, e]));
  expect(byId["plan-impl"]).toMatchObject({ reached: true, back: false, label: "" });
  expect(byId["impl-rev"]).toMatchObject({ reached: false, back: false });
  expect(byId["rev-impl"]).toMatchObject({ reached: false, back: true, label: "changes" });
  expect(byId["rev-ship"]).toMatchObject({ reached: false, back: false, label: "approved" });

  // A forward edge runs from the right border of `from` to the left border of `to`.
  const plan = m.nodes[0]!, impl = m.nodes[1]!;
  const yMid = G.pad + G.nodeHeight / 2;
  expect(byId["plan-impl"]!.path.startsWith(`M${plan.x + G.nodeWidth},${yMid} `)).toBe(true);
  expect(byId["plan-impl"]!.path.endsWith(` ${impl.x},${yMid}`)).toBe(true);
  // A back edge dips below every node, so the canvas grows to hold it.
  const floor = G.pad + G.nodeHeight + G.backEdgeDrop;
  expect(byId["rev-impl"]!.path).toContain(`,${floor} `);
  expect(m.height).toBe(floor + G.pad);
});

test("runCanvasModel: a self-loop is drawn on the node's right edge, not under the canvas", () => {
  const def = { graph: { steps: [{ id: "a", name: "A", agentId: "x", transition: "all" as const }], edges: [edge("a", "a")] } };
  const m = runCanvasModel({ ...ROOT }, [], def);
  expect(m.edges[0]!.back).toBe(true);
  expect(m.edges[0]!.path.startsWith(`M${G.pad + G.nodeWidth},`)).toBe(true);
  expect(m.height).toBe(G.pad + G.nodeHeight + G.pad);
});

test("runCanvasModel: shorter columns are centred against the tallest", () => {
  const def = {
    graph: {
      steps: ["a", "b", "c", "d"].map((id) => ({ id, name: id, agentId: "x", transition: "all" as const })),
      edges: [edge("a", "b"), edge("a", "c"), edge("a", "d")],
    },
  };
  const m = runCanvasModel(ROOT, [], def);
  const at = Object.fromEntries(m.nodes.map((n) => [n.id, n.y]));
  expect([at.b, at.c, at.d]).toEqual([G.pad, G.pad + ROW, G.pad + 2 * ROW]);
  expect(at.a).toBe(G.pad + ROW);
});

test("runCanvasModel: a step card whose step the definition no longer has gets its own node in a last column", () => {
  const steps = [step("t-plan", "plan", "done"), step("t-old", "notify", "failed", { routedTo: "notifier" })];
  const m = runCanvasModel(ROOT, steps, DEF);
  const stale = m.nodes.find((n) => n.id === "notify")!;
  expect(stale).toMatchObject({ inDefinition: false, status: "failed", taskId: "t-old", agentId: "notifier", layer: 4, name: "notify" });
  expect(stale.x).toBe(G.pad + 4 * COL);
  expect(m.edges.some((e) => e.from === "notify" || e.to === "notify")).toBe(false);
});

test("runCanvasModel: a run with no definition (deleted, or not loaded yet) shows every step it ran, without edges", () => {
  const steps = [step("t-a", "a", "done"), step("t-b", "b", "running"), step("t-a2", "a", "failed")];
  for (const def of [null, undefined, {}, { graph: undefined }]) {
    const m = runCanvasModel(ROOT, steps, def as never);
    expect(m.edges).toEqual([]);
    expect(m.nodes.map((n) => [n.id, n.status, n.taskId, n.inDefinition, n.layer])).toEqual([
      ["a", "failed", "t-a2", false, 0],
      ["b", "running", "t-b", false, 0],
    ]);
    // Named from the card title minus the "<pipeline name>: " prefix.
    expect(m.nodes.map((n) => n.name)).toEqual(["a", "b"]);
  }
});

test("runCanvasModel: nothing to draw is an empty canvas", () => {
  expect(runCanvasModel(ROOT, [], null)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  expect(runCanvasModel(null, null, null)).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
});

test("runCanvasModel: the canvas is wide enough for the right-most node and a self-loop beside it", () => {
  const m = runCanvasModel(ROOT, [], DEF);
  const right = Math.max(...m.nodes.map((n) => n.x + G.nodeWidth));
  expect(m.width).toBe(right + G.pad + 40);
});

test("board.html loads board-run-canvas.js after board-runs.js, whose globals it uses", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const runs = html.indexOf('<script src="/board-runs.js"></script>');
  const canvas = html.indexOf('<script src="/board-run-canvas.js"></script>');
  expect(runs).toBeGreaterThan(-1);
  expect(canvas).toBeGreaterThan(runs);
  expect(canvas).toBeLessThan(html.indexOf("function renderRunCanvas("));
});

test("the run drawer has View on canvas, and the canvas page has its nodes and edges hosts", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toMatch(/<a class="pl-btn" id="rdCanvas"[^>]*>View on canvas<\/a>/);
  for (const id of ["runCanvasPage", "rcTitle", "rcProgress", "rcDetails", "rcCanvas", "rcEdges", "rcEdgeLayer", "rcNodes", "rcMessage"]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toContain('var RUN_CANVAS_ROUTE = "pipelines/run/:runId";');
});

test("GET /board-run-canvas.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([]));
  const res = await app(new Request("http://localhost/board-run-canvas.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function runCanvasModel(");
});
