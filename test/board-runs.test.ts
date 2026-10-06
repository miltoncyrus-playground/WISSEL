import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import type { PipelineDef, TaskCard } from "../src/core/types.ts";
import { partitionBoard } from "../src/api/public/board-lanes.js";
import {
  foldsIntoRun,
  indexRuns,
  isPipelineStep,
  latestStepCards,
  partitionRunBoard,
  runNeedsYouReason,
  runNeedsYouSteps,
  runProgress,
  runRootOf,
  runStepsOf,
  stepDisplayName,
} from "../src/api/public/board-runs.js";

// docs/SDD-ui-cleanup.md §4.1 (card B1), target T5: one board card per
// pipeline run.

const BOARD_HTML_PATH = join(import.meta.dir, "..", "src", "api", "public", "board.html");

type T = Partial<TaskCard> & Pick<TaskCard, "id" | "status">;

const DEF: Pick<PipelineDef, "graph"> = {
  graph: {
    steps: [
      { id: "plan", name: "Planner", agentId: "planner", transition: "all" },
      { id: "impl", name: "Implementer", agentId: "implementer", transition: "all" },
      { id: "rev", name: "Reviewer", agentId: "reviewer", transition: "choose" },
      { id: "notify", name: "Notify", agentId: "notifier", transition: "all" },
      { id: "ship", name: "Ship", agentId: "shipper", transition: "all" },
    ],
    edges: [],
  },
};

function root(id: string, status: TaskCard["status"], extra: Partial<T> = {}): T {
  return { id, title: "Pipeline: Lifecycle", status, pipelineId: "p1", repo: "/r", ...extra };
}

function step(id: string, runId: string, stepId: string, status: TaskCard["status"], extra: Partial<T> = {}): T {
  const name = DEF.graph.steps.find((s) => s.id === stepId)?.name ?? stepId;
  return { id, title: `Lifecycle: ${name}`, status, pipelineId: "p1", pipelineRunId: runId, pipelineStepId: stepId, parentTaskId: runId, ...extra };
}

test("a step card has a pipelineRunId; a root or plain card doesn't", () => {
  expect(isPipelineStep(step("s", "r", "plan", "done"))).toBe(true);
  expect(isPipelineStep(root("r", "running"))).toBe(false);
  expect(isPipelineStep({ id: "x", status: "inbox" })).toBe(false);
  expect(isPipelineStep({ id: "x", status: "inbox", pipelineRunId: "" })).toBe(false);
  expect(isPipelineStep(null)).toBe(false);
});

test("indexRuns groups steps under their run in board order", () => {
  const tasks = [root("r1", "running"), step("a", "r1", "plan", "done"), root("r2", "done"), step("b", "r2", "plan", "done"), step("c", "r1", "impl", "running")];
  const index = indexRuns(tasks);
  expect(runStepsOf(index, "r1").map((t) => t.id)).toEqual(["a", "c"]);
  expect(runStepsOf(index, "r2").map((t) => t.id)).toEqual(["b"]);
  expect(runStepsOf(index, "nope")).toEqual([]);
  expect(runRootOf(tasks[1]!, index)?.id).toBe("r1");
  expect(runRootOf(tasks[0]!, index)).toBeNull();
  // An id like __proto__ is just a key.
  expect(runStepsOf(indexRuns([step("p", "__proto__", "plan", "done")]), "__proto__").map((t) => t.id)).toEqual(["p"]);
});

test("a step folds into its run, except an orphan and a step unarchived on its own", () => {
  const r = root("r", "done", { archivedAt: "2026-10-01T00:00:00Z" });
  const archivedStep = step("a", "r", "plan", "done", { archivedAt: "2026-10-01T00:00:00Z" });
  const unarchivedStep = step("b", "r", "impl", "done");
  const orphan = step("o", "gone", "plan", "failed");
  const live = root("r2", "running");
  const liveStep = step("c", "r2", "plan", "running");
  const index = indexRuns([r, archivedStep, unarchivedStep, orphan, live, liveStep]);
  expect(foldsIntoRun(archivedStep, index)).toBe(true);
  expect(foldsIntoRun(unarchivedStep, index)).toBe(false);
  expect(foldsIntoRun(orphan, index)).toBe(false);
  expect(foldsIntoRun(liveStep, index)).toBe(true);
  expect(foldsIntoRun(live, index)).toBe(false);
});

test("a step's name comes from the definition, else from its title", () => {
  const r = root("r", "running");
  expect(stepDisplayName(step("a", "r", "rev", "running", { title: "anything" }), r, DEF)).toBe("Reviewer");
  expect(stepDisplayName(step("a", "r", "gone", "running", { title: "Lifecycle: Old step" }), r, DEF)).toBe("Old step");
  expect(stepDisplayName(step("a", "r", "plan", "running"), r, null)).toBe("Planner");
  expect(stepDisplayName({ id: "a", status: "done", title: "Other: thing" }, r, null)).toBe("Other: thing");
});

test("progress: n/m steps · now: <step>, with m from the definition", () => {
  const r = root("r", "running");
  const steps = [step("a", "r", "plan", "done"), step("b", "r", "impl", "done"), step("c", "r", "rev", "running")];
  const p = runProgress(r, steps, DEF);
  expect(p.text).toBe("2/5 steps · now: Reviewer");
  expect(p.done).toBe(2);
  expect(p.total).toBe(5);
  expect(p.current).toEqual({ taskId: "c", name: "Reviewer", attempt: 1 });
  expect(p.segments).toEqual([
    { taskId: "a", name: "Planner", status: "done" },
    { taskId: "b", name: "Implementer", status: "done" },
    // A reviewer agent's own running card shows as Reviewing, same as on the board.
    { taskId: "c", name: "Reviewer", status: "running" },
    { taskId: null, name: "Notify", status: "pending" },
    { taskId: null, name: "Ship", status: "pending" },
  ]);
});

test("progress names the attempt when a step has run more than once", () => {
  const r = root("r", "running");
  const steps = [step("a", "r", "plan", "done"), step("b", "r", "rev", "failed"), step("c", "r", "rev", "running", { routedTo: "reviewer" })];
  const p = runProgress(r, steps, DEF);
  expect(p.text).toBe("1/5 steps · now: Reviewer (attempt 2)");
  expect(p.segments.slice(0, 2)).toEqual([
    { taskId: "a", name: "Planner", status: "done" },
    { taskId: "c", name: "Reviewer (attempt 2)", status: "reviewing" },
  ]);
  expect(latestStepCards(steps).map((s) => [s.key, s.card.id, s.attempt])).toEqual([["plan", "a", 1], ["rev", "c", 2]]);
});

test("progress of a settled run: failed names the first failed step, done just counts", () => {
  const failed = runProgress(root("r", "failed"), [step("a", "r", "plan", "done"), step("b", "r", "impl", "failed")], DEF);
  expect(failed.text).toBe("1/5 steps · failed at: Implementer");
  expect(failed.failedAt).toEqual({ taskId: "b", name: "Implementer", attempt: 1 });
  expect(failed.current).toBeNull();

  const done = runProgress(root("r", "done"), [step("a", "r", "plan", "done"), step("b", "r", "impl", "done")], { graph: { steps: DEF.graph.steps.slice(0, 2), edges: [] } });
  expect(done.text).toBe("2/2 steps");
});

test("progress without a definition counts the steps seen; with no steps it's 0/m", () => {
  expect(runProgress(root("r", "running"), [step("a", "r", "x", "done"), step("b", "r", "y", "running")], null).text).toBe("1/2 steps · now: y");
  expect(runProgress(root("r", "failed"), [], DEF).text).toBe("0/5 steps");
  expect(runProgress(root("r", "running"), [], null).segments).toEqual([]);
});

test("a step waiting on an MCP approval is the run's current step and needs you", () => {
  const r = root("r", "running");
  const mcp = step("b", "r", "notify", "review", { pendingMcpApproval: { server: "slack", tool: "send_message", args: {}, reason: "x" } });
  const steps = [step("a", "r", "plan", "done"), mcp];
  expect(runProgress(r, steps, DEF).text).toBe("1/5 steps · now: Notify");
  expect(runNeedsYouSteps(steps).map((t) => t.id)).toEqual(["b"]);
  expect(runNeedsYouReason(r, steps, DEF)).toBe("step Notify: MCP approval: slack · send_message");
});

test("needs-you steps: only each step's latest card, never archived or superseded ones", () => {
  const steps = [
    step("a", "r", "plan", "failed"), // replaced by a later attempt
    step("b", "r", "plan", "done"),
    step("c", "r", "impl", "failed", { archivedAt: "2026-10-01T00:00:00Z" }),
    step("d", "r", "rev", "escalated", { supersededBy: "e", pushbackCount: 5 }),
    step("f", "r", "notify", "failed"),
    step("g", "r", "ship", "escalated", { pushbackCount: 5 }),
  ];
  expect(runNeedsYouSteps(steps).map((t) => t.id)).toEqual(["f", "g"]);
  expect(runNeedsYouReason(root("r", "running"), steps, DEF)).toBe("step Notify: failed (+1 more)");
  // No step needs a human: the root's own reason.
  expect(runNeedsYouReason(root("r", "failed"), [], DEF)).toBe("failed");
});

test("T5: partitionRunBoard draws one card per run, never a step", () => {
  const tasks: T[] = [
    { id: "plain", title: "plain", status: "inbox" },
    root("r1", "running"),
    step("r1a", "r1", "plan", "done"),
    step("r1b", "r1", "impl", "running"),
    root("r2", "done", { doneAt: new Date().toISOString() }),
    step("r2a", "r2", "plan", "done"),
    root("r3", "failed"),
    step("r3a", "r3", "plan", "failed"),
  ];
  const parts = partitionRunBoard(tasks, tasks, { now: Date.now() });
  const drawn = [...parts.needsYou, ...Object.values(parts.lanes).flat()].map((t) => t.id);
  expect(drawn.sort()).toEqual(["plain", "r1", "r2", "r3"]);
  expect(parts.lanes.queued.map((t) => t.id)).toEqual(["plain"]);
  expect(parts.lanes.working.map((t) => t.id)).toEqual(["r1"]);
  expect(parts.lanes.done.map((t) => t.id)).toEqual(["r2"]);
  expect(parts.needsYou.map((t) => t.id)).toEqual(["r3"]);
  // Without folding, every step would draw too.
  const unfolded = partitionBoard(tasks, { now: Date.now() });
  expect([...unfolded.needsYou, ...Object.values(unfolded.lanes).flat()]).toHaveLength(8);
});

test("a running run with a step needing a human shows in its lane and in Needs you, once each", () => {
  const tasks: T[] = [
    root("r", "running"),
    step("a", "r", "plan", "done"),
    step("b", "r", "notify", "review", { pendingMcpApproval: { server: "slack", tool: "send_message", args: {}, reason: "x" } }),
    { id: "rev", title: "Review me", status: "review" },
  ];
  const parts = partitionRunBoard(tasks, tasks);
  expect(parts.lanes.working.map((t) => t.id)).toEqual(["r"]);
  expect(parts.needsYou.map((t) => t.id)).toEqual(["r", "rev"]);
});

test("project scoping: steps outside the scoped list still fold, and still count toward Needs you", () => {
  // A later step's repo is the previous step's worktree, so a project
  // filter drops it from `tasks`; the run still knows about it.
  const r = root("r", "running", { repo: "/proj" });
  const first = step("a", "r", "plan", "done", { repo: "/proj" });
  const later = step("b", "r", "impl", "failed", { repo: "/home/x/.wissel/worktrees/a" });
  const all = [r, first, later];
  const scoped = [r, first];
  const parts = partitionRunBoard(scoped, all);
  expect(parts.lanes.working.map((t) => t.id)).toEqual(["r"]);
  expect(parts.needsYou.map((t) => t.id)).toEqual(["r"]);
  expect(runStepsOf(parts.index, "r").map((t) => t.id)).toEqual(["a", "b"]);
});

test("an orphan step (root deleted) keeps its own card", () => {
  const tasks: T[] = [step("o", "deleted-root", "plan", "failed")];
  expect(partitionRunBoard(tasks, tasks).needsYou.map((t) => t.id)).toEqual(["o"]);
});

test("archived runs stay off the board; superseded and done-window rules still apply to roots", () => {
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const tasks: T[] = [
    root("ra", "done", { archivedAt: old }),
    step("ra1", "ra", "plan", "done", { archivedAt: old }),
    root("rold", "done", { doneAt: old }),
    step("rold1", "rold", "plan", "done"),
  ];
  const parts = partitionRunBoard(tasks, tasks, { now: Date.now() });
  expect([...parts.needsYou, ...Object.values(parts.lanes).flat()]).toEqual([]);
  expect(parts.doneHidden).toBe(1);
  expect(partitionRunBoard(tasks, tasks, { now: Date.now(), showAllDone: true }).lanes.done.map((t) => t.id)).toEqual(["rold"]);
});

test("board.html loads board-runs.js after board-lanes.js and board-pipelines.js, before its inline script", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  const tag = html.indexOf('<script src="/board-runs.js"></script>');
  expect(tag).toBeGreaterThan(html.indexOf('<script src="/board-lanes.js"></script>'));
  expect(tag).toBeGreaterThan(html.indexOf('<script src="/board-pipelines.js"></script>'));
  expect(tag).toBeLessThan(html.indexOf("<script>\n(function () {"));
});

test("GET /board-runs.js serves the module the board loads", async () => {
  const app = createApp(new SqliteBoard(), await Registry.load());
  const res = await app(new Request("http://localhost/board-runs.js"));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("function partitionRunBoard(");
});

test("board.html draws the board through partitionRunBoard and opens runs in the run drawer", async () => {
  const html = await readFile(BOARD_HTML_PATH, "utf8");
  expect(html).toContain("partitionRunBoard(tasks, allTasks,");
  expect(html).not.toContain("partitionBoard(tasks,");
  for (const id of ["runDrawer", "rdTitle", "rdProgress", "rdSteps", "tdDetail"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('fetch("/pipeline-runs/"');
});
