import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import { startPipelineRun } from "../src/core/pipeline-runner.ts";
import { ReadOnlyExecutor } from "../src/executors/readonly.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";
import type { AgentDef, PipelineDef, TaskCard } from "../src/core/types.ts";
import {
  formatStepCount,
  isPipelineRunRoot,
  lastRunsByPipeline,
  pipelineRows,
  pipelineStepCount,
} from "../src/api/public/board-pipelines.js";

// docs/SDD-ui-cleanup.md §3.4 (card A4): the Pipelines page's rows.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

type T = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;
let seq = 0;
function card(over: Partial<T> = {}): T {
  seq++;
  return { id: `t${seq}`, title: `Card ${seq}`, status: "done", ...over } as T;
}

function pipeline(id: string, steps: number): PipelineDef {
  return {
    id, name: `P ${id}`, description: "",
    graph: { steps: Array.from({ length: steps }, (_, i) => ({ id: `s${i}`, name: `S${i}`, agentId: "a", transition: "choose" as const })), edges: [] },
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
  };
}

test("a run root has a pipelineId and no parent; step cards and plain cards are not roots", () => {
  expect(isPipelineRunRoot(card({ pipelineId: "p1" }))).toBe(true);
  expect(isPipelineRunRoot(card({ pipelineId: "p1", parentTaskId: "root", pipelineRunId: "root" }))).toBe(false);
  expect(isPipelineRunRoot(card())).toBe(false);
  expect(isPipelineRunRoot(card({ pipelineId: "" }))).toBe(false);
  expect(isPipelineRunRoot(null)).toBe(false);
  expect(isPipelineRunRoot(undefined)).toBe(false);
});

// Arrays below are in GET /tasks order: oldest first.
test("the last run is the newest root in GET /tasks order, and never a step card created after it", () => {
  const older = card({ pipelineId: "p1", status: "done" });
  const other = card({ pipelineId: "p2" });
  const newer = card({ pipelineId: "p1", status: "failed" });
  const step = card({ pipelineId: "p1", parentTaskId: newer.id, pipelineRunId: newer.id, status: "running" });
  const last = lastRunsByPipeline([older, other, newer, step, card()]);
  expect(last.p1).toBe(newer);
  expect(last.p2).toBe(other);
  expect(Object.keys(last).sort()).toEqual(["p1", "p2"]);
  expect(Object.keys(lastRunsByPipeline(null))).toEqual([]);
});

test("a pipeline id like '__proto__' is an ordinary key", () => {
  const run = card({ pipelineId: "__proto__" });
  const last = lastRunsByPipeline([run]);
  expect(Object.keys(last)).toEqual(["__proto__"]);
  expect(pipelineRows([pipeline("__proto__", 1)], [run])[0]!.lastRun).toBe(run);
});

test("a pipelineId like 'constructor' can't match Object.prototype", () => {
  expect(pipelineRows([pipeline("constructor", 1), pipeline("toString", 1)], [])).toEqual([
    { pipeline: pipeline("constructor", 1), stepCount: 1, lastRun: null },
    { pipeline: pipeline("toString", 1), stepCount: 1, lastRun: null },
  ]);
});

test("step count reads graph.steps and tolerates a missing graph", () => {
  expect(pipelineStepCount(pipeline("p", 3))).toBe(3);
  expect(pipelineStepCount({ id: "x", name: "x" })).toBe(0);
  expect(pipelineStepCount({ id: "x", name: "x", graph: { steps: undefined as never, edges: [] } })).toBe(0);
  expect(pipelineStepCount(null)).toBe(0);
  expect(formatStepCount(0)).toBe("0 steps");
  expect(formatStepCount(1)).toBe("1 step");
  expect(formatStepCount(5)).toBe("5 steps");
});

test("pipelineRows keeps GET /pipelines order and pairs each pipeline with its own last run", () => {
  const run = card({ pipelineId: "b", status: "failed" });
  const rows = pipelineRows([pipeline("b", 2), pipeline("a", 1)], [run]);
  expect(rows.map((r) => r.pipeline.id)).toEqual(["b", "a"]);
  expect(rows[0]).toMatchObject({ stepCount: 2, lastRun: run });
  expect(rows[1]).toMatchObject({ stepCount: 1, lastRun: null });
  expect(pipelineRows(null, null)).toEqual([]);
});

// The real runner, not hand-built cards: what startPipelineRun actually
// writes is what the page has to recognize.
function stepAgent(id: string): AgentDef {
  return {
    id, name: id, kind: "agent", tier: "readonly", description: "test step", whenToUse: "test only", tags: ["test"],
    executor: "readonly", inputs: [], outputs: [], trustLevel: "low", toolAccess: ["read"],
    costProfile: { model: "claude-sonnet-5", estUsdPerTask: 0.01 },
    outputContract: "Your final message must end with a ```pipeline-handoff``` block.",
    outputContractFormat: "pipeline-handoff",
  };
}

test("two real runs of a 2-step pipeline: the last run is the second root, and no step card counts as a run", async () => {
  const board = new SqliteBoard();
  const pipelines = new SqlitePipelineStore(board.db);
  const registry = Registry.from([stepAgent("step-a"), stepAgent("step-b")]);
  const handoff = (body: object) => `Done.\n\n\`\`\`pipeline-handoff\n${JSON.stringify(body)}\n\`\`\``;
  const bodies = [handoff({ next: "b" }), handoff({}), handoff({ next: "b" }), handoff({})];
  let i = 0;
  const runner: CommandRunner = async () => ({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: bodies[i++] }), stderr: "", exitCode: 0,
  });
  const ctx = { executors: [new ReadOnlyExecutor({ runner })], pipelines };
  const def = await pipelines.create({
    name: "Two steps", description: "",
    graph: {
      steps: [
        { id: "a", name: "A", agentId: "step-a", transition: "choose" },
        { id: "b", name: "B", agentId: "step-b", transition: "choose" },
      ],
      edges: [{ id: "e", from: "a", to: "b" }],
    },
  });

  await startPipelineRun(board, registry, def, "/tmp/repo", "first", ctx);
  const second = await startPipelineRun(board, registry, def, "/tmp/repo", "second", ctx);

  const tasks = await board.list();
  expect(tasks.filter((t) => t.pipelineId === def.id)).toHaveLength(6);
  expect(tasks.filter(isPipelineRunRoot)).toHaveLength(2);
  const [row] = pipelineRows(await pipelines.list(), tasks);
  expect(row!.stepCount).toBe(2);
  expect(row!.lastRun!.id).toBe(second.id);
  expect(row!.lastRun!.status).toBe("done");
});

// Markup: the page the route table names, and its script tag.
test("board.html has the Pipelines page with its list and a New pipeline link to the editor", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const start = html.indexOf('<section id="pipelinesPage" data-page');
  expect(start).toBeGreaterThan(-1);
  const page = html.slice(start, html.indexOf("</section>\n  </section>", start));
  expect(page).toContain('id="pipelinesList"');
  // Card B2 (§4.2): the editor is a page in the shell, not /pipelines/edit.
  expect(page).toMatch(/<a [^>]*id="newPipelineLink"[^>]*href="#\/pipelines\/new"/);
});

test("board.html has the editor page, mounts the bundle from the editor routes, and links Edit to #/pipelines/edit/<id>", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toMatch(/<section id="pipelineEditorPage" data-page hidden>[\s\S]*?id="pipelineEditorError"[\s\S]*?id="pipelineEditorRoot"/);
  expect(html).toContain('edit.href = boardRouteHash("pipelines/edit/:id", { id: p.id });');
  expect(html).toContain("if (def.editor) showPipelineEditor(def, parsed.params || {}, !wasEditor);");
  expect(html).toContain("mod.mountPipelineEditor(");
  // The editor's Run is the same "+ New" drawer as the Pipelines page's Run.
  expect(html).toMatch(/runPipeline: function \(pipelineId\) \{\s*openNewDrawer\("pipeline", \{ pipelineId: pipelineId \}\);/);
});

test("the editor bundle exports mountPipelineEditor, the name board.html calls", async () => {
  const main = await readFile(join(import.meta.dir, "..", "pipeline-editor", "src", "main.tsx"), "utf8");
  expect(main).toMatch(/export function mountPipelineEditor\(/);
});

test("board.html loads board-pipelines.js before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-pipelines.js"></script>');
  expect(tag).toBeGreaterThan(-1);
  expect(tag).toBeLessThan(html.indexOf("function renderPipelinesPage("));
});

test("GET /board-pipelines.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), Registry.from([]), undefined, { harnesses: HarnessPool.from([]) });
  const res = await app(new Request("http://localhost/board-pipelines.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function pipelineRows(");
});
