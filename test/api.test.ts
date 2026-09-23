import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { createApp, type CreateAppOptions } from "../src/api/server.ts";
import { SqliteBoard } from "../src/services/board.ts";
import { Registry } from "../src/core/registry.ts";
import { HarnessPool } from "../src/core/harness-pool.ts";
import type { AgentDef, Executor, Harness, TaskCard, TaskResult } from "../src/core/types.ts";
import type { CommandRunner } from "../src/executors/claude-cli.ts";

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

async function makeApp(board = new SqliteBoard(), opts?: CreateAppOptions) {
  const registry = await Registry.load();
  return createApp(board, registry, undefined, opts);
}

/** A fake write executor for `/tasks/:id/run` tests — never spawns a
 *  real `claude` process. */
function fakeWriteExecutor(run: Executor["run"]): Executor {
  return { id: "fake-write", canHandle: (agent: AgentDef) => agent.tier === "write", run };
}

test("GET /health", async () => {
  const app = await makeApp();
  const res = await app(req("/health"));
  expect(await res.text()).toBe("ok");
});

test("GET /version", async () => {
  const app = await makeApp();
  const res = await app(req("/version"));
  const body = (await res.json()) as {
    commit: string;
    commitShort: string;
    branch: string;
    dirty: boolean;
    packageVersion: string;
    startedAt: string;
  };
  // Shape/types only, not the literal SHA — that would flake on every commit.
  expect(typeof body.commit).toBe("string");
  expect(typeof body.commitShort).toBe("string");
  expect(typeof body.branch).toBe("string");
  expect(typeof body.dirty).toBe("boolean");
  expect(body.packageVersion).toBe("0.0.0");
  expect(typeof body.startedAt).toBe("string");
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

test("GET /harnesses defaults to empty, and returns configured harnesses with a live activeCount and availableModels", async () => {
  const empty = await makeApp();
  expect(await (await empty(req("/harnesses"))).json()).toEqual([]);

  const harnesses = HarnessPool.from([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true }]);
  const withHarness = await makeApp(new SqliteBoard(), { harnesses });
  const res = await withHarness(req("/harnesses"));
  const body = (await res.json()) as { id: string; tool: string; label: string; enabled: boolean; activeCount: number; availableModels: string[] }[];
  // No cache configured/found for this harness id yet — a cache-miss
  // reports [], never an error.
  expect(body).toEqual([{ id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true, activeCount: 0, availableModels: [] }]);
});

test("GET /harnesses reports availableModels from an injected fake cache, keyed by harness id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-models-cache-test-"));
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({
        "claude-personal": { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() },
      }),
    );
    const harnesses = HarnessPool.from([
      { id: "claude-personal", tool: "claude-cli", label: "Claude — personal", enabled: true },
      { id: "codex-personal", tool: "codex-cli", label: "Codex — personal", enabled: true },
    ]);
    const app = await makeApp(new SqliteBoard(), { harnesses, modelsCachePath });

    const body = (await (await app(req("/harnesses"))).json()) as { id: string; availableModels: string[] }[];
    expect(body.find((h) => h.id === "claude-personal")?.availableModels).toEqual(["claude-sonnet-5", "claude-opus-5"]);
    // codex-personal has no cache entry at all — a miss, not an error.
    expect(body.find((h) => h.id === "codex-personal")?.availableModels).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /memory returns undefined content when nothing has been curated yet, and the real content once it has", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-memory-test-"));
  try {
    const memoryPath = join(dir, "lessons.md");
    const empty = await makeApp(new SqliteBoard(), { memoryPath });
    const emptyBody = (await (await empty(req("/memory"))).json()) as { content: string | undefined; path: string };
    expect(emptyBody.content).toBeUndefined();
    expect(emptyBody.path).toBe(memoryPath);

    await writeFile(memoryPath, "# Lessons\n\nSome curated content.");
    const withContent = await makeApp(new SqliteBoard(), { memoryPath });
    const body = (await (await withContent(req("/memory"))).json()) as { content: string | undefined };
    expect(body.content).toBe("# Lessons\n\nSome curated content.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /memory/history returns [] with no telemetry configured, and real runs most-recent-first once it is", async () => {
  const { TelemetryLog } = await import("../src/services/telemetry.ts");
  const noTelemetryApp = await makeApp();
  expect(await (await noTelemetryApp(req("/memory/history"))).json()).toEqual([]);

  const dir = await mkdtemp(join(tmpdir(), "wissel-api-memory-history-test-"));
  try {
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetry = new TelemetryLog(telemetryPath);
    await telemetry.record({ type: "result", taskId: "run-1", agentId: "memory-curator", actualCost: 0.1, harnessId: "claude" });
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct `at` timestamps, so ordering is unambiguous
    await telemetry.record({ type: "result", taskId: "run-2", agentId: "memory-curator", actualCost: 0.2, harnessId: "claude" });
    // A non-memory-curator result must never show up in curation history.
    await telemetry.record({ type: "result", taskId: "run-3", agentId: "implementer", actualCost: 5, harnessId: "claude" });

    const board = new SqliteBoard();
    await board.create({ title: "t", body: "", labels: [], repo: "r" }); // just to exercise a real id space
    await board.recordResult({ taskId: "run-1", agentId: "memory-curator", ok: true, summary: "first curation" });
    await board.recordResult({ taskId: "run-2", agentId: "memory-curator", ok: true, summary: "second curation" });

    const registry = await Registry.load();
    const app = createApp(board, registry, telemetry, {});
    const runs = (await (await app(req("/memory/history"))).json()) as { taskId: string; summary: string | undefined; actualCost: number }[];

    expect(runs.map((r) => r.taskId)).toEqual(["run-2", "run-1"]); // most recent first
    expect(runs[0]!.summary).toBe("second curation");
    expect(runs[1]!.summary).toBe("first curation");
    expect(runs.some((r) => r.taskId === "run-3")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function harnessesFixture(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-harnesses-test-"));
  const path = join(dir, "harnesses.yaml");
  await writeFile(path, content);
  return { dir, path };
}

test("POST /harnesses/:id/disable persists to harnesses.yaml and updates the live pool, no re-validation needed", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    let runnerCalled = false;
    const app = await makeApp(new SqliteBoard(), {
      harnesses,
      harnessesPath: path,
      harnessRunner: async () => {
        runnerCalled = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });

    const res = await app(req("/harnesses/a/disable", { method: "POST" }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as Harness).enabled).toBe(false);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(runnerCalled).toBe(false);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable re-validates first — succeeds and clears disabledReason when still authenticated", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n    disabledReason: not authenticated\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false, disabledReason: "not authenticated" }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: true }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Harness;
    expect(body.enabled).toBe(true);
    expect(body.disabledReason).toBeUndefined();
    expect(harnesses.get("a")?.enabled).toBe(true);
    const onDisk = parse(await readFile(path, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable refuses with 409 when still not authenticated, and never touches harnesses.yaml", async () => {
  const { dir, path } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: false\n");
  const before = await readFile(path, "utf8");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: false }]);
    const runner: CommandRunner = async () => ({ stdout: JSON.stringify({ loggedIn: false }), stderr: "", exitCode: 0 });
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath: path, harnessRunner: runner });

    const res = await app(req("/harnesses/a/enable", { method: "POST" }));

    expect(res.status).toBe(409);
    expect(harnesses.get("a")?.enabled).toBe(false);
    expect(harnesses.get("a")?.disabledReason).toBe("not authenticated");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/enable and /disable 404 for an unknown id", async () => {
  const app = await makeApp(new SqliteBoard(), { harnesses: HarnessPool.from([]) });
  expect((await app(req("/harnesses/missing/enable", { method: "POST" }))).status).toBe(404);
  expect((await app(req("/harnesses/missing/disable", { method: "POST" }))).status).toBe(404);
});

test("POST /harnesses/:id/model sets, rejects an invalid model with 400, clears with null, and 404s on unknown id", async () => {
  const { dir, path: harnessesPath } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({ a: { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() } }),
    );
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath, modelsCachePath });

    // Invalid model against a harness with a non-empty known list: 400,
    // never persisted.
    const invalid = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "not-a-real-model" }) }));
    expect(invalid.status).toBe(400);
    expect(harnesses.get("a")?.model).toBeUndefined();

    // Valid model: 200, persisted to disk and in memory.
    const res = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Harness).model).toBe("claude-opus-5");
    expect(harnesses.get("a")?.model).toBe("claude-opus-5");
    const onDisk = parse(await readFile(harnessesPath, "utf8")) as { harnesses: Harness[] };
    expect(onDisk.harnesses.find((h) => h.id === "a")?.model).toBe("claude-opus-5");

    // null clears the override back to the agent default.
    const cleared = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: null }) }));
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Harness).model).toBeUndefined();
    expect(harnesses.get("a")?.model).toBeUndefined();
    const onDiskAfterClear = parse(await readFile(harnessesPath, "utf8")) as { harnesses: Harness[] };
    expect(onDiskAfterClear.harnesses.find((h) => h.id === "a")?.model).toBeUndefined();

    const missing = await app(req("/harnesses/missing/model", { method: "POST", body: JSON.stringify({ model: "claude-opus-5" }) }));
    expect(missing.status).toBe(404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("POST /harnesses/:id/model accepts any model unvalidated when the harness has no cached availableModels yet", async () => {
  const { dir, path: harnessesPath } = await harnessesFixture("harnesses:\n  - id: a\n    tool: claude-cli\n    label: A\n    enabled: true\n");
  try {
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    // modelsCachePath deliberately points at a file that doesn't exist —
    // a cache-miss, never refreshed yet.
    const app = await makeApp(new SqliteBoard(), { harnesses, harnessesPath, modelsCachePath: join(dir, "no-such-cache.json") });

    const res = await app(req("/harnesses/a/model", { method: "POST", body: JSON.stringify({ model: "anything-goes" }) }));
    expect(res.status).toBe(200);
    expect(harnesses.get("a")?.model).toBe("anything-goes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("POST /tasks accepts a valid harnessOverride+model, 400s on an invalid model against a known harness, 400s on an unknown harnessOverride, and accepts an unvalidated model with no harnessOverride", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-tasks-model-test-"));
  try {
    const modelsCachePath = join(dir, "models-cache.json");
    await writeFile(
      modelsCachePath,
      JSON.stringify({ a: { models: ["claude-sonnet-5", "claude-opus-5"], fetchedAt: new Date().toISOString() } }),
    );
    const harnesses = HarnessPool.from([{ id: "a", tool: "claude-cli", label: "A", enabled: true }]);
    const app = await makeApp(new SqliteBoard(), { harnesses, modelsCachePath });

    // Valid harnessOverride + a model that's in that harness's cached list.
    const ok = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r", harnessOverride: "a", model: "claude-opus-5" }),
      }),
    );
    expect(ok.status).toBe(201);
    const okTask = (await ok.json()) as TaskCard;
    expect(okTask.harnessOverride).toBe("a");
    expect(okTask.model).toBe("claude-opus-5");

    // Invalid model against a known harness: 400, never created.
    const invalidModel = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t2", body: "", labels: [], repo: "r", harnessOverride: "a", model: "not-a-real-model" }),
      }),
    );
    expect(invalidModel.status).toBe(400);

    // Unknown harnessOverride id: 400, never created.
    const unknownHarness = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t3", body: "", labels: [], repo: "r", harnessOverride: "does-not-exist" }),
      }),
    );
    expect(unknownHarness.status).toBe(400);

    // A model with no harnessOverride is accepted unvalidated — the
    // harness/tool isn't known until routing runs.
    const modelOnly = await app(
      req("/tasks", {
        method: "POST",
        body: JSON.stringify({ title: "t4", body: "", labels: [], repo: "r", model: "totally-made-up-model" }),
      }),
    );
    expect(modelOnly.status).toBe(201);
    const modelOnlyTask = (await modelOnly.json()) as TaskCard;
    expect(modelOnlyTask.model).toBe("totally-made-up-model");
    expect(modelOnlyTask.harnessOverride).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GET /tasks?status=escalated finds an escalated task — the human queue for a review-pushback lineage that hit its limit", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);

  const other = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "not escalated", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;
  const escalatee = await board.create({ title: "escalated one", body: "", labels: ["code"], repo: "r" });
  await board.escalate(escalatee.id, "Attempt 1: still broken\n\nAttempt 2: still broken");

  const res = await app(req("/tasks?status=escalated"));
  const tasks = (await res.json()) as TaskCard[];
  expect(tasks.map((t) => t.id)).toEqual([escalatee.id]);
  expect(tasks[0]!.escalationContext).toBe("Attempt 1: still broken\n\nAttempt 2: still broken");
  expect(tasks.some((t) => t.id === other.id)).toBe(false);
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

test("POST /tasks/:id/archive returns every card touched by the cascade, 404s on unknown id, and fans out one task.archived event over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
  const child = await board.create({ title: "child", body: "", labels: [], repo: "r", parentTaskId: root.id });

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const res = await app(req(`/tasks/${root.id}/archive`, { method: "POST" }));
  expect(res.status).toBe(200);
  const touched = (await res.json()) as TaskCard[];
  expect(touched.map((t) => t.id).sort()).toEqual([root.id, child.id].sort());
  touched.forEach((t) => expect(t.archivedAt).toBeDefined());

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.archived");
  await reader.cancel();

  const missing = await app(req("/tasks/nope/archive", { method: "POST" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/unarchive returns the single restored card, 404s on unknown id, and fans out task.unarchived over SSE", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const task = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.archive(task.id);

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const res = await app(req(`/tasks/${task.id}/unarchive`, { method: "POST" }));
  expect(res.status).toBe(200);
  const restored = (await res.json()) as TaskCard;
  expect(restored.id).toBe(task.id);
  expect(restored.archivedAt).toBeUndefined();

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.unarchived");
  await reader.cancel();

  const missing = await app(req("/tasks/nope/unarchive", { method: "POST" }));
  expect(missing.status).toBe(404);
});

// Off by default, matching every other opt-in scheduler flag
// (WISSEL_ORCHESTRATOR, WISSEL_MEMORY_CURATION) — createApp must never
// start the auto-archive scheduler unless autoArchiveEnabled is set, even
// with a real done-and-old-enough root sitting on the board.
test("createApp never starts the auto-archive scheduler unless autoArchiveEnabled is set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-archive-off-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    await board.move(root.id, "done");
    const legacyDb = new Database(dbPath);
    legacyDb.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), root.id]);
    legacyDb.close();

    await makeApp(board); // autoArchiveEnabled not set — the scheduler must never start
    await new Promise((r) => setTimeout(r, 100));
    expect((await board.get(root.id))!.archivedAt).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createApp starts the auto-archive scheduler when autoArchiveEnabled is set, and it archives an eligible root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wissel-api-archive-on-test-"));
  try {
    const dbPath = join(dir, "board.sqlite");
    const board = new SqliteBoard(dbPath);
    const root = await board.create({ title: "root", body: "", labels: [], repo: "r" });
    await board.move(root.id, "done");
    const legacyDb = new Database(dbPath);
    legacyDb.run("UPDATE tasks SET doneAt = ? WHERE id = ?", [new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), root.id]);
    legacyDb.close();

    await makeApp(board, { autoArchiveEnabled: true }); // ticks immediately, per startArchiveScheduler's own doc comment

    const deadline = Date.now() + 1000;
    let archivedAt: string | undefined;
    while (Date.now() < deadline) {
      archivedAt = (await board.get(root.id))!.archivedAt;
      if (archivedAt) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(archivedAt).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DELETE /tasks/:id removes the task, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))).json()) as TaskCard;

  const del = await app(req(`/tasks/${created.id}`, { method: "DELETE" }));
  expect(del.status).toBe(204);
  expect((await app(req(`/tasks/${created.id}`))).status).toBe(404);

  const missing = await app(req("/tasks/nope", { method: "DELETE" }));
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

test("POST /route/preview confidently matches real manifest tags without creating a task", async () => {
  const app = await makeApp();
  const res = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["intake"] }) }));
  expect(res.status).toBe(200);
  const decision = (await res.json()) as { selected: string; confident: boolean; candidates: unknown[] };
  expect(decision.confident).toBe(true);
  expect(decision.selected).toBe("triager");
  expect(decision.candidates.length).toBeGreaterThan(1);
});

test("POST /route/preview reports no-match without confident selection, and empty labels the same way", async () => {
  const app = await makeApp();

  const noMatch = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["totally-unknown"] }) }));
  const noMatchDecision = (await noMatch.json()) as { selected: string | null; confident: boolean };
  expect(noMatchDecision.confident).toBe(false);
  expect(noMatchDecision.selected).toBeNull();

  const empty = await app(req("/route/preview", { method: "POST", body: JSON.stringify({ labels: [] }) }));
  const emptyDecision = (await empty.json()) as { selected: string | null; confident: boolean };
  expect(emptyDecision.confident).toBe(false);
  expect(emptyDecision.selected).toBeNull();

  const missing = await app(req("/route/preview", { method: "POST", body: JSON.stringify({}) }));
  expect(missing.status).toBe(200);
});

test("POST /route/preview restricts to a routed parent's declared handoffs", async () => {
  const app = await makeApp();

  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;
  await app(
    req(`/tasks/${parentTask.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        matchedTags: ["intake"], candidates: [], selected: "triager", confident: true,
        reason: "r", strategy: "rule", decidedAt: new Date().toISOString(),
      }),
    }),
  );

  // "ci" matches fixer perfectly, but triager's only declared handoff is planner.
  const res = await app(
    req("/route/preview", { method: "POST", body: JSON.stringify({ labels: ["ci"], parentTaskId: parentTask.id }) }),
  );
  const decision = (await res.json()) as { selected: string | null; confident: boolean; candidates: { agentId: string }[]; reason: string };
  expect(decision.candidates.map((c) => c.agentId)).toEqual(["planner"]);
  expect(decision.confident).toBe(false);
  expect(decision.reason).toContain("restricted to declared handoffs: planner");
});

test("POST /tasks round-trips parentTaskId", async () => {
  const app = await makeApp();
  const parent = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "p", body: "", labels: [], repo: "r" }) }),
  );
  const parentTask = (await parent.json()) as TaskCard;

  const child = await app(
    req("/tasks", { method: "POST", body: JSON.stringify({ title: "c", body: "", labels: [], repo: "r", parentTaskId: parentTask.id }) }),
  );
  const childTask = (await child.json()) as TaskCard;
  expect(childTask.parentTaskId).toBe(parentTask.id);

  const fetched = await app(req(`/tasks/${childTask.id}`));
  expect(((await fetched.json()) as TaskCard).parentTaskId).toBe(parentTask.id);
});

test("POST /tasks/:id/result routes a write-tier report to pending-review (implementer auto-hands-off to reviewer), a readonly one to done", async () => {
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
  // "implementer" declares handoffs: [reviewer] — a plain write-tier
  // agent with no such handoff still lands on "review" directly, see
  // orchestrator.test.ts's "no reviewer handoff" regression test.
  expect((await (await app(req(`/tasks/${writeTask.id}`))).json() as TaskCard).status).toBe("pending-review");

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

test("GET /tasks/:id/result returns the most recent result, 404s with none", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "r" }) }))
  ).json()) as TaskCard;

  const before = await app(req(`/tasks/${created.id}/result`));
  expect(before.status).toBe(404);

  await app(req(`/tasks/${created.id}/result`, { method: "POST", body: JSON.stringify({ agentId: "triager", ok: true, summary: "triaged" }) }));

  const after = await app(req(`/tasks/${created.id}/result`));
  expect(after.status).toBe(200);
  expect(((await after.json()) as TaskResult).summary).toBe("triaged");
});

test("GET /tasks/:id/diff reports isGitRepo: false for a task whose repo isn't a git working tree, 404s on unknown id", async () => {
  const app = await makeApp();
  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: [], repo: "/tmp" }) }))
  ).json()) as TaskCard;

  const res = await app(req(`/tasks/${created.id}/diff`));
  expect(res.status).toBe(200);
  const diff = (await res.json()) as { isGitRepo: boolean };
  expect(diff.isGitRepo).toBe(false);

  const missing = await app(req("/tasks/nope/diff"));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/run routes and runs a task on the injected manual executor, 404s on unknown id", async () => {
  const seen: TaskCard[] = [];
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        seen.push(task);
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "opened a PR" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const run = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(run.status).toBe(202);

  // /run returns once the task is in flight, not once it's done — poll
  // for the background process() to land, same as the real board UI would.
  const deadline = Date.now() + 1000;
  let status: TaskCard["status"] = "inbox";
  while (Date.now() < deadline) {
    status = ((await (await app(req(`/tasks/${created.id}`))).json()) as TaskCard).status;
    if (status !== "inbox" && status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // "implementer" (routed via the "code" label) declares handoffs:
  // [reviewer], so a successful run lands on pending-review with an
  // auto-created reviewer task, not a bare review.
  expect(status).toBe("pending-review");
  expect(seen.map((t) => t.id)).toEqual([created.id]);

  const missing = await app(req("/tasks/nope/run", { method: "POST" }));
  expect(missing.status).toBe(404);
});

test("POST /tasks/:id/escalation/approve forces an escalated task to review, recording an audited override; 400 when not escalated", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.escalate(escalated.id, "Attempt 1: still broken\n\nAttempt 2: still broken");

  const sse = await app(req("/events"));
  const reader = sse.body!.getReader();
  await reader.read(); // ": connected" preamble

  const missingFields = await app(req(`/tasks/${escalated.id}/escalation/approve`, { method: "POST", body: JSON.stringify({}) }));
  expect(missingFields.status).toBe(400);

  const res = await app(
    req(`/tasks/${escalated.id}/escalation/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "milton", reason: "read the diff myself, it's fine" }),
    }),
  );
  expect(res.status).toBe(200);
  const task = (await res.json()) as TaskCard;
  expect(task.status).toBe("review");
  expect((await (await app(req(`/tasks/${escalated.id}`))).json() as TaskCard).status).toBe("review");

  const decoder = new TextDecoder();
  const chunk = decoder.decode((await reader.read()).value);
  expect(chunk).toContain("task.override");
  expect(chunk).toContain("milton");
  expect(chunk).toContain("read the diff myself, it's fine");
  await reader.cancel();

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(
    req(`/tasks/${notEscalated.id}/escalation/approve`, {
      method: "POST",
      body: JSON.stringify({ actor: "milton", reason: "irrelevant" }),
    }),
  );
  expect(rejected.status).toBe(400);
  expect((await (await app(req(`/tasks/${notEscalated.id}`))).json() as TaskCard).status).toBe("inbox");

  const missingId = await app(
    req("/tasks/nope/escalation/approve", { method: "POST", body: JSON.stringify({ actor: "milton", reason: "x" }) }),
  );
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/escalation/abandon marks an escalated task failed; 400 when not escalated", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "", labels: [], repo: "r" });
  await board.escalate(escalated.id, "Attempt 1: still broken");

  const res = await app(req(`/tasks/${escalated.id}/escalation/abandon`, { method: "POST" }));
  expect(res.status).toBe(200);
  expect(((await res.json()) as TaskCard).status).toBe("failed");
  expect((await (await app(req(`/tasks/${escalated.id}`))).json() as TaskCard).status).toBe("failed");

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(req(`/tasks/${notEscalated.id}/escalation/abandon`, { method: "POST" }));
  expect(rejected.status).toBe(400);

  const missingId = await app(req("/tasks/nope/escalation/abandon", { method: "POST" }));
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/escalation/retry spawns a fresh pushback task with pushbackCount reset and a new reviewLineageId; 400 when not escalated or body missing", async () => {
  const board = new SqliteBoard();
  const app = await makeApp(board);
  const escalated = await board.create({ title: "t", body: "original body", labels: ["code"], repo: "r", pushbackCount: 5, reviewLineageId: "exhausted-lineage" });
  await board.escalate(escalated.id, "Attempt 1..6: same objection every time");

  const noBody = await app(req(`/tasks/${escalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({}) }));
  expect(noBody.status).toBe(400);

  const res = await app(
    req(`/tasks/${escalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({ body: "human-edited instructions" }) }),
  );
  expect(res.status).toBe(201);
  const nextAttempt = (await res.json()) as TaskCard;
  expect(nextAttempt.title).toBe("t");
  expect(nextAttempt.body).toBe("human-edited instructions");
  expect(nextAttempt.labels).toEqual(["code"]);
  expect(nextAttempt.repo).toBe("r");
  expect(nextAttempt.pushbackCount).toBe(0);
  expect(nextAttempt.status).toBe("inbox");
  expect(nextAttempt.reviewLineageId).toBeDefined();
  expect(nextAttempt.reviewLineageId).not.toBe("exhausted-lineage");

  // The old escalated card is superseded, not resurrected — mirrors
  // TaskCard.supersededBy's contract for a pushback re-attempt.
  const oldCard = (await (await app(req(`/tasks/${escalated.id}`))).json()) as TaskCard;
  expect(oldCard.status).toBe("escalated");
  expect(oldCard.supersededBy).toBe(nextAttempt.id);

  const notEscalated = await board.create({ title: "not escalated", body: "", labels: [], repo: "r" });
  const rejected = await app(
    req(`/tasks/${notEscalated.id}/escalation/retry`, { method: "POST", body: JSON.stringify({ body: "x" }) }),
  );
  expect(rejected.status).toBe(400);

  const missingId = await app(
    req("/tasks/nope/escalation/retry", { method: "POST", body: JSON.stringify({ body: "x" }) }),
  );
  expect(missingId.status).toBe(404);
});

test("POST /tasks/:id/run 409s when a run for that task is already in flight", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const app = await makeApp(new SqliteBoard(), {
    manualExecutors: [
      fakeWriteExecutor(async (task, agent) => {
        await blocked;
        return { taskId: task.id, agentId: agent.id, ok: true, summary: "ok" };
      }),
    ],
  });

  const created = (await (
    await app(req("/tasks", { method: "POST", body: JSON.stringify({ title: "t", body: "", labels: ["code"], repo: "r" }) }))
  ).json()) as TaskCard;

  const first = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(first.status).toBe(202);

  const second = await app(req(`/tasks/${created.id}/run`, { method: "POST" }));
  expect(second.status).toBe(409);
  release();
});
