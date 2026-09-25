import { expect, test } from "bun:test";
import { SqliteBoard } from "../src/services/board.ts";
import { SqlitePipelineStore } from "../src/services/pipelines.ts";
import type { PipelineGraph } from "../src/core/types.ts";

const graph: PipelineGraph = {
  steps: [
    { id: "a", name: "Implement", agentId: "implementer", transition: "choose" },
    { id: "b", name: "Review", agentId: "reviewer", transition: "choose" },
  ],
  edges: [{ id: "e1", from: "a", to: "b", label: "reviewer" }],
};

function store(): SqlitePipelineStore {
  // Shares SqliteBoard's own connection — the same reason the two
  // classes must, see SqliteBoard.db's doc comment. Using two separate
  // `new Database(":memory:")` instances here would silently give each
  // an unrelated empty database.
  return new SqlitePipelineStore(new SqliteBoard().db);
}

test("create then get round-trips a pipeline definition", async () => {
  const pipelines = store();
  const created = await pipelines.create({ name: "Review loop", description: "Implement then review.", graph });
  expect(created.id).toBeDefined();
  expect(created.createdAt).toBe(created.updatedAt);

  const fetched = await pipelines.get(created.id);
  expect(fetched).toEqual(created);
});

test("get returns undefined for an unknown id", async () => {
  const pipelines = store();
  expect(await pipelines.get("nope")).toBeUndefined();
});

test("list returns every created pipeline, in creation order", async () => {
  const pipelines = store();
  const first = await pipelines.create({ name: "First", description: "", graph });
  const second = await pipelines.create({ name: "Second", description: "", graph });
  expect(await pipelines.list()).toEqual([first, second]);
});

test("update overwrites name, description, and graph in place, bumping updatedAt but not createdAt", async () => {
  const pipelines = store();
  const created = await pipelines.create({ name: "Original", description: "orig", graph });
  const newGraph: PipelineGraph = { steps: [{ id: "a", name: "Only step", agentId: "implementer", transition: "all" }], edges: [] };

  await new Promise((r) => setTimeout(r, 2));
  const updated = await pipelines.update(created.id, { name: "Renamed", description: "new desc", graph: newGraph });

  expect(updated.name).toBe("Renamed");
  expect(updated.description).toBe("new desc");
  expect(updated.graph).toEqual(newGraph);
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.updatedAt).not.toBe(created.updatedAt);

  expect(await pipelines.get(created.id)).toEqual(updated);
});

test("update throws on an unknown id", async () => {
  const pipelines = store();
  await expect(pipelines.update("nope", { name: "x", description: "", graph })).rejects.toThrow(/not found/);
});

test("delete removes the pipeline, and throws on an unknown id", async () => {
  const pipelines = store();
  const created = await pipelines.create({ name: "Temp", description: "", graph });
  await pipelines.delete(created.id);
  expect(await pipelines.get(created.id)).toBeUndefined();
  await expect(pipelines.delete(created.id)).rejects.toThrow(/not found/);
});
