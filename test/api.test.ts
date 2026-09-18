import { expect, test } from "bun:test";
import { createApp } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import type { TaskCard } from "../src/core/types.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function makeApp(board = new SqliteBoard()) {
  const registry = await Registry.load();
  return createApp(board, registry);
}

test("GET /health", async () => {
  const app = await makeApp();
  const res = await app(req("/health"));
  expect(await res.text()).toBe("ok");
});

test("GET / and GET /board serve the board UI", async () => {
  const app = await makeApp();
  for (const path of ["/", "/board"]) {
    const res = await app(req(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>wissel board</title>");
  }
});

test("GET /agents returns the fleet from the manifest", async () => {
  const app = await makeApp();
  const res = await app(req("/agents"));
  const agents = (await res.json()) as { id: string }[];
  expect(agents.some((a) => a.id === "triager")).toBe(true);
});

test("POST /tasks then GET /tasks round-trips, defaulting dependsOn to []", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", {
      method: "POST",
      body: JSON.stringify({ title: "t", body: "b", labels: ["x"], repo: "r" }),
    }),
  );
  expect(create.status).toBe(201);
  const created = (await create.json()) as TaskCard;
  expect(created.status).toBe("inbox");
  expect(created.dependsOn).toEqual([]);

  const list = await app(req("/tasks"));
  expect(await list.json()).toEqual([created]);

  const single = await app(req(`/tasks/${created.id}`));
  expect(await single.json()).toEqual(created);
});

test("GET /tasks/:id 404s for unknown id", async () => {
  const app = await makeApp();
  const res = await app(req("/tasks/nope"));
  expect(res.status).toBe(404);
});

test("POST /tasks/:id/move updates status, 404s on unknown id", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const move = await app(req(`/tasks/${created.id}/move`, { method: "POST", body: JSON.stringify({ status: "running" }) }));
  expect(((await move.json()) as TaskCard).status).toBe("running");

  const missing = await app(req("/tasks/nope/move", { method: "POST", body: JSON.stringify({ status: "done" }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/depends-on updates dependsOn, 404s on unknown id", async () => {
  const app = await makeApp();
  const a = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "a", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;
  const b = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "b", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const dep = await app(req(`/tasks/${b.id}/depends-on`, { method: "POST", body: JSON.stringify({ dependsOn: [a.id] }) }));
  expect(((await dep.json()) as TaskCard).dependsOn).toEqual([a.id]);

  const missing = await app(req("/tasks/nope/depends-on", { method: "POST", body: JSON.stringify({ dependsOn: [] }) }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/decision, /result, /override return 204 and fan out over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
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
        confident: true,
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

test("GET /tasks/:id/decision returns the recorded decision, 404s with none", async () => {
  const app = await makeApp();
  const create = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }),
  );
  const created = (await create.json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/decision`));
  expect(before.status).toBe(404);

  await app(
    req(`/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["x"],
        candidates: [{ agentId: "triager", score: 1, reason: "tag match" }],
        selected: "triager",
        confident: true,
        reason: "tag match",
        strategy: "rule",
        decidedAt: new Date().toISOString(),
      }),
    }),
  );

  const after = await app(req(`/tasks/${created.id}/decision`));
  expect(after.status).toBe(200);
  const decision = (await after.json()) as { selected: string; confident: boolean };
  expect(decision.selected).toBe("triager");
  expect(decision.confident).toBe(true);
});

test("POST /tasks/:id/result routes a write-tier report to review, a readonly one to done", async () => {
  const app = await makeApp();

  const writeTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "w", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${writeTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "implementer", ok: true, summary: "opened a PR" }),
    }),
  );
  expect((await (await app(req(`/tasks/${writeTask.id}`))).json() as TaskCard).status).toBe("review");

  const readonlyTask = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "r", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  await app(
    req(`/tasks/${readonlyTask.id}/result`, {
      method: "POST",
      body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }),
    }),
  );
  expect((await (await app(req(`/tasks/${readonlyTask.id}`))).json() as TaskCard).status).toBe("done");
});
