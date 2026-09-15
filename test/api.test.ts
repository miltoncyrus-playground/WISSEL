import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import type { TaskCard } from "../src/core/types.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

test("GET /health", async () => {
  const app = createApp(new SqliteBoard());
  const res = await app(req("/health"));
  expect(await res.text()).toBe("ok");
});

test("POST /tasks then GET /tasks round-trips", async () => {
  const app = createApp(new SqliteBoard());
  const create = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "t", body: "b", labels: ["x"], repo: "r" }),
    }),
  );
  expect(create.status).toBe(201);
  const created = (await create.json()) as TaskCard;
  expect(created.status).toBe("inbox");

  const list = await app(req("/tasks"));
  expect(await list.json()).toEqual([created]);

  const single = await app(req(`/tasks/${created.id}`));
  expect(await single.json()).toEqual(created);
});

test("GET /tasks/:id 404s for unknown id", async () => {
  const app = createApp(new SqliteBoard());
  const res = await app(req("/tasks/nope"));
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/move updates status, 404s on unknown id", async () => {
  const app = createApp(new SqliteBoard());
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const move = await app(req(`/tasks/${created.id}/move`, { method: "POST", body: JSON.stringify({ status: "running" }) }));
  expect(((await move.json()) as TaskCard).status).toBe("running");

  const missing = await app(req("/tasks/nope/move", { method: "POST", body: JSON.stringify({ status: "done" }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/decision, /result, /override return 204 and fan out over SSE", async () => {
  const board = new SqliteBoard();
  const app = createApp(board);
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const decision = await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: [],
        candidates: [],
        selected: "a",
        reason: "r",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );
  expect(decision.status).toBe(204);

  const result = await app(
    req(`/tasks/${created.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "a", ok: true, summary: "done" }),
    }),
  );
  expect(result.status).toBe(204);

  const override = await app(
    req(`/tasks/${created.id}/override`, {
      method: "POST",
      body: JSON.stringify({ routerPick: "a", humanPick: "b" }),
    }),
  );
  expect(override.status).toBe(204);

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.decided");
  await reader.cancel();
});
